const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || '*';

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
  },
});

// In-memory room storage: roomCode → { state, players: [socketId, socketId] }
const rooms = new Map();

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Health-check for Render
app.use(cors());
app.get('/', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // ── Create a new room ────────────────────────────────────────────────────
  socket.on('create_room', ({ state }) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));

    rooms.set(code, { state, players: [socket.id] });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 1;

    socket.emit('room_created', { code, role: 1 });
    console.log(`Room ${code} created by ${socket.id}`);
  });

  // ── Join an existing room ────────────────────────────────────────────────
  socket.on('join_room', ({ code }) => {
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join_error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('join_error', { message: 'Room is full.' });
      return;
    }

    room.players.push(socket.id);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 2;

    // Tell both players we're ready
    socket.emit('room_joined', { code, role: 2, state: room.state });
    io.to(room.players[0]).emit('opponent_joined');
    console.log(`Room ${code}: Player 2 joined`);
  });

  // ── Sync game state from one player to the other ─────────────────────────
  socket.on('sync_state', ({ code, state }) => {
    const room = rooms.get(code);
    if (!room) return;

    room.state = state;
    // Broadcast to everyone in the room except the sender
    socket.to(code).emit('state_updated', { state });
  });

  // ── Handle disconnect ─────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    // Notify opponent
    socket.to(code).emit('opponent_disconnected');

    // Remove the room after a short grace period
    setTimeout(() => {
      const r = rooms.get(code);
      if (r && r.players.every((id) => !io.sockets.sockets.has(id))) {
        rooms.delete(code);
        console.log(`Room ${code} cleaned up`);
      }
    }, 30_000);

    console.log(`${socket.id} left room ${code}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
