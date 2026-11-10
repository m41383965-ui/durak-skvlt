// game/room.js
// ============================================================
//  ИГРОВАЯ КОМНАТА: ПОЛНЫЙ ЦИКЛ ИГРЫ
// ============================================================
const { createDeck, shuffle, draw, beats } = require('./deck');
const {
  canAttack,
  canThrowIn,
  canDefend,
  allBeaten,
  canTranslate,
  cardInHand,
  canPlayerAttack
} = require('./rules');

// Константы правил
const MAX_HAND = 6;
const MAX_TABLE_CARDS = 6;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

class Room {
  constructor(id, io, options = {}) {
    this.id = id;
    this.io = io;
    this.passwordHash = options.passwordHash || null;
    this.passwordSalt = options.passwordSalt || null;
    this.requirePassword = !!options.passwordHash;

    this.players = [];       // [{ socketId, name, hand, connected, ready }]
    this.deck = [];
    this.trump = null;
    this.table = [];         // [{ card, attack, beaten, beatenBy, byPlayer }]
    this.discardPile = [];
    this.attackerIdx = 0;
    this.defenderIdx = 1;
    this.state = 'waiting';  // waiting | playing | finished
    this.log = [];
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.finishedAt = null;
    this.winnerId = null;
    this.maxPlayers = options.maxPlayers || MIN_PLAYERS;
    this.turnPhase = 'attack'; // attack | defend | finished
  }

  // ===== Управление игроками =====
  addPlayer(socketId, name) {
    if (this.state === 'finished') {
      return { error: 'Игра уже завершена' };
    }
    if (this.players.length >= this.maxPlayers) {
      return { error: 'Стол заполнен' };
    }
    if (this.players.find(p => p.socketId === socketId)) {
      return { error: 'Вы уже за столом' };
    }
    if (this.players.find(p => p.name === name)) {
      return { error: 'Такое имя уже занято за столом' };
    }

    this.players.push({
      socketId,
      name: name || `Игрок ${this.players.length + 1}`,
      hand: [],
      connected: true,
      ready: false
    });

    this.lastActivity = Date.now();
    this.pushLog(`${name} вошёл за стол`);
    return { ok: true };
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.socketId === socketId);
    if (idx === -1) return;

    this.players[idx].connected = false;
    this.pushLog(`${this.players[idx].name} отключился`);

