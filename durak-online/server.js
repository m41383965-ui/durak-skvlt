// ==============================================================================
// SKVLT DURAK v7.0 — ULTIMATE SERVER MONSTER
// Авторитетный сервер, защита от читов, таймеры, сессии, оптимизация.
// ==============================================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e5
});

app.use(express.static(path.join(__dirname, 'public')));

// ==============================================================================
// КОНФИГУРАЦИЯ
// ==============================================================================
const CONFIG = {
  MASTER_PASS: '220415',
  MAX_HAND: 6,
  MAX_TABLE: 6,
  TURN_TIME_MS: 35000, // 35 секунд на ход
  MAX_PLAYERS: 2,      // Классический дурак 1 на 1
  ROOM_CLEANUP_MS: 15 * 60 * 1000
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const WEIGHT = { '6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const POINTS = { '6':1,'7':2,'8':3,'9':4,'10':5,'J':6,'Q':7,'K':8,'A':10 };

// Хранилища (в оперативной памяти для максимальной скорости)
const rooms = new Map();       // Код комнаты -> Объект Комнаты
const playerSessions = new Map(); // ID сессии -> Данные игрока

// ==============================================================================
// УТИЛИТЫ
// ==============================================================================
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ s, r, id: `${r}${s}` });
  return deck;
}

function beats(a, b, trump) {
  if (!a || !b) return false;
  const aT = a.s === trump, bT = b.s === trump;
  if (aT && !bT) return true;
  if (!aT && bT) return false;
  if (a.s === b.s) return WEIGHT[a.r] > WEIGHT[b.r];
  return false;
}

// ==============================================================================
// КЛАСС: ИГРОВАЯ КОМНАТА (МОЗГ ИГРЫ)
// ==============================================================================
class MonsterRoom {
  constructor(id, pass) {
    this.id = id;
    this.pass = pass;
    this.players = [];      // Массив игроков
    this.deck = [];
    this.trump = null;
    this.table = [];        // [{ card, beaten, beatenBy }]
    this.atkIdx = 0;        // Индекс атакующего
    this.defIdx = 1;        // Индекс защищающегося
    this.state = 'waiting'; // waiting | playing | finished
    this.turnPhase = 'attack';
    this.log = [];          // История действий
    this.timer = null;      // Ссылка на таймер
    this.turnStart = 0;
    this.stats = { attacks: 0, defends: 0, takes: 0, translates: 0, cheatsBlocked: 0 };
  }

  // Добавление игрока за стол
  addPlayer(socketId, name) {
    if (this.state !== 'waiting') return { error: 'Игра уже началась' };
    if (this.players.length >= CONFIG.MAX_PLAYERS) return { error: 'Комната заполнена' };
    if (this.players.find(p => p.name === name)) return { error: 'Имя занято' };
    
    this.players.push({
      id: socketId,
      name: name,
      hand: [],
      connected: true
    });
    
    this.addLog(`👋 ${name} вошел в игру`);
    return { ok: true };
  }

  // Обработка отключения
  removePlayer(socketId) {
    const p = this.players.find(x => x.id === socketId);
    if (p) {
      p.connected = false;
      this.addLog(`🚪 ${p.name} отключился`);
      if (this.state === 'playing') {
        const winner = this.players.find(x => x.id !== socketId);
        if (winner) this.finishGame(winner.id, `${p.name} сбежал. Победа!`);
      }
    }
  }

  addLog(text) {
    this.log.push({ time: Date.now(), text });
    if (this.log.length > 40) this.log.shift();
  }

  // Запуск игры
  start() {
    if (this.state !== 'waiting') return;
    this.deck = shuffle(createDeck());
    this.trump = this.deck[this.deck.length - 1].s;
    
    this.players.forEach(p => p.hand = this.deck.splice(0, CONFIG.MAX_HAND));
    this.state = 'playing';
    
    // Первый атакующий — случайный
    this.atkIdx = Math.floor(Math.random() * this.players.length);
    this.defIdx = 1 - this.atkIdx;
    
    this.addLog(`🎲 Игра началась! Козырь: ${this.trump}`);
    this.addLog(`⚔️ Атакует: ${this.players[this.atkIdx].name}`);
    
    this.resetTimer();
    this.broadcast();
  }

