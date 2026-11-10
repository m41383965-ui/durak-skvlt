// game/room.js
const { createDeck, shuffle, draw, handPoints } = require('./deck');
const { canAttack, canThrowIn, canDefend, allBeaten, canTranslate } = require('./rules');
const { MAX_HAND, MAX_TABLE, TURN_TIMEOUT_MS } = require('./constants');

class Room {
  constructor(id, io, options) {
    this.id = id;
    this.io = io;
    this.passwordHash = options.passwordHash;
    this.passwordSalt = options.passwordSalt;
    this.maxPlayers = options.maxPlayers || 2;
    
    this.players = [];
    this.deck = [];
    this.trump = null;
    this.table = [];
    this.attackerIdx = 0;
    this.defenderIdx = 1;
    this.state = 'waiting'; // waiting, playing, finished
    this.log = [];
    this.turnPhase = 'attack';
    this.turnStartedAt = null;
    this.turnTimer = null;
    this.lastActivity = Date.now();
    
    // Оптимизация: кэш состояния
    this.stateCache = new Map();
  }

  addPlayer(socketId, name) {
    if (this.state === 'finished') return { error: 'Игра окончена' };
    if (this.players.length >= this.maxPlayers) return { error: 'Комната заполнена' };
    if (this.players.find(p => p.socketId === socketId)) return { error: 'Вы уже здесь' };
    
    this.players.push({ socketId, name, hand: [], connected: true, score: 0 });
    this.pushLog(`👋 ${name} присоединился`);
    return { ok: true };
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.socketId === socketId);
    if (idx === -1) return;
    this.players[idx].connected = false;
    this.pushLog(`🚪 ${this.players[idx].name} отключился`);
    
