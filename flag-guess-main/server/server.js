const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Set FRONTEND_URL on Render to your Vercel domain, e.g. https://flag-guess.vercel.app
// If not set, all origins are allowed (fine for dev / single-host deploy)
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || '*';

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

// ── AANGEPASTE REGELS ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/ping', (req, res) => res.send('pong'));
// ──────────────────────────────────────────────────────────────────────────────

// rooms[roomCode] = { players: [{socket, name, slot, secretFlag, ready}], boardSize, currentPlayer, history, rollback }
const rooms = {};

function getRoom(code) { return rooms[code]; }
function saveSnapshot(room) {
  return {
    history: JSON.parse(JSON.stringify(room.history)),
    p1SecretFlag: room.players[0]?.secretFlag,
    p2SecretFlag: room.players[1]?.secretFlag,
  };
}

io.on('connection', (socket) => {
  let myRoom = null;
  let mySlot = null;

  socket.on('joinRoom', ({ roomCode, playerName, boardSize }) => {
    const code = roomCode.toUpperCase();

    if (!rooms[code]) {
      rooms[code] = {
        code,
        boardSize,
        players: [],
        currentPlayer: 1,
        history: [],
        rollback: null,
        phase: 'selecting',
      };
    }

    const room = rooms[code];

    if (room.players.length >= 2) {
      socket.emit('error', 'Room is full');
      return;
    }

    myRoom = code;
    mySlot = room.players.length + 1;

    room.players.push({ socket, id: socket.id, name: playerName, slot: mySlot, secretFlag: null, ready: false });
    socket.join(code);

    const opponentName = room.players.find(p => p.slot !== mySlot)?.name || null;
    socket.emit('assignSlot', { slot: mySlot, opponent: opponentName });

    if (room.players.length === 1) {
      socket.emit('waitingForOpponent');
    } else {
      const p1 = room.players.find(p => p.slot === 1);
      const p2 = room.players.find(p => p.slot === 2);
      p1.socket.emit('assignSlot', { slot: 1, opponent: p2.name });
      p2.socket.emit('assignSlot', { slot: 2, opponent: p1.name });
      io.to(code).emit('opponentReady');
    }
  });

  socket.on('confirmFlag', ({ flagId }) => {
    const room = getRoom(myRoom);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.secretFlag = flagId;
    player.ready = true;

    const allReady = room.players.length === 2 && room.players.every(p => p.ready);
    if (allReady) {
      room.phase = 'playing';
      room.currentPlayer = 1;
      io.to(myRoom).emit('startGame', { startingPlayer: 1 });
    }
  });

  socket.on('askQuestion', ({ text }) => {
    const room = getRoom(myRoom);
    if (!room) return;
    const opponent = room.players.find(p => p.id !== socket.id);
    if (!opponent) return;
    room.history.push({ type: 'question', from: mySlot, text, answer: undefined });
    opponent.socket.emit('incomingQuestion', { from: `Player ${mySlot}`, text });
  });

  socket.on('answerQuestion', ({ answer }) => {
    const room = getRoom(myRoom);
    if (!room) return;
    const questioner = room.players.find(p => p.id !== socket.id);
    if (!questioner) return;
    const qEntry = [...room.history].reverse().find(h => h.type === 'question' && h.answer === undefined);
    if (qEntry) qEntry.answer = answer;
    questioner.socket.emit('questionAnswered', { answer });
    socket.emit('yourTurnToAsk');
  });

  socket.on('makeGuess', ({ flagId }) => {
    const room = getRoom(myRoom);
    if (!room) return;
    const opponent = room.players.find(p => p.id !== socket.id);
    if (!opponent) return;
    opponent.socket.emit('opponentGuess', { flagId, flagName: flagId });
  });

  socket.on('guessResult', ({ correct, flagId }) => {
    const room = getRoom(myRoom);
    if (!room) return;
    const guesser = room.players.find(p => p.id !== socket.id);
    if (!guesser) return;
    room.history.push({ type: 'guess', from: guesser.slot, flagId, correct });
    guesser.socket.emit('guessResult', { correct, flagId });
  });

  socket.on('endTurn', () => {
    const room = getRoom(myRoom);
    if (!room) return;
    room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
    io.to(myRoom).emit('turnChanged', { currentPlayer: room.currentPlayer });
  });

  socket.on('rollbackRequest', ({ reason, from }) => {
    const room = getRoom(myRoom);
    if (!room) return;
    room.rollback = { requestedBy: from, reason, snapshot: saveSnapshot(room) };
    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent) opponent.socket.emit('rollbackRequest', { reason, from });
  });

  socket.on('rollbackDecision', ({ accepted }) => {
    const room = getRoom(myRoom);
    if (!room) return;
    if (accepted && room.rollback) {
      room.history = room.rollback.snapshot.history;
    }
    room.rollback = null;
    const requester = room.players.find(p => p.id !== socket.id);
    if (requester) requester.socket.emit('rollbackDecision', { accepted });
    socket.emit('rollbackDecision', { accepted });
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const room = getRoom(myRoom);
    if (!room) return;
    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent) opponent.socket.emit('opponentDisconnected');
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) delete rooms[myRoom];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Flag Guess Who server running on port ${PORT}`));
