// public/client.js
// ============================================================
//  КЛИЕНТ: Socket.IO + UI
// ============================================================
const socket = io({
  reconnection: true,
  reconnectionAttempts: 15,
  reconnectionDelay: 500,
  transports: ['websocket', 'polling']
});

const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const game = $('game');
const nameInput = $('nameInput');
const codeInput = $('codeInput');
const passwordInput = $('passwordInput');
const createBtn = $('createBtn');
const joinBtn = $('joinBtn');
const listBtn = $('listBtn');
const lobbyError = $('lobbyError');
const createModal = $('createModal');
const listModal = $('listModal');
const newPassword = $('newPassword');
const newMaxPlayers = $('newMaxPlayers');
const confirmCreate = $('confirmCreate');
const cancelCreate = $('cancelCreate');
const roomsList = $('roomsList');
const refreshList = $('refreshList');
const closeList = $('closeList');

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
const translateBtn = $('translateBtn');
const leaveBtn = $('leaveBtn');
const chatInput = $('chatInput');
const chatSend = $('chatSend');
const chatMessages = $('chatMessages');
const toast = $('toast');

let myState = null;
let selectedCardId = null;
let currentRoomId = null;
let sessionId = localStorage.getItem('durak_session');

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

// ===== Сессия =====
socket.on('connect', () => {
  if (sessionId) {
    socket.emit('restore_session', { sessionId }, (res) => {
      if (res.ok) {
        currentRoomId = res.roomId;
        nameInput.value = res.name;
        showScreen(game);
        toastMsg('Сессия восстановлена');
      }
    });
  }
});

