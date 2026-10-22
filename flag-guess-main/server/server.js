const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/ping', (req, res) => res.send('pong'));

const onlineUsers = {}; // socket.id -> { id, name }
const rooms = {};       // roomCode -> room object

function broadcastOnlineUsers() {
  const users = Object.values(onlineUsers);
  io.emit('onlineUsers', { users });
}

io.on('connection', (socket) => {
  let myRoom = null;
  let mySlot = null;

  // 1. LOBBY & USERNAME REGISTRATIE
  socket.on('registerUsername', ({ username }) => {
    const clean = (username || '').trim();
    if (!clean) {
      socket.emit('usernameError', { message: 'Ongeldige naam' });
      return;
    }
    const taken = Object.values(onlineUsers).some(
      (u) => u.name.toLowerCase() === clean.toLowerCase() && u.id !== socket.id
    );
    if (taken) {
      socket.emit('usernameError', { message: 'Deze naam is al in gebruik!' });
      return;
    }
    onlineUsers[socket.id] = { id: socket.id, name: clean };
    socket.emit('usernameOk', { username: clean });
    broadcastOnlineUsers();
  });

  // 2. UITNODIGINGEN VERSTUREN & BEANTWOORDEN
  socket.on('sendInvite', ({ toUsername }) => {
    const sender = onlineUsers[socket.id];
    if (!sender) return;
    const target = Object.values(onlineUsers).find((u) => u.name === toUsername);
    if (!target) {
      socket.emit('inviteError', { message: 'Speler is niet meer online.' });
      return;
    }
    io.to(target.id).emit('incomingInvite', {
      fromUsername: sender.name,
      fromId: socket.id,
    });
  });

  socket.on('respondInvite', ({ accept, fromId }) => {
    const responder = onlineUsers[socket.id];
    const inviter = onlineUsers[fromId];
    if (!inviter || !responder) {
      socket.emit('inviteError', { message: 'Uitnodiging is verlopen.' });
      return;
    }
    if (!accept) {
      io.to(fromId).emit('inviteDeclined', { byUsername: responder.name });
      return;
    }

    const roomCode = 'ROOM-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    const inviterSocket = io.sockets.sockets.get(fromId);
    if (!inviterSocket) {
      socket.emit('inviteError', { message: 'Tegenstander heeft de verbinding verbroken.' });
      return;
    }

    rooms[roomCode] = {
      code: roomCode,
      boardSize: 12,
      players: [
        { socket: inviterSocket, id: fromId, name: inviter.name, slot: 1, secretFlag: null, ready: false },
        { socket: socket, id: socket.id, name: responder.name, slot: 2, secretFlag: null, ready: false },
      ],
      currentPlayer: 1,
      history: [],
      rollback: null,
      phase: 'sizing',
    };

    inviterSocket.join(roomCode);
    socket.join(roomCode);

    inviterSocket.emit('matchFound', { roomCode, slot: 1, opponentName: responder.name });
    socket.emit('matchFound', { roomCode, slot: 2, opponentName: inviter.name });
  });

  // 3. BORDGROOTTE KIEZEN (ALLEEN DOOR SPELER 1)
  socket.on('selectBoardSize', ({ size, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    room.boardSize = Number(size) === 24 ? 24 : 12;
    room.phase = 'selecting';
    io.to(code).emit('boardSizeAgreed', { size: room.boardSize });
  });

  // 4. GEHEIME VLAG BEVESTIGEN & GAME STARTEN
  socket.on('confirmFlag', ({ flagId, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    myRoom = code;
    mySlot = player.slot;
    player.secretFlag = flagId;
    player.ready = true;

    const allReady = room.players.length === 2 && room.players.every((p) => p.ready);
    if (allReady) {
      room.phase = 'playing';
      room.currentPlayer = 1;
      io.to(code).emit('startGame', { startingPlayer: 1 });
    }
  });

  // 5. VRAGEN, ANTWOORDEN & GOKKEN
  socket.on('askQuestion', ({ text, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    const me = room.players.find((p) => p.id === socket.id);
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (!opponent || !me) return;

    room.history.push({ type: 'question', from: me.name, text, answer: undefined });
    opponent.socket.emit('incomingQuestion', { from: me.name, text });
  });

  socket.on('answerQuestion', ({ answer, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    const questioner = room.players.find((p) => p.id !== socket.id);
    if (!questioner) return;

    const qEntry = [...room.history].reverse().find((h) => h.type === 'question' && h.answer === undefined);
    if (qEntry) qEntry.answer = answer;

    questioner.socket.emit('questionAnswered', { answer });
  });

  socket.on('makeGuess', ({ flagId, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (!opponent) return;

    opponent.socket.emit('opponentGuess', { flagId, flagName: flagId });
  });

  socket.on('guessResult', ({ correct, flagId, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    const guesser = room.players.find((p) => p.id !== socket.id);
    if (!guesser) return;

    room.history.push({ type: 'guess', from: guesser.slot, flagId, correct });
    guesser.socket.emit('guessResult', { correct, flagId });
  });

  // 6. ROLLBACK / ANTWOORD CORRECTIE DOORSTUREN
  socket.on('rollbackRequest', ({ reason, from, snapshot, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) opponent.socket.emit('rollbackRequest', { reason, from, snapshot });
  });

  socket.on('rollbackDecision', ({ accepted, roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit('rollbackDecision', { accepted });
  });

  // 7. REMATCH & VERBINDING HERSTELLEN
  socket.on('playAgainRequest', ({ roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    room.players.forEach((p) => {
      p.secretFlag = null;
      p.ready = false;
    });
    room.history = [];
    room.phase = 'selecting';
    io.to(code).emit('rematchStarted');
  });

  socket.on('rejoinRoom', ({ username, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('rejoinFailed');
      return;
    }
    const player = room.players.find((p) => p.name === username);
    if (!player) {
      socket.emit('rejoinFailed');
      return;
    }
    player.id = socket.id;
    player.socket = socket;
    myRoom = roomCode;
    mySlot = player.slot;
    onlineUsers[socket.id] = { id: socket.id, name: username };
    socket.join(roomCode);
    socket.emit('rejoinSuccess');
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) opponent.socket.emit('opponentReconnected');
  });

  socket.on('leaveRoom', ({ roomCode }) => {
    const code = roomCode || myRoom;
    const room = rooms[code];
    if (!room) return;
    const opponent = room.players.find((p) => p.id !== socket.id);
    if (opponent) opponent.socket.emit('opponentLeftLobby');
    delete rooms[code];
  });

  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    broadcastOnlineUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Flag Guess Who server running on port ${PORT}`));
