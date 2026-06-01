const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] },
});

const onlineUsers = new Map();
const gameRooms = new Map();

function broadcastOnlineUsers() {
  const users = Array.from(onlineUsers.values()).filter(u => u.available).map(u => ({ id: u.id, name: u.name }));
  io.emit('onlineUsers', { users });
}

// Session healer: if socket lost its room, put it back based on client's roomCode
function getRoom(socket, clientRoomCode) {
  const code = clientRoomCode || socket.data.roomCode;
  if (code && socket.data.roomCode !== code) {
    socket.join(code);
    socket.data.roomCode = code;
  }
  return { code, room: gameRooms.get(code) };
}

app.use(cors());
app.get('/', (_, res) => res.json({ status: 'ok', online: onlineUsers.size, activeGames: gameRooms.size }));
app.get('/ping', (_, res) => res.send('pong'));

io.on('connection', (socket) => {

  socket.on('registerUsername', ({ username }) => {
    socket.data.username = username;
    onlineUsers.set(socket.id, { id: socket.id, name: username, available: true });
    socket.emit('usernameOk', { username });
    broadcastOnlineUsers();
  });

  socket.on('sendInvite', ({ toUsername }) => {
    const target = Array.from(onlineUsers.values()).find(u => u.name === toUsername && u.available);
    if (!target) return socket.emit('inviteError', { message: 'Player is offline or in a game.' });
    io.to(target.id).emit('incomingInvite', { fromUsername: socket.data.username, fromId: socket.id });
  });

  socket.on('respondInvite', ({ accept, fromId }) => {
    if (!accept) {
      io.to(fromId).emit('inviteDeclined', { byUsername: socket.data.username });
      return;
    }
    
    const p1 = onlineUsers.get(fromId);
    const p2 = onlineUsers.get(socket.id);
    if (!p1 || !p2 || !p1.available || !p2.available) return socket.emit('inviteError', { message: 'Invite no longer valid.' });

    p1.available = false; p2.available = false;
    broadcastOnlineUsers();

    const roomCode = 'MATCH_' + Date.now();
    const p1Socket = io.sockets.sockets.get(p1.id);
    const p2Socket = socket;

    p1Socket.join(roomCode);
    p2Socket.join(roomCode);
    p1Socket.data.roomCode = roomCode;
    p2Socket.data.roomCode = roomCode;

    gameRooms.set(roomCode, {
      code: roomCode,
      players: [
        { id: p1.id, name: p1.name, slot: 1, secretFlag: null, ready: false },
        { id: p2.id, name: p2.name, slot: 2, secretFlag: null, ready: false },
      ],
      currentPlayer: 1,
      history: []
    });

    p1Socket.emit('matchFound', { roomCode, slot: 1, opponentName: p2.name });
    p2Socket.emit('matchFound', { roomCode, slot: 2, opponentName: p1.name });
  });

  socket.on('selectBoardSize', ({ size, roomCode }) => {
     const { code } = getRoom(socket, roomCode);
     if(code) io.to(code).emit('boardSizeAgreed', { size });
  });

  socket.on('confirmFlag', ({ flagId, roomCode }) => {
    const { code, room } = getRoom(socket, roomCode);
    if (!room) return;
    const player = room.players.find(p => p.slot === 1 ? (p.name === socket.data.username) : true); // Fallback lookup
    const targetPlayer = room.players.find(p => p.id === socket.id) || room.players.find(p => !p.ready);
    if (!targetPlayer) return;
    
    targetPlayer.secretFlag = flagId;
    targetPlayer.ready = true;
    if (room.players.every(p => p.ready)) {
      io.to(code).emit('startGame', { startingPlayer: 1 });
    }
  });

  socket.on('askQuestion', ({ text, roomCode }) => {
    const { code, room } = getRoom(socket, roomCode);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id) || room.players[room.currentPlayer === 1 ? 0 : 1];
    const opponent = room.players.find(p => p.id !== me.id);
    room.history.push({ type: 'question', from: me.slot, text, answer: undefined });
    io.to(opponent.id).emit('incomingQuestion', { from: me.name, text });
  });

  socket.on('answerQuestion', ({ answer, roomCode }) => {
    const { room } = getRoom(socket, roomCode);
    if (!room) return;
    const questioner = room.players[room.currentPlayer === 1 ? 0 : 1];
    const q = [...room.history].reverse().find(h => h.type === 'question' && h.answer === undefined);
    if (q) q.answer = answer;
    
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
    io.to(questioner.id).emit('questionAnswered', { answer });
  });

  socket.on('makeGuess', ({ flagId, roomCode }) => {
    const { room } = getRoom(socket, roomCode);
    if (!room) return;
    const opponent = room.players.find(p => p.id !== socket.id) || room.players[room.currentPlayer === 1 ? 1 : 0];
    io.to(opponent.id).emit('opponentGuess', { flagId, flagName: flagId });
  });

  socket.on('guessResult', ({ correct, flagId, roomCode }) => {
    const { code, room } = getRoom(socket, roomCode);
    if (!room) return;
    const guesser = room.players[room.currentPlayer === 1 ? 0 : 1];
    room.history.push({ type: 'guess', from: guesser.slot, flagId, correct });
    io.to(guesser.id).emit('guessResult', { correct, flagId });
    if (!correct) room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
  });

  socket.on('rollbackRequest', ({ reason, from, snapshot, roomCode }) => {
    const { code, room } = getRoom(socket, roomCode);
    const opponent = room?.players.find(p => p.slot !== from);
    if (opponent) io.to(opponent.id).emit('rollbackRequest', { reason, from, snapshot });
  });

  socket.on('rollbackDecision', ({ accepted, roomCode }) => {
    const { code, room } = getRoom(socket, roomCode);
    const meSlot = room?.currentPlayer === 1 ? 2 : 1;
    const requester = room?.players.find(p => p.slot !== meSlot);
    if (requester) io.to(requester.id).emit('rollbackDecision', { accepted });
    socket.emit('rollbackDecision', { accepted });
  });

  socket.on('disconnect', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers();
    }
    const code = socket.data.roomCode;
    if (code) {
      socket.to(code).emit('opponentDisconnected');
      setTimeout(() => gameRooms.delete(code), 30000);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