    if (this.state === 'playing') {
      // Если игрок отключился во время игры — засчитываем поражение
      const winner = this.players.find((_, i) => i !== idx);
      if (winner) {
        this.finish(winner.socketId, `Соперник отключился`);
      }
    }
    this.lastActivity = Date.now();
  }

  reconnectPlayer(socketId, name) {
    const p = this.players.find(x => x.name === name && !x.connected);
    if (p) {
      p.socketId = socketId;
      p.connected = true;
      this.pushLog(`${name} переподключился`);
      return p;
    }
    return null;
  }

  // ===== Запуск игры =====
  start() {
    if (this.state !== 'waiting') {
      return { error: 'Игра уже идёт или завершена' };
    }
    if (this.players.length < MIN_PLAYERS) {
      return { error: `Нужно минимум ${MIN_PLAYERS} игрока` };
    }
    if (this.players.length > this.maxPlayers) {
      return { error: `Максимум ${this.maxPlayers} игроков` };
    }

    this.deck = shuffle(createDeck());
    this.trump = this.deck[this.deck.length - 1].suit;

    for (const p of this.players) {
      p.hand = draw(this.deck, MAX_HAND);
    }

    // Первый атакующий — случайный
    this.attackerIdx = Math.floor(Math.random() * this.players.length);
    this.defenderIdx = (this.attackerIdx + 1) % this.players.length;

    this.table = [];
    this.state = 'playing';
    this.turnPhase = 'attack';
    this.pushLog(`Игра началась! Козырь: ${this.trump}`);
    this.pushLog(`Атакует: ${this.getAttacker().name}, защищается: ${this.getDefender().name}`);

    this.broadcastState();
    return { ok: true };
  }

  // ===== Вспомогательные =====
  getAttacker() { return this.players[this.attackerIdx]; }
  getDefender() { return this.players[this.defenderIdx]; }
  getPlayer(socketId) { return this.players.find(p => p.socketId === socketId); }

  pushLog(text) {
    const entry = { ts: Date.now(), text };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
  }

  // ===== Действия игроков =====

  // Атака картой
  attack(socketId, cardId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const attacker = this.getAttacker();
    if (attacker.socketId !== socketId) return { error: 'Сейчас не ваш ход' };
    if (!canPlayerAttack(this.table, MAX_TABLE_CARDS)) {
      return { error: 'На столе уже максимум карт' };
    }

    const card = attacker.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Нет такой карты' };

    if (!canAttack(card, this.table)) {
      return { error: 'Нельзя атаковать этой картой' };
    }

    attacker.hand = attacker.hand.filter(c => c.id !== cardId);
    this.table.push({
      card,
      attack: true,
      beaten: false,
      beatenBy: null,
      byPlayer: attacker.name
    });

    this.pushLog(`${attacker.name} атакует ${card.rank}${card.suit}`);
    this.turnPhase = 'defend';
    this.lastActivity = Date.now();
    this.broadcastState();
    return { ok: true };
  }

  // Подкидывание (для не-атакующего или для атакующего во второй фазе)
  throwIn(socketId, cardId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const player = this.getPlayer(socketId);
    if (!player) return { error: 'Вы не за столом' };

    if (this.table.length >= MAX_TABLE_CARDS) {
      return { error: 'На столе уже максимум карт' };
    }

    const card = player.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Нет такой карты' };

    if (!canThrowIn(card, this.table, MAX_TABLE_CARDS)) {
      return { error: 'Нельзя подкинуть эту карту' };
    }

    // Подкидывать может любой игрок, кроме защитника
    if (socketId === this.getDefender().socketId) {
      return { error: 'Защитник не может подкидывать' };
    }

    player.hand = player.hand.filter(c => c.id !== cardId);
    this.table.push({
      card,
      attack: true,
      beaten: false,
      beatenBy: null,
      byPlayer: player.name
    });

    this.pushLog(`${player.name} подкидывает ${card.rank}${card.suit}`);
    this.lastActivity = Date.now();
    this.broadcastState();
    return { ok: true };
  }

  // Защита
  defend(socketId, cardId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const defender = this.getDefender();
    if (defender.socketId !== socketId) return { error: 'Сейчас не ваш ход' };

    const target = this.table.find(t => !t.beaten);
    if (!target) return { error: 'Нечего отбивать' };

    const card = defender.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Нет такой карты' };

    if (!canDefend(target.card, card, this.trump)) {
      return { error: 'Эта карта не бьёт' };
    }

    defender.hand = defender.hand.filter(c => c.id !== cardId);
    target.beaten = true;
    target.beatenBy = card;

    this.pushLog(`${defender.name} отбивает ${target.card.rank}${target.card.suit} картой ${card.rank}${card.suit}`);
    this.lastActivity = Date.now();
    this.broadcastState();
    return { ok: true };
  }

  // Перевод (переводной дурак)
  translate(socketId, cardId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const defender = this.getDefender();
    if (defender.socketId !== socketId) return { error: 'Переводить может только защитник' };

    const unbeaten = this.table.find(t => !t.beaten);
    if (!unbeaten) return { error: 'Нет карты для перевода' };

    const card = defender.hand.find(c => c.id === cardId);
    if (!card) return { error: 'Нет такой карты' };

    if (!canTranslate(defender.hand, unbeaten.card, this.trump)) {
      return { error: 'Нельзя перевести этой картой' };
    }

    // Меняемся ролями: защитник становится атакующим
    const oldAttacker = this.getAttacker();
    const oldDefender = this.getDefender();

    // Кладём карту на стол как новую атаку
    defender.hand = defender.hand.filter(c => c.id !== cardId);
    this.table.push({
      card,
      attack: true,
      beaten: false,
      beatenBy: null,
      byPlayer: defender.name
    });

    // Меняем индексы
    this.attackerIdx = this.players.indexOf(defender);
    this.defenderIdx = this.players.indexOf(oldAttacker);

    this.pushLog(`${oldDefender.name} переводит на ${oldAttacker.name} картой ${card.rank}${card.suit}`);
    this.lastActivity = Date.now();
    this.broadcastState();
    return { ok: true };
  }

  // Взять карты (защитник)
  take(socketId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const defender = this.getDefender();
    if (defender.socketId !== socketId) return { error: 'Взять может только защитник' };
    if (this.table.length === 0) return { error: 'Стол пуст' };

    // Все карты со стола + побитые забирает защитник
    for (const t of this.table) {
      defender.hand.push(t.card);
      if (t.beatenBy) defender.hand.push(t.beatenBy);
    }
    this.table = [];
    this.pushLog(`${defender.name} забирает карты`);

    this.endRound(true);
    return { ok: true };
  }

  // Бито (атакующий)
  pass(socketId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const attacker = this.getAttacker();
    if (attacker.socketId !== socketId) return { error: 'Бито может сказать только атакующий' };
    if (this.table.length === 0) return { error: 'Стол пуст' };
    if (!allBeaten(this.table)) return { error: 'Есть непобитые карты' };

    this.pushLog(`${attacker.name}: Бито!`);
    this.table = [];

    this.endRound(false);
    return { ok: true };
  }

  // ===== Завершение раунда =====
  endRound(defenderTook) {
    const drawToMax = (player) => {
      while (player.hand.length < MAX_HAND && this.deck.length > 0) {
        player.hand.push(...draw(this.deck, 1));
      }
    };

    if (defenderTook) {
      // Защитник забрал — атакующий остаётся
      drawToMax(this.getAttacker());
      drawToMax(this.getDefender());
    } else {
      // Отбился — роли меняются
      const oldAttacker = this.attackerIdx;
      this.attackerIdx = this.defenderIdx;
      this.defenderIdx = oldAttacker;
      drawToMax(this.getAttacker());
      drawToMax(this.getDefender());
    }

    this.turnPhase = 'attack';

    // Проверка на победу
    if (this.deck.length === 0) {
      const empty = this.players.find(p => p.hand.length === 0);
      if (empty) {
        const winner = this.players.find(p => p !== empty);
        if (winner) {
          this.finish(winner.socketId, `${empty.name} остался без карт (дурак)`);
          return;
        }
      }
    }

    this.broadcastState();
  }

  // ===== Завершение игры =====
  finish(winnerSocketId, message) {
    this.state = 'finished';
    this.finishedAt = Date.now();
    this.winnerId = winnerSocketId;
    this.pushLog(message);

    this.io.to(this.id).emit('game_over', {
      winnerId: winnerSocketId,
      message,
      players: this.players.map(p => ({
        name: p.name,
        socketId: p.socketId,
        cardsLeft: p.hand.length
      }))
    });

    this.broadcastState();
  }

  // ===== Состояние для клиента =====
  buildStateFor(player) {
    const idx = this.players.indexOf(player);
    const others = this.players.filter(p => p !== player);
    return {
      roomId: this.id,
      state: this.state,
      trump: this.trump,
      deckCount: this.deck.length,
      table: this.table.map(t => ({
        card: t.card,
        beaten: t.beaten,
        beatenBy: t.beatenBy,
        byPlayer: t.byPlayer
      })),
      turnPhase: this.turnPhase,
      you: {
        name: player.name,
        hand: player.hand,
        role: idx === this.attackerIdx ? 'attacker'
            : idx === this.defenderIdx ? 'defender'
            : 'spectator',
        connected: player.connected
      },
      opponents: others.map(p => ({
        name: p.name,
        handCount: p.hand.length,
        role: this.players.indexOf(p) === this.attackerIdx ? 'attacker'
            : this.players.indexOf(p) === this.defenderIdx ? 'defender'
            : 'spectator'
      })),
      maxPlayers: this.maxPlayers,
      log: this.log.slice(-10)
    };
  }

  broadcastState() {
    for (const p of this.players) {
      if (p.connected) {
        this.io.to(p.socketId).emit('state', this.buildStateFor(p));
      }
    }
    // Общий лог для лобби
    this.io.to(this.id).emit('room_log', this.log.slice(-20));
  }

  // ===== Сериализация для списка комнат =====
  toPublicInfo() {
    return {
      id: this.id,
      players: this.players.length,
      maxPlayers: this.maxPlayers,
      state: this.state,
      hasPassword: this.requirePassword,
      createdAt: this.createdAt
    };
  }
}

module.exports = { Room, MIN_PLAYERS, MAX_PLAYERS, MAX_HAND, MAX_TABLE_CARDS };