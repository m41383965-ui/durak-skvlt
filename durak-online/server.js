// ============================================================
// server.js — МОЗГ ИГРЫ (v6.0 Ultimate Edition)
// ============================================================
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
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

// --- КОНСТАНТЫ ---
const CONFIG = {
  MASTER_PASS: '220415',
  MAX_HAND: 6,
  MAX_TABLE: 6,
  TURN_TIME_MS: 30000, // 30 сек
  MAX_PLAYERS: 4
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const WEIGHT = { '6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const POINTS = { '6':1,'7':2,'8':3,'9':4,'10':5,'J':6,'Q':7,'K':8,'A':10 };

const rooms = new Map();

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) deck.push({ s, r, id: `${r}${s}` });
  }
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

function getHandPoints(hand) {
  return hand.reduce((sum, c) => sum + (POINTS[c.r] || 0), 0);
}

// ============================================================
// КЛАСС ИГРОВОЙ КОМНАТЫ
// ============================================================
class GameRoom {
  constructor(id, pass) {
    this.id = id;
    this.pass = pass;
    this.players = [];
    this.deck = [];
    this.trump = null;
    this.table = [];
    this.discard = [];
    this.atkIdx = 0;
    this.defIdx = 1;
    this.state = 'waiting'; // waiting | playing | finished
    this.turnPhase = 'attack'; // attack | defend
    this.log = [];
    this.timer = null;
    this.turnStart = 0;
    this.stats = { attacks: 0, defends: 0, takes: 0, translates: 0 };
  }

  addPlayer(socketId, name) {
    if (this.state !== 'waiting') return { error: 'Игра уже началась' };
    if (this.players.length >= CONFIG.MAX_PLAYERS) return { error: 'Комната заполнена' };
    if (this.players.find(p => p.name === name)) return { error: 'Имя занято' };
    
    this.players.push({
      id: socketId,
      name: name,
      hand: [],
      score: 0,
      connected: true
    });
    
    this.addLog(`👋 ${name} присоединился к столу`);
    return { ok: true };
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.id === socketId);
    if (idx !== -1) {
      this.players[idx].connected = false;
      this.addLog(`🚪 ${this.players[idx].name} отключился`);
      if (this.state === 'playing') {
        this.finishGame(this.players[1 - idx].id, 'Соперник сбежал');
      }
    }
  }

  addLog(text) {
    this.log.push({ time: Date.now(), text });
    if (this.log.length > 30) this.log.shift();
  }

  start() {
    if (this.state !== 'waiting') return;
    this.deck = shuffle(createDeck());
    this.trump = this.deck[this.deck.length - 1].s;
    
    this.players.forEach(p => p.hand = this.deck.splice(0, CONFIG.MAX_HAND));
    this.state = 'playing';
    this.atkIdx = Math.floor(Math.random() * this.players.length);
    this.defIdx = (this.atkIdx + 1) % this.players.length;
    
    this.addLog(`🎲 Игра началась! Козырь: ${this.trump}`);
    this.addLog(`⚔️ Атакует: ${this.players[this.atkIdx].name}`);
    
    this.resetTimer();
    this.broadcast();
  }

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

  // ДЕЙСТВИЯ
  attack(socketId, cardId) {
    if (this.state !== 'playing' || socketId !== this.players[this.atkIdx].id) return { error: 'Не ваш ход' };
    if (this.table.length >= CONFIG.MAX_TABLE) return { error: 'Стол полон' };
    
    const p = this.players[this.atkIdx];
    const card = p.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Карты нет' };
    
    if (this.table.length > 0) {
      const ranksOnTable = this.table.map(t => t.card.r);
      if (!ranksOnTable.includes(card.r)) return { error: 'Нужен тот же ранг' };
    }

    p.hand = p.hand.filter(c => c.id !== cardId);
    this.table.push({ card, beaten: false, beatenBy: null });
    this.stats.attacks++;
    
    this.addLog(`⚔️ ${p.name}: ${card.r}${card.s}`);
    this.turnPhase = 'defend';
    this.resetTimer();
    this.broadcast();
    return { ok: true };
  }

  defend(socketId, cardId) {
    if (this.state !== 'playing' || socketId !== this.players[this.defIdx].id) return { error: 'Не ваш ход' };
    const target = this.table.find(t => !t.beaten);
    if (!target) return { error: 'Нечего бить' };

    const p = this.players[this.defIdx];
    const card = p.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Карты нет' };
    if (!beats(card, target.card, this.trump)) return { error: 'Не бьет' };

    p.hand = p.hand.filter(c => c.id !== cardId);
    target.beaten = true;
    target.beatenBy = card;
    this.stats.defends++;
    
    this.addLog(`🛡️ ${p.name} отбил ${target.card.r}${target.card.s}`);
    
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
    if (this.state !== 'playing' || socketId !== this.players[this.defIdx].id) return { error: 'Не ваш ход' };
    const p = this.players[this.defIdx];
    const target = this.table.find(t => !t.beaten);
    if (!target) return { error: 'Нет карты' };
    
    const card = p.hand.find(c => c.id === cardId);
    if (!card || card.r !== target.card.r || !beats(card, target.card, this.trump)) {
      return { error: 'Перевод невозможен' };
    }

    p.hand = p.hand.filter(c => c.id !== cardId);
    this.table.push({ card, beaten: false, beatenBy: null });
    this.stats.translates++;
    
    this.addLog(`🔄 ${p.name} перевел на соперника!`);
    
    const tmp = this.atkIdx;
    this.atkIdx = this.defIdx;
    this.defIdx = tmp;
    
    this.resetTimer();
    this.broadcast();
    return { ok: true };
  }

  takeCards(socketId, isTimeout = false) {
    if (this.state !== 'playing' || socketId !== this.players[this.defIdx].id) return { error: 'Не ваш ход' };
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
    if (this.state !== 'playing' || socketId !== this.players[this.atkIdx].id) return { error: 'Не ваш ход' };
    if (!this.table.every(t => t.beaten)) return { error: 'Есть неотбитые' };
    
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

    if (!defenderTook) {
      const tmp = this.atkIdx;
      this.atkIdx = this.defIdx;
      this.defIdx = tmp;
    }
    
    drawToMax(this.players[this.atkIdx]);
    drawToMax(this.players[this.defIdx]);
    this.turnPhase = 'attack';

    // Проверка на конец игры
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
    
    const winner = this.players.find(p => p.id === winnerId);
    const loser = this.players.find(p => p.id !== winnerId);
    
    if (winner) {
      winner.score += getHandPoints(loser ? loser.hand : []);
    }

    this.addLog(`🏆 ${message}`);
    
    io.to(this.id).emit('game_over', {
      winner: winner ? winner.name : 'Неизвестно',
      loser: loser ? loser.name : 'Неизвестно',
      message,
      stats: this.stats
    });
    
    this.broadcast();
  }

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
        you: {
          name: p.name,
          hand: p.hand,
          role: i === this.atkIdx ? 'atk' : 'def',
          score: p.score
        },
        opp: opp ? {
          name: opp.name,
          count: opp.hand.length,
          score: opp.score
        } : null,
        log: this.log.slice(-6)
      });
    });
  }
}