socket.on('state', (state) => {
  myState = state;
  currentRoomId = state.roomId;
  renderState(state);
  showScreen(game);
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
  const div = document.createElement('div');
  div.innerHTML = `<b>${msg.name}:</b> ${msg.text}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ===== Лобби =====
function getPlayerName() {
  const name = (nameInput.value || '').trim() || 'Игрок';
  localStorage.setItem('durak_name', name);
  return name.slice(0, 14);
}

createBtn.onclick = () => {
  lobbyError.textContent = '';
  if (!getPlayerName()) return;
  createModal.classList.add('active');
};

cancelCreate.onclick = () => createModal.classList.remove('active');

confirmCreate.onclick = () => {
  const name = getPlayerName();
  const password = newPassword.value || '';
  const maxPlayers = parseInt(newMaxPlayers.value, 10) || 2;

  socket.emit('create_room', { name, password, maxPlayers }, (res) => {
    if (res.error) {
      toastMsg(res.error);
      return;
    }
    currentRoomId = res.roomId;
    sessionId = res.sessionId;
    localStorage.setItem('durak_session', sessionId);
    createModal.classList.remove('active');
    showScreen(game);
    toastMsg(`Стол создан: ${res.roomId}`);
    youName.textContent = name;
  });
};

joinBtn.onclick = () => {
  lobbyError.textContent = '';
  const name = getPlayerName();
  const code = (codeInput.value || '').trim().toUpperCase();
  const password = passwordInput.value || '';

  if (code.length !== 6) {
    lobbyError.textContent = 'Код из 6 символов';
    return;
  }

  socket.emit('join_room', { roomId: code, name, password }, (res) => {
    if (res.error) {
      lobbyError.textContent = res.error;
      return;
    }
    if (res.sessionId) {
      sessionId = res.sessionId;
      localStorage.setItem('durak_session', sessionId);
    }
    currentRoomId = code;
    showScreen(game);
    youName.textContent = name;
    toastMsg(res.reconnected ? 'Переподключение' : 'Вы за столом');
  });
};

listBtn.onclick = () => {
  listModal.classList.add('active');
  loadRooms();
};

closeList.onclick = () => listModal.classList.remove('active');
refreshList.onclick = () => loadRooms();

function loadRooms() {
  socket.emit('list_rooms', (res) => {
    roomsList.innerHTML = '';
    if (!res.rooms.length) {
      roomsList.innerHTML = '<p style="color:#8892a8;text-align:center">Нет активных комнат</p>';
      return;
    }
    for (const r of res.rooms) {
      const div = document.createElement('div');
      div.className = 'room-item';
      div.innerHTML = `
        <b>${r.id}</b>
        <span style="color:#8892a8"> · ${r.players}/${r.maxPlayers} игроков</span>
        ${r.hasPassword ? '<span class="lock"> 🔒</span>' : ''}
      `;
      div.onclick = () => {
        codeInput.value = r.id;
        listModal.classList.remove('active');
        if (r.hasPassword) {
          passwordInput.focus();
          toastMsg('Введите пароль');
        } else {
          joinBtn.click();
        }
      };
      roomsList.appendChild(div);
    }
  });
}

nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });
passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

// ===== Рендер =====
function renderState(state) {
  const trumpSuit = state.trump;
  trumpCard.textContent = trumpSuit || '?';
  trumpCard.className = 'trump ' + (isRed(trumpSuit) ? 'red' : 'black');
  deckCount.textContent = state.deckCount;

  const opp = state.opponents[0];
  oppName.textContent = opp ? opp.name : '—';
  oppCards.textContent = opp ? opp.handCount : 0;
  oppRole.textContent = opp
    ? (opp.role === 'attacker' ? 'Атакует' : opp.role === 'defender' ? 'Защищается' : '—')
    : '—';

  youRole.textContent = state.you.role === 'attacker' ? 'Атака'
                      : state.you.role === 'defender' ? 'Защита' : '—';

  renderTable(state);
  renderHand(state);

  const isMyAttack = state.you.role === 'attacker';
  const isMyDefense = state.you.role === 'defender';
  const hasUnbeaten = state.table.some(t => !t.beaten);
  const tableEmpty = state.table.length === 0;

  takeBtn.disabled = !(isMyDefense && hasUnbeaten);
  passBtn.disabled = !(isMyAttack && !tableEmpty && !hasUnbeaten);
  translateBtn.disabled = !(isMyDefense && hasUnbeaten);

  if (state.log) {
    gameLog.innerHTML = '';
    state.log.forEach(l => {
      const div = document.createElement('div');
      div.textContent = l.text;
      gameLog.appendChild(div);
    });
  }
}

function renderTable(state) {
  tableCards.innerHTML = '';
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
  const maxTableReached = state.table.length >= 6;

  state.you.hand.forEach((card) => {
    const el = makeCardEl(card);

    let playable = false;
    let actionType = null;

    if (isMyAttack) {
      if (state.table.length === 0) { playable = true; actionType = 'attack'; }
      else if (!maxTableReached && tableRanks.has(card.rank)) { playable = true; actionType = 'throw_in'; }
    } else if (isMyDefense && unbeaten) {
      if (canBeatClient(card, unbeaten.card, state.trump)) { playable = true; actionType = 'defend'; }
      else if (canTranslateClient(card, unbeaten.card, state.trump)) { playable = true; actionType = 'translate'; }
    }

    if (!playable) el.classList.add('disabled');

    el.onclick = () => {
      if (!playable) return;
      socket.emit('game_action', { action: actionType, cardId: card.id }, (res) => {
        if (res && res.error) toastMsg(res.error);
      });
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

function canTranslateClient(card, attackCard, trump) {
  return card.rank === attackCard.rank && canBeatClient(card, attackCard, trump);
}

// ===== Кнопки действий =====
takeBtn.onclick = () => socket.emit('game_action', { action: 'take' }, (r) => { if (r?.error) toastMsg(r.error); });
passBtn.onclick = () => socket.emit('game_action', { action: 'pass' }, (r) => { if (r?.error) toastMsg(r.error); });
translateBtn.onclick = () => {
  toastMsg('Выберите карту для перевода');
};

leaveBtn.onclick = () => {
  if (confirm('Выйти из игры?')) {
    localStorage.removeItem('durak_session');
    location.reload();
  }
};

// ===== Чат =====
chatSend.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat', { text });
  chatInput.value = '';
};
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') chatSend.click();
});

// ===== Восстановление =====
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('durak_name');
  if (saved) nameInput.value = saved;

  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  if (code) {
    codeInput.value = code.toUpperCase();
    toastMsg('Введите имя и пароль (если нужен)', 4000);
  }
});