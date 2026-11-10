const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// === КОНСТАНТЫ ===
const MASTER_PASSWORD = '220415';
const MAX_HAND = 6;
const MAX_TABLE = 6;
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const W = { '6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

const rooms = new Map();

// === УТИЛИТЫ ===
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function createDeck() { const d = []; for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: `${r}${s}` }); return d; }
function beats(a, b, trump) {
  const aT = a.suit === trump, bT = b.suit === trump;
  if (aT && !bT) return true;
  if (!aT && bT) return false;
  if (a.suit === b.suit) return W[a.rank] > W[b.rank];
  return false;
}

class Room {
  constructor(id, pass) {
    this.id = id;
    this.pass = pass;
    this.players = [];
    this.deck = [];
    this.trump = null;
    this.table = [];
    this.atkIdx = 0;
    this.defIdx = 1;
    this.state = 'waiting';
    this.log = [];
  }

  addPlayer(id, name) {
    if (this.players.length >= 2) return { error: 'Комната заполнена (макс 2)' };
    this.players.push({ id, name, hand: [] });
    this.log.push(`👋 ${name} вошел`);
    return { ok: true };
  }

  start() {
    this.deck = shuffle(createDeck());
    this.trump = this.deck[this.deck.length - 1].suit;
    this.players.forEach(p => p.hand = this.deck.splice(0, MAX_HAND));
    this.state = 'playing';
    this.atkIdx = Math.floor(Math.random() * 2);
    this.defIdx = 1 - this.atkIdx;
    this.log.push(`🎲 Игра началась! Козырь: ${this.trump}`);
    this.log.push(`⚔️ Атакует: ${this.players[this.atkIdx].name}`);
    this.broadcast();
  }

  broadcast() {
    this.players.forEach((p, i) => {
      const opp = this.players[1 - i];
      io.to(p.id).emit('state', {
        state: this.state,
        trump: this.trump,
        deck: this.deck.length,
        table: this.table,
        you: { name: p.name, hand: p.hand, role: i === this.atkIdx ? 'atk' : 'def' },
        opp: opp ? { name: opp.name, count: opp.hand.length } : null,
        log: this.log.slice(-5)
      });
    });
  }

  action(id, action, cardId) {
    const pIdx = this.players.findIndex(p => p.id === id);
    if (pIdx === -1 || this.state !== 'playing') return { error: 'Ошибка' };
    const p = this.players[pIdx];
    const isAtk = pIdx === this.atkIdx;
    const isDef = pIdx === this.defIdx;

    if (action === 'attack' && isAtk) {
      const card = p.hand.find(c => c.id === cardId);
      if (!card) return;
      if (this.table.length > 0 && !this.table.some(t => t.card.rank === card.rank)) return;
      p.hand = p.hand.filter(c => c.id !== cardId);
      this.table.push({ card, beaten: false });
      this.log.push(`⚔️ ${p.name}: ${card.rank}${card.suit}`);
      this.broadcast();
      return { ok: true };
    }

    if (action === 'defend' && isDef) {
      const target = this.table.find(t => !t.beaten);
      if (!target) return;
      const card = p.hand.find(c => c.id === cardId);
      if (!card || !beats(card, target.card, this.trump)) return;
      p.hand = p.hand.filter(c => c.id !== cardId);
      target.beaten = true;
      target.beatenBy = card;
      this.log.push(`🛡️ ${p.name} отбил`);
      this.broadcast();
      return { ok: true };
    }

    if (action === 'take' && isDef) {
      if (this.table.length === 0) return;
      this.table.forEach(t => { p.hand.push(t.card); if (t.beatenBy) p.hand.push(t.beatenBy); });
      this.table = [];
      this.log.push(`📥 ${p.name} забирает`);
      this.endRound(true);
      return { ok: true };
    }

    if (action === 'pass' && isAtk) {
      if (this.table.length === 0 || this.table.some(t => !t.beaten)) return;
      this.table = [];
      this.log.push(`✅ Бито!`);
      this.endRound(false);
      return { ok: true };
    }
  }

  endRound(took) {
    const draw = (p) => { while(p.hand.length < MAX_HAND && this.deck.length) p.hand.push(this.deck.pop()); };
    if (took) {
      draw(this.players[this.atkIdx]); draw(this.players[this.defIdx]);
    } else {
      const tmp = this.atkIdx; this.atkIdx = this.defIdx; this.defIdx = tmp;
      draw(this.players[this.atkIdx]); draw(this.players[this.defIdx]);
    }
    
    if (this.deck.length === 0) {
      const empty = this.players.find(p => p.hand.length === 0);
      if (empty) {
        this.state = 'finished';
        const loser = this.players.find(p => p !== empty);
        io.to(this.id).emit('game_over', { winner: empty.name, loser: loser.name });
        this.broadcast();
        return;
      }
    }
    this.broadcast();
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name, master, pass }, cb) => {
    if (master !== MASTER_PASSWORD) return cb({ error: 'Неверный мастер-пароль!' });
    if (!pass || pass.length < 3) return cb({ error: 'Пароль комнаты от 3 символов' });
    
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = new Room(code, pass);
    room.addPlayer(socket.id, name);
    rooms.set(code, room);
    
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    
    cb({ ok: true, roomId: code });
    room.broadcast();
  });

  socket.on('join_room', ({ name, code, pass }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Комната не найдена' });
    if (room.pass !== pass) return cb({ error: 'Неверный пароль комнаты' });
    
    const res = room.addPlayer(socket.id, name);
    if (res.error) return cb({ error: res.error });
    
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    
    cb({ ok: true });
    room.broadcast();
    
    if (room.players.length === 2) setTimeout(() => room.start(), 500);
  });

  socket.on('action', ({ action, cardId }) => {
    const room = rooms.get(socket.roomCode);
    if (room) room.action(socket.id, action, cardId);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomCode);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) rooms.delete(socket.roomCode);
      else room.broadcast();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Сервер запущен: http://localhost:${PORT}`));