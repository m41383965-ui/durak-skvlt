// server.js
// ============================================================
//  СЕРВЕР: Express + Socket.IO + комнаты с паролем
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Room, MIN_PLAYERS, MAX_PLAYERS } = require('./game/room');
const { validatePassword, hashPassword, verifyPassword, RateLimiter } = require('./game/security');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
//  ХРАНИЛИЩА
// ============================================================
const rooms = new Map();          // roomId -> Room
const playerSessions = new Map(); // sessionId -> { socketId, roomId, name, connected }
const ipRateLimiter = new RateLimiter(10, 60000); // 10 попыток в минуту

// ============================================================
//  УТИЛИТЫ
// ============================================================
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function getClientIp(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
      || socket.handshake.address
      || 'unknown';
}

function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    // Удаляем завершённые комнаты старше 30 минут
    if (room.state === 'finished' && room.finishedAt && now - room.finishedAt > 30 * 60 * 1000) {
      rooms.delete(id);
      continue;
    }
    // Удаляем пустые комнаты старше 10 минут
    const activePlayers = room.players.filter(p => p.connected);
    if (activePlayers.length === 0 && now - room.lastActivity > 10 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}
setInterval(cleanupRooms, 5 * 60 * 1000);

// ============================================================
//  SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);
  const ip = getClientIp(socket);

  // Восстановление сессии по sessionId
  socket.on('restore_session', ({ sessionId }, cb) => {
    const session = playerSessions.get(sessionId);
    if (!session) return cb({ error: 'Сессия не найдена' });

    session.socketId = socket.id;
    session.connected = true;
    socket.data.sessionId = sessionId;
    socket.data.roomId = session.roomId;
    socket.data.playerName = session.name;

    socket.join(session.roomId);

    const room = rooms.get(session.roomId);
    if (room) {
      room.reconnectPlayer(socket.id, session.name);
      room.broadcastState();
    }
    cb({ ok: true, roomId: session.roomId, name: session.name });
  });

  // Список активных комнат
  socket.on('list_rooms', (cb) => {
    const list = Array.from(rooms.values())
      .filter(r => r.state === 'waiting')
      .map(r => r.toPublicInfo());
    cb({ rooms: list });
  });

  // Создать комнату
  socket.on('create_room', ({ name, password, maxPlayers }, cb) => {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return cb({ error: 'Введите имя' });
    }
    if (name.length > 14) {
      return cb({ error: 'Имя слишком длинное (макс. 14)' });
    }

    // Проверка пароля
    let passwordHash = null, passwordSalt = null;
    if (password && password.length > 0) {
      const v = validatePassword(password);
      if (!v.ok) return cb({ error: v.error });
      const h = hashPassword(password);
      passwordHash = h.hash;
      passwordSalt = h.salt;
    }

    // Генерация уникального кода
    let roomId;
    do { roomId = generateRoomCode(); } while (rooms.has(roomId));

    const room = new Room(roomId, io, {
      passwordHash,
      passwordSalt,
      maxPlayers: Math.min(Math.max(maxPlayers || 2, MIN_PLAYERS), MAX_PLAYERS)
    });
    room.addPlayer(socket.id, name);
    rooms.set(roomId, room);

    // Сессия
    const sessionId = generateSessionId();
    playerSessions.set(sessionId, {
      socketId: socket.id,
      roomId,
      name,
      connected: true
    });

    socket.data.sessionId = sessionId;
    socket.data.roomId = roomId;
    socket.data.playerName = name;
    socket.join(roomId);

    cb({ roomId, sessionId });
    room.broadcastState();
    console.log(`🏠 Room created: ${roomId} by ${name} (${password ? 'password-protected' : 'open'})`);
  });

  // Войти в комнату
  socket.on('join_room', ({ roomId, name, password }, cb) => {
    const rate = ipRateLimiter.check(ip);
    if (!rate.allowed) {
      return cb({ error: `Слишком много попыток. Подождите ${rate.retryAfter} сек.` });
    }

    if (!roomId || typeof roomId !== 'string') {
      return cb({ error: 'Введите код комнаты' });
    }

    const code = roomId.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Стол не найден' });

    // Проверка пароля
    if (room.requirePassword) {
      if (!password) return cb({ error: 'Введите пароль' });
      if (!verifyPassword(password, room.passwordHash, room.passwordSalt)) {
        return cb({ error: 'Неверный пароль' });
      }
    }

    // Попытка реконнекта
    const reconnected = room.reconnectPlayer(socket.id, name);
    if (reconnected) {
      const sessionId = generateSessionId();
      playerSessions.set(sessionId, {
        socketId: socket.id,
        roomId: code,
        name,
        connected: true
      });
      socket.data.sessionId = sessionId;
      socket.data.roomId = code;
      socket.data.playerName = name;
      socket.join(code);
      cb({ ok: true, reconnected: true });
      room.broadcastState();
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      return cb({ error: 'Стол заполнен' });
    }

    const res = room.addPlayer(socket.id, name);
    if (res.error) return cb({ error: res.error });

    const sessionId = generateSessionId();
    playerSessions.set(sessionId, {
      socketId: socket.id,
      roomId: code,
      name,
      connected: true
    });

    socket.data.sessionId = sessionId;
    socket.data.roomId = code;
    socket.data.playerName = name;
    socket.join(code);

    cb({ ok: true, sessionId });
    room.broadcastState();

    // Автостарт: когда достигнут лимит игроков
    if (room.players.length === room.maxPlayers && room.state === 'waiting') {
      setTimeout(() => {
        if (room.state === 'waiting') room.start();
      }, 500);
    }
  });

  // Игровое действие
  socket.on('game_action', ({ action, cardId }, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) return cb && cb({ error: 'Нет комнаты' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'Комната не найдена' });

    let result;
    switch (action) {
      case 'attack':   result = room.attack(socket.id, cardId); break;
      case 'throw_in': result = room.throwIn(socket.id, cardId); break;
      case 'defend':   result = room.defend(socket.id, cardId); break;
      case 'translate':result = room.translate(socket.id, cardId); break;
      case 'take':     result = room.take(socket.id); break;
      case 'pass':     result = room.pass(socket.id); break;
      default:         result = { error: 'Неизвестное действие' };
    }

    if (cb) cb(result || { ok: true });
  });

  // Чат
  socket.on('chat', ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (!text || typeof text !== 'string') return;
    const safe = text.slice(0, 200).replace(/[<>]/g, '');
    const msg = { name: socket.data.playerName, text: safe, ts: Date.now() };
    io.to(roomId).emit('chat', msg);
    room.pushLog(`${msg.name}: ${safe}`);
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('🔌 Disconnected:', socket.id);
    const sessionId = socket.data.sessionId;
    if (sessionId) {
      const session = playerSessions.get(sessionId);
      if (session) {
        session.connected = false;
        // Удаляем сессию через 5 минут
        setTimeout(() => {
          if (!playerSessions.get(sessionId)?.connected) {
            playerSessions.delete(sessionId);
          }
        }, 5 * 60 * 1000);
      }
    }

    const roomId = socket.data.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.removePlayer(socket.id);
        room.broadcastState();
      }
    }
  });
});

// ============================================================
//  ЗАПУСК
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🃏 Durak server v2.0 running on http://localhost:${PORT}`);
  console.log(`   Комнат с паролем: защищено`);
  console.log(`   Лимит игроков: ${MIN_PLAYERS}–${MAX_PLAYERS}`);
});