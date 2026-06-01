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

const onlineUsers = new Map(); // socket.id -> { id, name, available }
const gameRooms = new Map();

function broadcastOnlineUsers() {
  const users = Array.from(onlineUsers.values()).filter(u => u.available).map(u => ({ id: u.id, name: u.name }));
  io.emit('onlineUsers', { users });
}

app.use(cors());
app.get('/', (_, res) => res.json({ status: 'ok', online: onlineUsers.size, activeGames: gameRooms.size }));
app.get('/ping', (_, res) => res.send('pong'));

io.on('connection', (socket) => {

  // 1. Username registratie
  socket.on('registerUsername', ({ username }) => {
    socket.data.username = username;
    onlineUsers.set(socket.id, { id: socket.id, name: username, available: true });
    socket.emit('usernameOk', { username });
    broadcastOnlineUsers();
  });

  // 2. Invites versturen en ontvangen (GEEN ROOMS MEER)
  socket.on('sendInvite', ({ toUsername }) => {
    const target = Array.from(onlineUsers.values()).find(u => u.name === toUsername && u.available);
    if (!target) return socket.emit('inviteError', { message: 'Speler is offline of zit al in een game.' });
    io.to(target.id).emit('incomingInvite', { fromUsername: socket.data.username, fromId: socket.id });
  });

  socket.on('respondInvite', ({ accept, fromId }) => {
    if (!accept) {
      io.to(fromId).emit('inviteDeclined', { byUsername: socket.data.username });
      return;
    }
    
    const p1 = onlineUsers.get(fromId);
    const p2 = onlineUsers.get(socket.id);
    if (!p1 || !p2 || !p1.available || !p2.available) return socket.emit('inviteError', { message: 'Uitnodiging niet meer geldig.' });

    // Haal ze uit de publieke lobby lijst (zodat niemand ze meer kan inviten)
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

    // Stuur match info naar beide (zonder leak van elkaars data)
    p1Socket.emit('matchFound', { roomCode, slot: 1, opponentName: p2.name });
    p2Socket.emit('matchFound', { roomCode, slot: 2, opponentName: p1.name });
  });

  // 3. Board size sync
  socket.on('selectBoardSize', ({ size }) => {
     const code = socket.data.roomCode;
     if(code) io.to(code).emit('boardSizeAgreed', { size });
  });

  socket.on('confirmFlag', ({ flagId }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.secretFlag = flagId;
    player.ready = true;
    if (room.players.every(p => p.ready)) {
      io.to(code).emit('startGame', { startingPlayer: 1 });
    }
  });

  // 4. Game logica
  socket.on('askQuestion', ({ text }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    const opponent = room.players.find(p => p.id !== socket.id);
    room.history.push({ type: 'question', from: me.slot, text, answer: undefined });
    io.to(opponent.id).emit('incomingQuestion', { from: me.name, text });
  });

  socket.on('answerQuestion', ({ answer }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const questioner = room.players.find(p => p.id !== socket.id);
    const q = [...room.history].reverse().find(h => h.type === 'question' && h.answer === undefined);
    if (q) q.answer = answer;
    
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
    io.to(questioner.id).emit('questionAnswered', { answer });
  });

  socket.on('makeGuess', ({ flagId }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const opponent = room.players.find(p => p.id !== socket.id);
    io.to(opponent.id).emit('opponentGuess', { flagId, flagName: flagId });
  });

  socket.on('guessResult', ({ correct, flagId }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const guesser = room.players.find(p => p.id !== socket.id);
    room.history.push({ type: 'guess', from: guesser.slot, flagId, correct });
    io.to(guesser.id).emit('guessResult', { correct, flagId });
    if (!correct) room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
  });

  // 5. Rollbacks
  socket.on('rollbackRequest', ({ reason, from, snapshot }) => {
    const code = socket.data.roomCode;
    const opponent = gameRooms.get(code)?.players.find(p => p.id !== socket.id);
    if (opponent) io.to(opponent.id).emit('rollbackRequest', { reason, from, snapshot });
  });

  socket.on('rollbackDecision', ({ accepted }) => {
    const code = socket.data.roomCode;
    const requester = gameRooms.get(code)?.players.find(p => p.id !== socket.id);
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
