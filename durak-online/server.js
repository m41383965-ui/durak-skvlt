// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { RoomManager } = require('./game/manager');
const { hashPassword, verifyPassword, RateLimiter } = require('./game/security');
const { MASTER_PASSWORD, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } = require('./game/constants');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const manager = new RoomManager(io);
const limiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);

function genSession() { return crypto.randomBytes(16).toString('hex'); }

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);
  const ip = socket.handshake.address;

  socket.on('restore', ({ sid }, cb) => {
    const s = manager.sessions.get(sid);
    if (!s) return cb({ error: 'Сессия не найдена' });
    
    s.socketId = socket.id;
    s.connected = true;
    socket.data = { sessionId: sid, roomId: s.roomId, name: s.name };
    socket.join(s.roomId);

    const room = manager.getRoom(s.roomId);
    if (room) {
      room.reconnectPlayer(socket.id, s.name);
      room.broadcast();
    }
    cb({ ok: true, roomId: s.roomId, name: s.name });
  });

  // СОЗДАНИЕ КОМНАТЫ (ТОЛЬКО С МАСТЕР-ПАРОЛЕМ)
  socket.on('create_room', ({ name, masterPass, gamePass, maxPlayers }, cb) => {
    if (masterPass !== MASTER_PASSWORD) {
      return cb({ error: 'Доступ запрещен. Неверный мастер-код.' });
    }
    if (!name || name.length > 14) return cb({ error: 'Некорректное имя' });
    if (!gamePass || gamePass.length < 4) return cb({ error: 'Пароль комнаты: минимум 4 символа' });

    const { hash, salt } = hashPassword(gamePass);
    const room = manager.createRoom({
      passwordHash: hash,
      passwordSalt: salt,
      maxPlayers: Math.min(Math.max(maxPlayers || 2, 2), 4)
    });
    
    room.addPlayer(socket.id, name);
    const sid = genSession();
    manager.sessions.set(sid, { socketId: socket.id, roomId: room.id, name, connected: true });
    
    socket.data = { sessionId: sid, roomId: room.id, name };
    socket.join(room.id);
    
    cb({ roomId: room.id, sessionId: sid });
    room.broadcast();
    console.log(`🏠 Создана комната ${room.id}`);
  });

  // ВХОД В КОМНАТУ
  socket.on('join_room', ({ roomId, name, password }, cb) => {
    const rate = limiter.check(ip);
    if (!rate.allowed) return cb({ error: `Флуд. Ждите ${rate.retryAfter} сек.` });
    if (!name || name.length > 14) return cb({ error: 'Некорректное имя' });

    const room = manager.getRoom(roomId.toUpperCase());
    if (!room) return cb({ error: 'Комната не найдена' });
    if (!password) return cb({ error: 'Введите пароль комнаты' });
    
    if (!verifyPassword(password, room.passwordHash, room.passwordSalt)) {
      return cb({ error: 'Неверный пароль' });
    }

    const rec = room.reconnectPlayer(socket.id, name);
    if (rec) {
      const sid = genSession();
      manager.sessions.set(sid, { socketId: socket.id, roomId: room.id, name, connected: true });
      socket.data = { sessionId: sid, roomId: room.id, name };
      socket.join(room.id);
      cb({ ok: true, sessionId: sid });
      room.broadcast();
      return;
    }

    if (room.players.length >= room.maxPlayers) return cb({ error: 'Мест нет' });
    
    room.addPlayer(socket.id, name);
    const sid = genSession();
    manager.sessions.set(sid, { socketId: socket.id, roomId: room.id, name, connected: true });
    socket.data = { sessionId: sid, roomId: room.id, name };
    socket.join(room.id);
    
    cb({ ok: true, sessionId: sid });
    room.broadcast();

    if (room.players.length === room.maxPlayers && room.state === 'waiting') {
      setTimeout(() => { if (room.state === 'waiting') room.start(); }, 500);
    }
  });

  socket.on('action', ({ action, cardId }, cb) => {
    const room = manager.getRoom(socket.data.roomId);
    if (!room) return cb({ error: 'Комната не найдена' });

    let res;
    if (action === 'attack') res = room.attack(socket.id, cardId);
    else if (action === 'defend') res = room.defend(socket.id, cardId);
    else if (action === 'translate') res = room.translate(socket.id, cardId);
    else if (action === 'take') res = room.take(socket.id);
    else if (action === 'pass') res = room.pass(socket.id);
    
    if (cb) cb(res || { ok: true });
  });

  socket.on('chat', ({ text }) => {
    const room = manager.getRoom(socket.data.roomId);
    if (room && text) {
      room.pushLog(`💬 ${socket.data.name}: ${text.slice(0, 100)}`);
      room.broadcast();
    }
  });

  socket.on('disconnect', () => {
    const s = manager.sessions.get(socket.data.sessionId);
    if (s) {
      s.connected = false;
      const room = manager.getRoom(s.roomId);
      if (room) {
        room.removePlayer(socket.id);
        room.broadcast();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер v4.0 запущен на порту ${PORT}`));