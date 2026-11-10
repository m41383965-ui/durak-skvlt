// public/client.js
const socket = io({
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 500
});

// ====== DOM ======
const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const game = $('game');
const nameInput = $('nameInput');
const codeInput = $('codeInput');
const createBtn = $('createBtn');
const joinBtn = $('joinBtn');
const lobbyError = $('lobbyError');

const oppName = $('oppName');
const oppCards = $('oppCards');
const oppRole = $('oppRole');
const youName = $('youName');
const youRole = $('youRole');
const trumpCard = $('trumpCard');
const deckCount = $('deckCount');
const tableCards = $('tableCards');
const handEl = $('hand');
const gameLog = $('gameLog');
const takeBtn = $('takeBtn');
const passBtn = $('passBtn');
const leaveBtn = $('leaveBtn');
const toast = $('toast');

// ====== Состояние ======
let myState = null;
let selectedCardIdx = null;
let currentRoomId = null;

// ====== Утилиты ======
function toastMsg(text, ms = 2200) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), ms);
}

function showScreen(el) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}

function isRed(suit) { return suit === '♥' || suit === '♦'; }

// ====== Рендер карты ======
function makeCardEl(card, opts = {}) {
  const el = document.createElement('div');
  el.className = `card ${isRed(card.suit) ? 'red' : 'black'}`;
  if (opts.extraClass) el.classList.add(...opts.extraClass.split(' '));
  if (opts.back) {
    el.className = 'card back';
    return el;
  }
  el.innerHTML = `
    <div class="rank">${card.rank}</div>
    <div class="big-suit">${card.suit}</div>
    <div class="suit">${card.suit}</div>
  `;
  return el;
}

// ====== Лобби ======
function getPlayerName() {
  const name = (nameInput.value || '').trim() || 'Игрок';
  localStorage.setItem('durak_name', name);
  return name.slice(0, 14);
}

createBtn.onclick = () => {
  lobbyError.textContent = '';
  const name = getPlayerName();
  createBtn.disabled = true;
  socket.emit('create_room', { name }, (res) => {
    createBtn.disabled = false;
    if (res.error) return (lobbyError.textContent = res.error);
    currentRoomId = res.roomId;
    showScreen(game);
    toastMsg(`Стол создан: ${res.roomId}`);
    copyToClipboard(res.roomId);
    youName.textContent = name;
  });
};

joinBtn.onclick = () => {
  lobbyError.textContent = '';
  const name = getPlayerName();
  const code = (codeInput.value || '').trim().toUpperCase();
  if (code.length !== 6) return (lobbyError.textContent = 'Код из 6 символов');
  joinBtn.disabled = true;
  socket.emit('join_room', { roomId: code, name }, (res) => {
    joinBtn.disabled = false;
    if (res.error) return (lobbyError.textContent = res.error);
    currentRoomId = code;
    showScreen(game);
    youName.textContent = name;
    toastMsg(res.reconnected ? 'Переподключение' : 'Вы за столом');
  });
};

nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

// ====== Игровые события ======
socket.on('state', (state) => {
  myState = state;
  renderState(state);
});

socket.on('game_over', (data) => {
  const overlay = $('gameOver');
  const youWin = data.winnerId === socket.id;
  $('overEmoji').textContent = youWin ? '🏆' : '💩';
  $('overTitle').textContent = youWin ? 'ПОБЕДА!' : 'ДУРАК 😅';
  $('overMsg').textContent = data.message;
  overlay.classList.add('active');
});

socket.on('chat', (msg) => {
  appendLog(`${msg.name}: ${msg.text}`);
});

socket.on('connect', () => {
  // Пытаемся переподключиться в комнату
  if (currentRoomId && myState && myState.you) {
    socket.emit('join_room', {
      roomId: currentRoomId,
      name: myState.you.name
    }, (res) => {
      if (res && res.reconnected) toastMsg('Переподключено');
    });
  }
});

socket.on('disconnect', () => {
  toastMsg('Соединение потеряно...', 4000);
});