// ============================================================
// SOCKET.IO ЛОГИКА
// ============================================================
io.on('connection', (socket) => {
  console.log('🔌 Подключился:', socket.id);

  socket.on('create_room', ({ name, master, pass }, cb) => {
    if (master !== CONFIG.MASTER_PASS) {
      return cb({ error: '❌ Неверный мастер-пароль!' });
    }
    if (!name || name.trim().length === 0) {
      return cb({ error: 'Введите имя' });
    }
    if (!pass || pass.length < 3) {
      return cb({ error: 'Пароль комнаты от 3 символов' });
    }

    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const room = new GameRoom(code, pass);
    room.addPlayer(socket.id, name);
    rooms.set(code, room);
    
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;

    cb({ ok: true, roomId: code });
    room.broadcast();
  });

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
    
    cb({ ok: true });
    room.broadcast();

    // Автостарт, если набралось 2 игрока
    if (room.players.length === 2 && room.state === 'waiting') {
      setTimeout(() => room.start(), 500);
    }
  });

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

  socket.on('chat', ({ text }) => {
    const room = rooms.get(socket.roomCode);
    if (room && text) {
      const safeText = text.substring(0, 100).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      room.addLog(`💬 ${socket.playerName}: ${safeText}`);
      room.broadcast();
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Отключился:', socket.id);
    const room = rooms.get(socket.roomCode);
    if (room) {
      room.removePlayer(socket.id);
      if (room.players.filter(p => p.connected).length === 0) {
        rooms.delete(socket.roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Супер-сервер v6.0 работает на порту ${PORT}`));