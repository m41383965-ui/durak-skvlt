// game/room.js
const { createDeck, shuffle, draw, beats } = require('./deck');
const { canAttack, canThrowIn, canDefend, allBeaten, hasDefense } = require('./rules');

class Room {
  constructor(id, socketIo) {
    this.id = id;
    this.io = socketIo;
    this.players = [];          // [{ socketId, name, hand: [], connected: true }]
    this.deck = [];
    this.trump = null;
    this.table = [];            // [{ card, attack, beaten, beatenBy }]
    this.attackerIdx = 0;       // индекс атакующего в players
    this.defenderIdx = 1;       // индекс защищающегося
    this.discardPile = [];
    this.state = 'waiting';     // waiting | playing | finished
    this.turnPassCount = 0;
    this.maxPlayers = 2;
    this.log = [];
  }

  addPlayer(socketId, name) {
    if (this.players.length >= this.maxPlayers) return { error: 'Стол заполнен' };
    if (this.players.find(p => p.socketId === socketId)) {
      return { error: 'Вы уже за столом' };
    }
    this.players.push({
      socketId,
      name: name || `Игрок ${this.players.length + 1}`,
      hand: [],
      connected: true
    });
    return { ok: true };
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.socketId === socketId);
    if (idx === -1) return;
    this.players[idx].connected = false;
    if (this.state === 'playing') {
      // Если игрок отключился во время игры — техническая победа соперника
      this.finish(this.players[1 - idx].socketId, 'Соперник отключился');
    }
  }

  reconnectPlayer(socketId, name) {
    const p = this.players.find(x => x.name === name && !x.connected);
    if (p) {
      p.socketId = socketId;
      p.connected = true;
      return p;
    }
    return null;
  }

  start() {
    if (this.players.length !== 2) return { error: 'Нужно 2 игрока' };
    this.deck = shuffle(createDeck());
    this.trump = this.deck[this.deck.length - 1].suit; // козырь — нижняя карта
    // Раздача по 6 карт
    for (const p of this.players) {
      p.hand = draw(this.deck, 6);
    }
    // Случайно определяем атакующего (у кого младший козырь — по классике, но упростим)
    this.attackerIdx = Math.floor(Math.random() * 2);
    this.defenderIdx = 1 - this.attackerIdx;
    this.table = [];
    this.state = 'playing';
    this.log.push(`Игра началась. Козырь: ${this.trump}`);
    this.broadcastState();
    return { ok: true };
  }

  // Текущий игрок (атакующий)
  getAttacker() { return this.players[this.attackerIdx]; }
  getDefender() { return this.players[this.defenderIdx]; }

  // Ход: атака картой (индекс в руке атакующего)
  attack(socketId, cardIndex) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const attacker = this.players[this.attackerIdx];
    if (attacker.socketId !== socketId) return { error: 'Сейчас не ваш ход' };

    const card = attacker.hand[cardIndex];
    if (!card) return { error: 'Нет такой карты' };

    // Проверка: можно ли атаковать
    const tableCards = this.table.filter(t => !t.beaten).map(t => t.card);
    if (tableCards.length > 0) {
      // Если идёт добивание — проверяем по рангу
      const ranksOnTable = new Set(this.table.map(t => t.card.rank));
      if (!ranksOnTable.has(card.rank)) {
        return { error: 'Можно подкидывать только карты того же ранга' };
      }
    }

    // Первая карта или подкидывание
    attacker.hand.splice(cardIndex, 1);
    this.table.push({ card, attack: true, beaten: false, beatenBy: null });
    this.log.push(`${attacker.name} атакует ${card.rank}${card.suit}`);

    this.broadcastState();
    return { ok: true };
  }

  // Защита картой (индекс в руке защитника)
  defend(socketId, cardIndex) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const defender = this.players[this.defenderIdx];
    if (defender.socketId !== socketId) return { error: 'Сейчас не ваш ход' };

    // Ищем первую непобитую карту на столе
    const target = this.table.find(t => !t.beaten);
    if (!target) return { error: 'Нечего отбивать' };

    const card = defender.hand[cardIndex];
    if (!card) return { error: 'Нет такой карты' };

    if (!canDefend(target.card, card, this.trump)) {
      return { error: 'Эта карта не бьёт' };
    }

    defender.hand.splice(cardIndex, 1);
    target.beaten = true;
    target.beatenBy = card;
    this.log.push(`${defender.name} отбивает ${card.rank}${card.suit}`);

    this.broadcastState();
    return { ok: true };
  }

  // Защитник говорит «Беру» (забирает все карты со стола)
  take(socketId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const defender = this.players[this.defenderIdx];
    if (defender.socketId !== socketId) return { error: 'Сейчас не ваш ход' };

    // Все карты со стола забирает защитник
    for (const t of this.table) {
      defender.hand.push(t.card);
      if (t.beatenBy) defender.hand.push(t.beatenBy);
    }
    this.log.push(`${defender.name} забирает карты`);
    this.table = [];
    this.turnPassCount = 0;

    this.endRound(true);
    return { ok: true };
  }

  // Атакующий говорит «Бито» (защитник отбился)
  pass(socketId) {
    if (this.state !== 'playing') return { error: 'Игра не идёт' };
    const attacker = this.players[this.attackerIdx];
    if (attacker.socketId !== socketId) return { error: 'Сейчас не ваш ход' };

    if (!allBeaten(this.table)) {
      return { error: 'Есть непобитые карты' };
    }

    this.log.push(`${attacker.name}: Бито!`);
    this.table = [];
    this.turnPassCount = 0;

    this.endRound(false);
    return { ok: true };
  }

  // Завершение раунда: сдвиг ролей, добор карт
  endRound(defenderTook) {
    // Добор до 6
    const drawToSix = (player) => {
      while (player.hand.length < 6 && this.deck.length > 0) {
        player.hand.push(...draw(this.deck, 1));
      }
    };

    if (defenderTook) {
      // Защитник забрал — атакующий остаётся атакующим
      drawToSix(this.players[this.attackerIdx]);
      drawToSix(this.players[this.defenderIdx]);
    } else {
      // Отбился — роли меняются
      this.attackerIdx = 1 - this.attackerIdx;
      this.defenderIdx = 1 - this.defenderIdx;
      drawToSix(this.players[this.attackerIdx]);
      drawToSix(this.players[this.defenderIdx]);
    }

    // Проверка на победу
    const loser = this.players.find(p => p.hand.length === 0);
    if (loser && this.deck.length === 0) {
      const winner = this.players.find(p => p !== loser);
      this.finish(winner.socketId, `${loser.name} остался без карт (дурак)`);
      return;
    }

    this.broadcastState();
  }

  finish(winnerSocketId, message) {
    this.state = 'finished';
    this.log.push(message);
    this.io.to(this.id).emit('game_over', {
      winnerId: winnerSocketId,
      message,
      players: this.players.map(p => ({ name: p.name, socketId: p.socketId }))
    });
    this.broadcastState();
  }

  // Отправка состояния каждому игроку (своя рука — только своя)
  broadcastState() {
    this.players.forEach((p, idx) => {
      const other = this.players[1 - idx];
      const state = {
        roomId: this.id,
        state: this.state,
        trump: this.trump,
        deckCount: this.deck.length,
        table: this.table.map(t => ({
          card: t.card,
          beaten: t.beaten,
          beatenBy: t.beatenBy
        })),
        you: {
          name: p.name,
          hand: p.hand,
          role: idx === this.attackerIdx ? 'attacker' : 'defender'
        },
        opponent: {
          name: other ? other.name : '—',
          handCount: other ? other.hand.length : 0,
          role: other ? (idx === this.attackerIdx ? 'defender' : 'attacker') : null
        },
        log: this.log.slice(-5)
      };
      this.io.to(p.socketId).emit('state', state);
    });
  }
}

module.exports = Room;