const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serveer statische bestanden uit de 'public' map
// Verander dit in je server.js:
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// Zorg dat de root ('/') de index.html laadt in plaats van JSON
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Zet de statuscontrole op een apart pad zodat de hoofdpagina vrij blijft voor het spel
app.get('/status', (req, res) => {
  res.json({ status: 'ok', online: io.engine.clientsCount, activeGames: 0 });
});

io.on('connection', (socket) => {
  // Jouw bestaande socket.io logica voor username, invites en game rooms komt hieronder...
  socket.on('registerUsername', ({ username }) => {
    // ...
  });
  // ... (behoud je verdere socket logica uit je vorige server.js)
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Flag Guess Who server running on port ${PORT}`));
