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

// ── Fixed lobby rooms 1, 2, 3 ────────────────────────────────────────────────
const lobbyRooms = {
  1: { players: [], gameStarted: false },
  2: { players: [], gameStarted: false },
  3: { players: [], gameStarted: false },
};

const gameRooms = new Map();

function getRoomStatus() {
  return Object.entries(lobbyRooms).map(([num, r]) => ({
    roomNumber: Number(num),
    count: r.players.length,
  }));
}

function broadcastRoomStatus() {
  io.emit('roomStatus', { rooms: getRoomStatus() });
}

app.use(cors());
app.get('/',     (_, res) => res.json({ status: 'ok', rooms: getRoomStatus() }));
app.get('/ping', (_, res) => res.send('pong'));

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('getRoomStatus', () => {
    socket.emit('roomStatus', { rooms: getRoomStatus() });
  });

  socket.on('joinLobbyRoom', ({ roomNumber, playerName }) => {
    const room = lobbyRooms[roomNumber];
    if (!room) return socket.emit('joinError', { message: 'Room not found.' });
    if (room.players.length >= 2) return socket.emit('joinError', { message: 'Room is full, pick another!' });

    const slot = room.players.length + 1;
    room.players.push({ id: socket.id, name: playerName, slot });
    socket.data.roomNumber = roomNumber;
    socket.data.playerName = playerName;
    socket.data.slot = slot;

    const roomCode = 'ROOM' + roomNumber;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    broadcastRoomStatus();

    if (room.players.length === 1) {
      socket.emit('waitingForOpponent');
      console.log(`${playerName} waiting in Room ${roomNumber}`);
    } else {
      const p1 = room.players[0];
      const p2 = room.players[1];

      gameRooms.set(roomCode, {
        code: roomCode,
        players: [
          { id: p1.id, name: p1.name, slot: 1, secretFlag: null, ready: false },
          { id: p2.id, name: p2.name, slot: 2, secretFlag: null, ready: false },
        ],
        currentPlayer: 1,
        history: [],
      });

      io.to(p1.id).emit('matchFound', { roomCode, slot: 1, opponentName: p2.name });
      io.to(p2.id).emit('matchFound', { roomCode, slot: 2, opponentName: p1.name });
      console.log(`Room ${roomNumber}: ${p1.name} vs ${p2.name} — game on!`);
    }
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

  socket.on('askQuestion', ({ text }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    const opponent = room.players.find(p => p.id !== socket.id);
    if (!opponent) return;
    room.history.push({ type: 'question', from: me?.slot, text, answer: undefined });
    io.to(opponent.id).emit('incomingQuestion', { from: `Player ${me?.slot}`, text });
  });

  socket.on('answerQuestion', ({ answer }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const questioner = room.players.find(p => p.id !== socket.id);
    if (!questioner) return;
    const q = [...room.history].reverse().find(h => h.type === 'question' && h.answer === undefined);
    if (q) q.answer = answer;
    io.to(questioner.id).emit('questionAnswered', { answer });
    socket.emit('yourTurnToAsk');
  });

  socket.on('makeGuess', ({ flagId }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const opponent = room.players.find(p => p.id !== socket.id);
    if (!opponent) return;
    io.to(opponent.id).emit('opponentGuess', { flagId, flagName: flagId });
  });

  socket.on('guessResult', ({ correct, flagId }) => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    const guesser = room.players.find(p => p.id !== socket.id);
    if (!guesser) return;
    room.history.push({ type: 'guess', from: guesser.slot, flagId, correct });
    io.to(guesser.id).emit('guessResult', { correct, flagId });
  });

  socket.on('endTurn', () => {
    const code = socket.data.roomCode;
    const room = gameRooms.get(code);
    if (!room) return;
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
    io.to(code).emit('turnChanged', { currentPlayer: room.currentPlayer });
  });

  socket.on('rollbackRequest', ({ reason, from }) => {
    const code = socket.data.roomCode;
    const opponent = gameRooms.get(code)?.players.find(p => p.id !== socket.id);
    if (opponent) io.to(opponent.id).emit('rollbackRequest', { reason, from });
  });

  socket.on('rollbackDecision', ({ accepted }) => {
    const code = socket.data.roomCode;
    const requester = gameRooms.get(code)?.players.find(p => p.id !== socket.id);
    if (requester) io.to(requester.id).emit('rollbackDecision', { accepted });
    socket.emit('rollbackDecision', { accepted });
  });

  socket.on('disconnect', () => {
    const roomNumber = socket.data.roomNumber;
    const code = socket.data.roomCode;

    if (roomNumber && lobbyRooms[roomNumber]) {
      lobbyRooms[roomNumber].players = lobbyRooms[roomNumber].players.filter(p => p.id !== socket.id);
      broadcastRoomStatus();
    }

    if (code) {
      socket.to(code).emit('opponentDisconnected');
      setTimeout(() => {
              const gr = gameRooms.get(code);
              if (gr && gr.players.every(p => !io.sockets.sockets.has(p.id))) {
                gameRooms.delete(code);
              }
            }, 30_000);
    }

    console.log(`${socket.data.playerName || socket.id} disconnected`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Flag Guess Who server on port ${PORT}`));
