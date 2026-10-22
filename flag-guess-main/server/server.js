const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// server/ staat in een submap, dus public/ ligt één map hoger
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/status', (req, res) => res.json({ status: 'ok', online: io.engine.clientsCount }));

const users = new Map();      // socketId -> { id, name }
const rooms = new Map();      // roomCode -> room
const playerRoom = new Map(); // socketId -> roomCode

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const makeCode = () => 'ROOM-' + Math.random().toString(36).slice(2, 7).toUpperCase();

function broadcastUsers() {
  io.emit('onlineUsers', {
    users: [...users.values()].map((u) => ({ id: u.id, name: u.name, busy: playerRoom.has(u.id) })),
  });
}

function leaveRoom(socketId) {
  const code = playerRoom.get(socketId);
  if (!code) return;
  const room = rooms.get(code);
  rooms.delete(code);
  room.players.forEach((p) => {
    playerRoom.delete(p.id);
    io.sockets.sockets.get(p.id)?.leave(code);
    if (p.id !== socketId) io.to(p.id).emit('opponentLeft');
  });
  broadcastUsers();
}

io.on('connection', (socket) => {
  const roomOf = () => rooms.get(playerRoom.get(socket.id));
  const meIn = (r) => r.players.find((p) => p.id === socket.id);
  const oppIn = (r) => r.players.find((p) => p.id !== socket.id);

  socket.on('registerUsername', ({ username } = {}) => {
    const name = clean(username, 20);
    if (!name) return socket.emit('usernameError', { message: 'Vul een naam in.' });
    const taken = [...users.values()].some((u) => u.id !== socket.id && u.name.toLowerCase() === name.toLowerCase());
    if (taken) return socket.emit('usernameError', { message: 'Deze naam is al in gebruik!' });
    users.set(socket.id, { id: socket.id, name });
    socket.emit('usernameOk', { username: name });
    broadcastUsers();
  });

  socket.on('sendInvite', ({ toId } = {}) => {
    const me = users.get(socket.id);
    const target = users.get(toId);
    if (!me) return;
    if (!target || target.id === me.id) return socket.emit('inviteError', { message: 'Speler is niet meer online.' });
    if (playerRoom.has(me.id) || playerRoom.has(target.id)) {
      return socket.emit('inviteError', { message: 'Speler zit al in een spel.' });
    }
    io.to(target.id).emit('incomingInvite', { fromId: me.id, fromUsername: me.name });
  });

  socket.on('respondInvite', ({ accept, fromId } = {}) => {
    const me = users.get(socket.id);
    const inviter = users.get(fromId);
    const inviterSocket = io.sockets.sockets.get(fromId);
    if (!me || !inviter || !inviterSocket) return socket.emit('inviteError', { message: 'Uitnodiging is verlopen.' });
    if (!accept) return inviterSocket.emit('inviteDeclined', { byUsername: me.name });
    if (playerRoom.has(me.id) || playerRoom.has(inviter.id)) {
      return socket.emit('inviteError', { message: 'Speler zit al in een spel.' });
    }

    const code = makeCode();
    rooms.set(code, {
      code, phase: 'sizing', boardSize: 12, round: 1,
      currentSlot: 1, pending: null, seq: 0, rematchVotes: new Set(),
      players: [
        { id: inviter.id, name: inviter.name, slot: 1, secret: null, ready: false },
        { id: me.id, name: me.name, slot: 2, secret: null, ready: false },
      ],
    });
    playerRoom.set(inviter.id, code);
    playerRoom.set(me.id, code);
    inviterSocket.join(code);
    socket.join(code);
    inviterSocket.emit('matchFound', { roomCode: code, slot: 1, opponentName: me.name });
    socket.emit('matchFound', { roomCode: code, slot: 2, opponentName: inviter.name });
    broadcastUsers();
  });

  socket.on('selectBoardSize', ({ size } = {}) => {
    const r = roomOf();
    const p = r && meIn(r);
    if (!r || !p || p.slot !== 1 || r.phase !== 'sizing') return;
    r.boardSize = Number(size) === 24 ? 24 : 12;
    r.phase = 'selecting';
    io.to(r.code).emit('boardSizeAgreed', { size: r.boardSize, round: r.round });
  });

  socket.on('confirmFlag', ({ flagId } = {}) => {
    const r = roomOf();
    const p = r && meIn(r);
    if (!r || !p || r.phase !== 'selecting' || p.ready || typeof flagId !== 'string') return;
    p.secret = flagId;
    p.ready = true;
    if (r.players.every((x) => x.ready)) {
      r.phase = 'playing';
      r.currentSlot = 1;
      io.to(r.code).emit('startGame', { currentSlot: 1 });
    }
  });

  socket.on('askQuestion', ({ text } = {}) => {
    const r = roomOf();
    const p = r && meIn(r);
    const q = clean(text, 200);
    if (!r || !p || r.phase !== 'playing' || r.pending || !q || p.slot !== r.currentSlot) return;
    r.pending = { id: ++r.seq, askerSlot: p.slot };
    io.to(r.code).emit('questionAsked', { id: r.pending.id, askerSlot: p.slot, from: p.name, text: q });
  });

  socket.on('answerQuestion', ({ answer } = {}) => {
    const r = roomOf();
    const p = r && meIn(r);
    if (!r || !p || !r.pending || p.slot === r.pending.askerSlot) return;
    const id = r.pending.id;
    r.pending = null;
    r.currentSlot = p.slot; // na het antwoord is de antwoorder aan de beurt
    io.to(r.code).emit('questionAnswered', { id, answer: answer === true, currentSlot: r.currentSlot });
  });

  socket.on('makeGuess', ({ flagId } = {}) => {
    const r = roomOf();
    const p = r && meIn(r);
    const t = r && oppIn(r);
    if (!r || !p || r.phase !== 'playing' || r.pending || p.slot !== r.currentSlot || typeof flagId !== 'string') return;
    const correct = flagId === t.secret;
    r.currentSlot = correct ? p.slot : t.slot; // foute gok = beurt voorbij
    io.to(r.code).emit('guessMade', { guesserName: p.name, flagId, correct, currentSlot: r.currentSlot });
    if (correct) {
      r.phase = 'over';
      io.to(r.code).emit('gameOver', {
        winnerSlot: p.slot,
        flags: { 1: r.players[0].secret, 2: r.players[1].secret },
      });
    }
  });

  socket.on('playAgainRequest', () => {
    const r = roomOf();
    if (!r || r.phase !== 'over') return;
    r.rematchVotes.add(socket.id);
    if (r.rematchVotes.size < 2) return; // wacht tot beide spelers rematch willen
    r.rematchVotes.clear();
    r.round += 1;
    r.phase = 'selecting';
    r.pending = null;
    r.players.forEach((p) => { p.secret = null; p.ready = false; });
    io.to(r.code).emit('rematchStarted', { round: r.round });
  });

  socket.on('leaveRoom', () => leaveRoom(socket.id));

  socket.on('disconnect', () => {
    leaveRoom(socket.id);
    users.delete(socket.id);
    broadcastUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Flag Guess Who draait op poort ${PORT}`));