  // Таймер хода
  resetTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.turnStart = Date.now();
    this.timer = setTimeout(() => this.handleTimeout(), CONFIG.TURN_TIME_MS);
  }

  handleTimeout() {
    if (this.state !== 'playing') return;
    this.addLog(`⏱️ Время вышло!`);
    
    if (this.turnPhase === 'defend') {
      this.takeCards(this.players[this.defIdx].id, true);
    } else {
      this.resetTimer();
      this.broadcast();
    }
  }

  // === ДЕЙСТВИЯ ИГРОКОВ ===

  attack(socketId, cardId) {
    if (this.state !== 'playing' || socketId !== this.players[this.atkIdx].id) {
      this.stats.cheatsBlocked++;
      return { error: 'Не ваш ход' };
    }
    if (this.table.length >= CONFIG.MAX_TABLE) return { error: 'Стол полон' };
    
    const p = this.players[this.atkIdx];
    const card = p.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Карты нет' };
    
    // Правило: если стол не пуст, бить можно только тем же рангом
    if (this.table.length > 0) {
      const ranksOnTable = this.table.map(t => t.card.r);
      if (!ranksOnTable.includes(card.r)) return { error: 'Нужен тот же ранг' };
    }

    p.hand = p.hand.filter(c => c.id !== cardId);
    this.table.push({ card, beaten: false, beatenBy: null });
    this.stats.attacks++;
    
    this.addLog(`⚔️ ${p.name} атакует ${card.r}${card.s}`);
    this.turnPhase = 'defend';
    this.resetTimer();
    this.broadcast();
    return { ok: true };
  }

  defend(socketId, cardId) {
    if (this.state !== 'playing' || socketId !== this.players[this.defIdx].id) {
      this.stats.cheatsBlocked++;
      return { error: 'Не ваш ход' };
    }
    const target = this.table.find(t => !t.beaten);
    if (!target) return { error: 'Нечего бить' };

    const p = this.players[this.defIdx];
    const card = p.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Карты нет' };
    if (!beats(card, target.card, this.trump)) return { error: 'Эта карта не бьет' };

    p.hand = p.hand.filter(c => c.id !== cardId);
    target.beaten = true;
    target.beatenBy = card;
    this.stats.defends++;
    
    this.addLog(`🛡️ ${p.name} отбивает ${target.card.r}${target.card.s} картой ${card.r}${card.s}`);
    
    // Если отбиты все 6 карт — автоматическое "Бито"
    const allBeaten = this.table.every(t => t.beaten);
    if (allBeaten && this.table.length >= CONFIG.MAX_TABLE) {
      this.passTurn(this.players[this.atkIdx].id);
    } else {
      this.resetTimer();
      this.broadcast();
    }
    return { ok: true };
  }

  translate(socketId, cardId) {
    if (this.state !== 'playing' || socketId !== this.players[this.defIdx].id) {
      this.stats.cheatsBlocked++;
      return { error: 'Не ваш ход' };
    }
    const p = this.players[this.defIdx];
    const target = this.table.find(t => !t.beaten);
    if (!target) return { error: 'Нет карты для перевода' };
    
    const card = p.hand.find(c => c.id === cardId);
    // Перевод разрешен только если карта того же ранга и может побить
    if (!card || card.r !== target.card.r || !beats(card, target.card, this.trump)) {
      return { error: 'Перевод невозможен' };
    }

    p.hand = p.hand.filter(c => c.id !== cardId);
    this.table.push({ card, beaten: false, beatenBy: null });
    this.stats.translates++;
    
    this.addLog(`🔄 ${p.name} переводит атаку на соперника!`);
    
    // Меняем роли
    const tmp = this.atkIdx;
    this.atkIdx = this.defIdx;
    this.defIdx = tmp;
    
    this.resetTimer();
    this.broadcast();
    return { ok: true };
  }

  takeCards(socketId, isTimeout = false) {
    if (this.state !== 'playing' || socketId !== this.players[this.defIdx].id) {
      this.stats.cheatsBlocked++;
      return { error: 'Не ваш ход' };
    }
    if (this.table.length === 0) return { error: 'Стол пуст' };

    const p = this.players[this.defIdx];
    this.table.forEach(t => {
      p.hand.push(t.card);
      if (t.beatenBy) p.hand.push(t.beatenBy);
    });
    
    this.stats.takes++;
    this.addLog(`📥 ${p.name} ${isTimeout ? '(по таймеру) ' : ''}забирает карты`);
    this.table = [];
    this.endRound(true);
    return { ok: true };
  }

  passTurn(socketId) {
    if (this.state !== 'playing' || socketId !== this.players[this.atkIdx].id) {
      this.stats.cheatsBlocked++;
      return { error: 'Не ваш ход' };
    }
    if (!this.table.every(t => t.beaten)) return { error: 'Есть неотбитые карты' };
    
    this.addLog(`✅ ${this.players[this.atkIdx].name}: Бито!`);
    this.table = [];
    this.endRound(false);
    return { ok: true };
  }

  endRound(defenderTook) {
    const drawToMax = (p) => {
      while (p.hand.length < CONFIG.MAX_HAND && this.deck.length > 0) {
        p.hand.push(this.deck.pop());
      }
    };

    // Если защитник отбился — роли меняются
    if (!defenderTook) {
      const tmp = this.atkIdx;
      this.atkIdx = this.defIdx;
      this.defIdx = tmp;
    }
    
    drawToMax(this.players[this.atkIdx]);
    drawToMax(this.players[this.defIdx]);
    this.turnPhase = 'attack';

    // Проверка на победу
    if (this.deck.length === 0) {
      const empty = this.players.find(p => p.hand.length === 0);
      if (empty) {
        const loser = this.players.find(p => p.hand.length > 0);
        this.finishGame(empty.id, `${loser.name} остался дураком!`);
        return;
      }
    }
    
    this.resetTimer();
    this.broadcast();
  }

  finishGame(winnerId, message) {
    if (this.timer) clearTimeout(this.timer);
    this.state = 'finished';
    
    this.addLog(`🏆 ${message}`);
    
    io.to(this.id).emit('game_over', {
      winnerId: winnerId,
      message: message,
      stats: this.stats
    });
    
    this.broadcast();
  }

  // Оптимизированная рассылка стейта
  broadcast() {
    const timeLeft = this.state === 'playing' ? Math.max(0, Math.ceil((CONFIG.TURN_TIME_MS - (Date.now() - this.turnStart)) / 1000)) : 0;

    this.players.forEach((p, i) => {
      if (!p.connected) return;
      const opp = this.players.find((_, idx) => idx !== i);
      
      io.to(p.id).emit('state', {
        state: this.state,
        trump: this.trump,
        deckCount: this.deck.length,
        table: this.table,
        timeLeft,
        you: { name: p.name, hand: p.hand, role: i === this.atkIdx ? 'atk' : 'def' },
        opp: opp ? { name: opp.name, count: opp.hand.length } : null,
        log: this.log.slice(-8)
      });
    });
  }
}