    if (this.state === 'playing') {
      const winner = this.players.find((_, i) => i !== idx);
      if (winner) this.finish(winner.socketId, 'Соперник сбежал');
    }
  }

  reconnectPlayer(socketId, name) {
    const p = this.players.find(x => x.name === name && !x.connected);
    if (p) {
      p.socketId = socketId;
      p.connected = true;
      this.pushLog(`🔄 ${name} вернулся`);
      return p;
    }
    return null;
  }

  start() {
    if (this.state !== 'waiting') return;
    this.deck = shuffle(createDeck());
    this.trump = this.deck[this.deck.length - 1].suit;
    this.players.forEach(p => p.hand = draw(this.deck, MAX_HAND));
    
    this.attackerIdx = Math.floor(Math.random() * this.players.length);
    this.defenderIdx = (this.attackerIdx + 1) % this.players.length;
    this.state = 'playing';
    
    this.pushLog(`🎲 Игра началась! Козырь: ${this.trump}`);
    this.resetTurnTimer();
    this.broadcast();
  }

  resetTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnStartedAt = Date.now();
    this.turnTimer = setTimeout(() => this.handleTimeout(), TURN_TIMEOUT_MS);
  }

  handleTimeout() {
    if (this.state !== 'playing') return;
    if (this.turnPhase === 'defend') {
      this.pushLog(`⏱️ Время вышло. Защитник забирает.`);
      this.take(this.getDefender().socketId);
    } else {
      this.pushLog(`⏱️ Время вышло. Пропуск хода.`);
      this.resetTurnTimer();
      this.broadcast();
    }
  }

  pushLog(text) {
    this.log.push({ ts: Date.now(), text });
    if (this.log.length > 50) this.log.shift();
  }

  getAttacker() { return this.players[this.attackerIdx]; }
  getDefender() { return this.players[this.defenderIdx]; }
  getPlayer(id) { return this.players.find(p => p.socketId === id); }

  // ДЕЙСТВИЯ
  attack(socketId, cardId) {
    if (this.state !== 'playing' || this.getAttacker().socketId !== socketId) return { error: 'Не ваш ход' };
    if (this.table.length >= MAX_TABLE) return { error: 'Стол полон' };
    
    const p = this.getAttacker();
    const card = p.hand.find(c => c.id === cardId);
    if (!card || !canAttack(card, this.table)) return { error: 'Нельзя бить этой картой' };

    p.hand = p.hand.filter(c => c.id !== cardId);
    this.table.push({ card, beaten: false, beatenBy: null });
    this.turnPhase = 'defend';
    this.pushLog(`⚔️ ${p.name}: ${card.rank}${card.suit}`);
    this.resetTurnTimer();
    this.broadcast();
    return { ok: true };
  }

  defend(socketId, cardId) {
    if (this.state !== 'playing' || this.getDefender().socketId !== socketId) return { error: 'Не ваш ход' };
    const target = this.table.find(t => !t.beaten);
    if (!target) return { error: 'Нечего бить' };

    const p = this.getDefender();
    const card = p.hand.find(c => c.id === cardId);
    if (!card || !canDefend(target.card, card, this.trump)) return { error: 'Не бьёт' };

    p.hand = p.hand.filter(c => c.id !== cardId);
    target.beaten = true;
    target.beatenBy = card;
    this.pushLog(`🛡️ ${p.name} отбился: ${card.rank}${card.suit}`);
    
    if (allBeaten(this.table) && this.table.length >= MAX_TABLE) {
      this.endRound(false);
    } else {
      this.resetTurnTimer();
      this.broadcast();
    }
    return { ok: true };
  }

  translate(socketId, cardId) {
    if (this.state !== 'playing' || this.getDefender().socketId !== socketId) return { error: 'Не ваш ход' };
    const p = this.getDefender();
    const unbeaten = this.table.find(t => !t.beaten);
    if (!unbeaten) return { error: 'Нет карты для перевода' };
    
    const card = p.hand.find(c => c.id === cardId);
    if (!card || !canTranslate(p.hand, unbeaten.card, this.trump)) return { error: 'Перевод невозможен' };

    p.hand = p.hand.filter(c => c.id !== cardId);
    this.table.push({ card, beaten: false, beatenBy: null });
    
    const oldA = this.attackerIdx;
    this.attackerIdx = this.defenderIdx;
    this.defenderIdx = oldA;
    
    this.pushLog(`🔄 ${p.name} перевел!`);
    this.resetTurnTimer();
    this.broadcast();
    return { ok: true };
  }

  take(socketId) {
    if (this.state !== 'playing' || this.getDefender().socketId !== socketId) return { error: 'Не ваш ход' };
    if (this.table.length === 0) return { error: 'Пусто' };

    const p = this.getDefender();
    this.table.forEach(t => {
      p.hand.push(t.card);
      if (t.beatenBy) p.hand.push(t.beatenBy);
    });
    this.table = [];
    this.pushLog(`📥 ${p.name} забирает карты`);
    this.endRound(true);
    return { ok: true };
  }

  pass(socketId) {
    if (this.state !== 'playing' || this.getAttacker().socketId !== socketId) return { error: 'Не ваш ход' };
    if (!allBeaten(this.table)) return { error: 'Есть непобитые' };
    this.table = [];
    this.pushLog(`✅ Бито!`);
    this.endRound(false);
    return { ok: true };
  }

  endRound(defenderTook) {
    const drawToMax = (p) => {
      while (p.hand.length < MAX_HAND && this.deck.length > 0) p.hand.push(...draw(this.deck, 1));
    };

    if (defenderTook) {
      drawToMax(this.getAttacker());
      drawToMax(this.getDefender());
    } else {
      const oldA = this.attackerIdx;
      this.attackerIdx = this.defenderIdx;
      this.defenderIdx = oldA;
      drawToMax(this.getAttacker());
      drawToMax(this.getDefender());
    }

    this.turnPhase = 'attack';

    if (this.deck.length === 0) {
      const empty = this.players.find(p => p.hand.length === 0);
      if (empty) {
        const loser = this.players.find(p => p.hand.length > 0);
        if (loser) return this.finish(empty.socketId, `${loser.name} — дурак!`);
      }
    }

    this.resetTurnTimer();
    this.broadcast();
  }

  finish(winnerId, msg) {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.state = 'finished';
    this.winnerId = winnerId;
    this.pushLog(`🏆 ${msg}`);
    
    this.io.to(this.id).emit('game_over', {
      winnerId, message: msg,
      players: this.players.map(p => ({ name: p.name, cards: p.hand.length }))
    });
    this.broadcast();
  }

  // ОПТИМИЗИРОВАННАЯ РАССЫЛКА
  broadcast() {
    for (const p of this.players) {
      if (!p.connected) continue;
      const idx = this.players.indexOf(p);
      
      // Оптимизация: отправляем только актуальные данные
      const state = {
        roomId: this.id,
        state: this.state,
        trump: this.trump,
        deck: this.deck.length,
        table: this.table,
        timeLeft: this.turnStartedAt ? Math.max(0, Math.ceil((TURN_TIMEOUT_MS - (Date.now() - this.turnStartedAt)) / 1000)) : 0,
        you: {
          name: p.name,
          hand: p.hand,
          role: idx === this.attackerIdx ? 'atk' : idx === this.defenderIdx ? 'def' : 'spec'
        },
        opps: this.players.filter(o => o !== p).map(o => ({
          name: o.name,
          count: o.hand.length,
          role: this.players.indexOf(o) === this.attackerIdx ? 'atk' : this.players.indexOf(o) === this.defenderIdx ? 'def' : 'spec'
        })),
        log: this.log.slice(-8)
      };
      
      this.io.to(p.socketId).emit('state', state);
    }
  }
}
module.exports = { Room };