// ====== Рендер состояния ======
function renderState(state) {
  // Козырь
  const trumpSuit = state.trump;
  trumpCard.textContent = trumpSuit;
  trumpCard.className = 'trump ' + (isRed(trumpSuit) ? 'red' : 'black');
  deckCount.textContent = state.deckCount;

  // Соперник
  oppName.textContent = state.opponent.name;
  oppCards.textContent = state.opponent.handCount;
  oppRole.textContent = state.opponent.role === 'attacker' ? 'Атакует' : 'Защищается';

  // Игрок
  youRole.textContent = state.you.role === 'attacker' ? 'Атака' : 'Защита';

  // Стол
  renderTable(state);

  // Рука
  renderHand(state);

  // Кнопки
  const isMyAttack = state.you.role === 'attacker';
  const isMyDefense = state.you.role === 'defender';
  const hasUnbeaten = state.table.some(t => !t.beaten);

  takeBtn.disabled = !(isMyDefense && hasUnbeaten);
  passBtn.disabled = !(isMyAttack && state.table.length > 0 && !hasUnbeaten);

  // Лог
  if (state.log) {
    gameLog.innerHTML = '';
    state.log.forEach(l => appendLog(l));
  }
}

function renderTable(state) {
  tableCards.innerHTML = '';
  const pairs = [];
  for (const t of state.table) {
    const pair = document.createElement('div');
    pair.className = 'table-pair';
    const attackCard = makeCardEl(t.card, { extraClass: 'table-card' });
    attackCard.classList.add('attack');
    pair.appendChild(attackCard);

    if (t.beaten && t.beatenBy) {
      const defCard = makeCardEl(t.beatenBy, { extraClass: 'table-card defense' });
      defCard.classList.add('beaten');
      pair.appendChild(defCard);
    }
    tableCards.appendChild(pair);
  }
}

function renderHand(state) {
  handEl.innerHTML = '';
  const isMyAttack = state.you.role === 'attacker';
  const isMyDefense = state.you.role === 'defender';
  const hasUnbeaten = state.table.some(t => !t.beaten);

  const tableRanks = new Set(state.table.map(t => t.card.rank));
  const unbeaten = state.table.find(t => !t.beaten);

  state.you.hand.forEach((card, idx) => {
    const el = makeCardEl(card);
    // Определяем, можно ли сыграть
    let playable = false;
    if (isMyAttack) {
      if (state.table.length === 0) playable = true;
      else if (!hasUnbeaten) playable = tableRanks.has(card.rank);
    } else if (isMyDefense && unbeaten) {
      playable = canBeatClient(card, unbeaten.card, state.trump);
    }

    if (!playable) el.classList.add('disabled');

    el.onclick = () => {
      if (!playable) return;
      if (selectedCardIdx === idx) {
        // Второй клик — сыграть
        playCard(idx, isMyAttack ? 'attack' : 'defend');
        selectedCardIdx = null;
      } else {
        selectedCardIdx = idx;
        // Снимаем выделение
        [...handEl.children].forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        // Автоход при защите
        if (isMyDefense) {
          setTimeout(() => {
            if (selectedCardIdx === idx) playCard(idx, 'defend');
            selectedCardIdx = null;
          }, 250);
        }
      }
    };

    handEl.appendChild(el);
  });
}

function canBeatClient(a, b, trump) {
  const W = { '6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
  const aT = a.suit === trump, bT = b.suit === trump;
  if (aT && !bT) return true;
  if (!aT && bT) return false;
  if (a.suit === b.suit) return W[a.rank] > W[b.rank];
  return false;
}

function playCard(idx, action) {
  socket.emit('game_action', { action, cardIndex: idx }, (res) => {
    if (res && res.error) toastMsg(res.error);
  });
}

takeBtn.onclick = () => {
  socket.emit('game_action', { action: 'take' }, (res) => {
    if (res && res.error) toastMsg(res.error);
  });
};

passBtn.onclick = () => {
  socket.emit('game_action', { action: 'pass' }, (res) => {
    if (res && res.error) toastMsg(res.error);
  });
};

leaveBtn.onclick = () => {
  if (confirm('Выйти из игры?')) location.reload();
};

function appendLog(text) {
  const div = document.createElement('div');
  div.textContent = text;
  gameLog.appendChild(div);
  while (gameLog.children.length > 5) gameLog.removeChild(gameLog.firstChild);
}

// ====== Восстановление имени ======
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('durak_name');
  if (saved) nameInput.value = saved;
  // Восстановление комнаты из URL
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  if (code) {
    codeInput.value = code.toUpperCase();
    toastMsg('Введите имя и нажмите "Войти в игру"', 4000);
  }
});