// ==============================================================================
// SOCKET.IO ЛОГИКА (ОБРАБОТКА ПОДКЛЮЧЕНИЙ)
// ==============================================================================
io.on('connection', (socket) => {
  console.log('🔌 Подключение:', socket.id);

  // Попытка восстановить сессию (если игрок перезагрузил страницу)
  socket.on('restore_session', ({ sid }, cb) => {
    const session = playerSessions.get(sid);
    if (!session) return cb({ error: 'Сессия не найдена' });
    
    // Восстанавливаем сокет
    session.socketId = socket.id;
    socket.sid = sid;
    socket.roomCode = session.roomCode;
    
    const room = rooms.get(session.roomCode);
    if (room) {
      const p = room.players.find(x => x.name === session.name);
      if (p) {
        p.id = socket.id; // Обновляем ID сокета
        p.connected = true;
        socket.join(room.id);
        cb({ ok: true, roomId: room.id, name: session.name });
        room.broadcast();
        return;
      }
    }
    cb({ error: 'Комната больше не существует' });
  });

  // Создание комнаты (только с мастер-паролем)
  socket.on('create_room', ({ name, master, pass }, cb) => {
    if (master !== CONFIG.MASTER_PASS) return cb({ error: '❌ Неверный мастер-пароль!' });
    if (!name || name.trim().length === 0) return cb({ error: 'Введите имя' });
    if (!pass || pass.length < 3) return cb({ error: 'Пароль комнаты от 3 символов' });

    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const room = new MonsterRoom(code, pass);
    room.addPlayer(socket.id, name);
    rooms.set(code, room);
    
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;

    // Создаем сессию
    const sid = crypto.randomBytes(16).toString('hex');
    playerSessions.set(sid, { socketId: socket.id, roomCode: code, name });

    cb({ ok: true, roomId: code, sessionId: sid });
    room.broadcast();
  });

  // Вход в комнату
  socket.on('join_room', ({ name, code, pass }, cb) => {
    if (!name) return cb({ error: 'Введите имя' });
    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ error: 'Комната не найдена' });
    if (room.pass !== pass) return cb({ error: 'Неверный пароль' });
    
    const res = room.addPlayer(socket.id, name);
    if (res.error) return cb({ error: res.error });

    socket.join(room.id);
    socket.roomCode = room.id;
    socket.playerName = name;
    
    // Создаем сессию
    const sid = crypto.randomBytes(16).toString('hex');
    playerSessions.set(sid, { socketId: socket.id, roomCode: room.id, name });

    cb({ ok: true, sessionId: sid });
    room.broadcast();

    // Автостарт
    if (room.players.length === 2 && room.state === 'waiting') {
      setTimeout(() => room.start(), 800);
    }
  });

  // Обработка действий
  socket.on('action', ({ action, cardId }, cb) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return cb && cb({ error: 'Комната не найдена' });

    let res;
    if (action === 'attack') res = room.attack(socket.id, cardId);
    else if (action === 'defend') res = room.defend(socket.id, cardId);
    else if (action === 'translate') res = room.translate(socket.id, cardId);
    else if (action === 'take') res = room.takeCards(socket.id);
    else if (action === 'pass') res = room.passTurn(socket.id);

    if (cb) cb(res || { ok: true });
  });

  // Чат
  socket.on('chat', ({ text }) => {
    const room = rooms.get(socket.roomCode);
    if (room && text) {
      const safeText = text.substring(0, 100).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      room.addLog(`💬 ${socket.playerName}: ${safeText}`);
      room.broadcast();
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('🔌 Отключение:', socket.id);
    const room = rooms.get(socket.roomCode);
    if (room) {
      room.removePlayer(socket.id);
      // Если все вышли — удаляем комнату
      if (room.players.filter(p => p.connected).length === 0) {
        rooms.delete(socket.roomCode);
      }
    }
  });
});

// Автоочистка старых комнат (защита от утечки памяти)
setInterval(() => {
  rooms.forEach((room, code) => {
    if (room.state === 'finished' && Date.now() - room.log[room.log.length-1]?.time > CONFIG.ROOM_CLEANUP_MS) {
      rooms.delete(code);
    }
  });
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`👹 SKVLT DURAK v7.0 запущен на порту ${PORT}`));