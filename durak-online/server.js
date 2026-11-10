// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Room = require('./game/room');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = new Map(); // roomId -> Room

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Создать комнату
  socket.on('create_room', ({ name }, cb) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));

    const room = new Room(code, io);
    room.addPlayer(socket.id, name);
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomId = code;
    socket.data.playerName = name;

    cb({ roomId: code });
    room.broadcastState();
    console.log(`Room created: ${code} by ${name}`);
  });

  // Войти в комнату
  socket.on('join_room', ({ roomId, name }, cb) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return cb({ error: 'Стол не найден' });

    // Попытка реконнекта
    const reconnected = room.reconnectPlayer(socket.id, name);
    if (reconnected) {
      socket.join(room.id);
      socket.data.roomId = room.id;
      socket.data.playerName = name;
      cb({ ok: true, reconnected: true });
      room.broadcastState();
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      return cb({ error: 'Стол заполнен' });
    }

    const res = room.addPlayer(socket.id, name);
    if (res.error) return cb({ error: res.error });

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerName = name;
    cb({ ok: true });
    room.broadcastState();

    // Если в комнате 2 игрока — стартуем
    if (room.players.length === 2 && room.state === 'waiting') {
      setTimeout(() => room.start(), 300);
    }
  });

  // Действия игры
  socket.on('game_action', ({ action, cardIndex }, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb && cb({ error: 'Нет комнаты' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'Комната не найдена' });

    let result;
    switch (action) {
      case 'attack': result = room.attack(socket.id, cardIndex); break;
      case 'defend': result = room.defend(socket.id, cardIndex); break;
      case 'take':   result = room.take(socket.id); break;
      case 'pass':   result = room.pass(socket.id); break;
      default: result = { error: 'Неизвестное действие' };
    }
    if (cb) cb(result);
  });

  // Чат (опционально)
  socket.on('chat', ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = { name: socket.data.playerName, text: text.slice(0, 200) };
    room.log.push(`${msg.name}: ${msg.text}`);
    io.to(roomId).emit('chat', msg);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.removePlayer(socket.id);
    room.broadcastState();
    console.log('Disconnected:', socket.id, 'from', roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🃏 Durak server running on http://localhost:${PORT}`);
});