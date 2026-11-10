// public/client.js
const socket = io({ reconnection: true, reconnectionAttempts: 10 });

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');

// Переключение табов
$('tabJoin').onclick = () => {
  $('tabJoin').classList.add('active'); $('tabCreate').classList.remove('active');
  $('formJoin').classList.add('active'); $('formCreate').classList.remove('active');
  $('errorMsg').textContent = '';
};
$('tabCreate').onclick = () => {
  $('tabCreate').classList.add('active'); $('tabJoin').classList.remove('active');
  $('formCreate').classList.add('active'); $('formJoin').classList.remove('active');
  $('errorMsg').textContent = '';
};

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

function showScreen(el) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}

// СОЗДАНИЕ
$('btnCreate').onclick = () => {
  const name = $('createName').value.trim();
  const master = $('createMaster').value;
  const pass = $('createPass').value;
  const max = parseInt($('createMax').value);

  if(!name) return $('errorMsg').textContent = 'Введите имя';
  $('btnCreate').disabled = true;

  socket.emit('create_room', { name, masterPass: master, gamePass: pass, maxPlayers: max }, (res) => {
    $('btnCreate').disabled = false;
    if (res.error) return $('errorMsg').textContent = res.error;
    
    localStorage.setItem('durak_sid', res.sessionId);
    $('youName').textContent = name;
    showScreen(game);
    toast(`Стол создан: ${res.roomId}`);
  });
};

// ВХОД
$('btnJoin').onclick = () => {
  const name = $('joinName').value.trim();
  const code = $('joinCode').value.trim().toUpperCase();
  const pass = $('joinPass').value;

  if(!name || code.length !== 6) return $('errorMsg').textContent = 'Проверьте данные';
  $('btnJoin').disabled = true;

  socket.emit('join_room', { roomId: code, name, password: pass }, (res) => {
    $('btnJoin').disabled = false;
    if (res.error) return $('errorMsg').textContent = res.error;
    
    localStorage.setItem('durak_sid', res.sessionId);
    $('youName').textContent = name;
    showScreen(game);
  });
};

// ВОССТАНОВЛЕНИЕ СЕССИИ
const savedSid = localStorage.getItem('durak_sid');
if (savedSid) {
  socket.emit('restore', { sid: savedSid }, (res) => {
    if (res.ok) {
      $('youName').textContent = res.name;
      showScreen(game);
      toast('Возврат в игру...');
    }
  });
}

// РЕНДЕР ИГРЫ
socket.on('state', (s) => {
  $('trump').textContent = s.trump;
  $('trump').className = `trump ${(s.trump === '♥' || s.trump === '♦') ? 'red' : 'black'}`;
  $('deck').textContent = s.deck;
  $('timer').textContent = s.timeLeft;

  const opp = s.opps[0];
  if (opp) {
    $('oppName').textContent = opp.name;
    $('oppCards').textContent = opp.count;
  }

  $('youRole').textContent = s.you.role === 'atk' ? 'Атака' : s.you.role === 'def' ? 'Защита' : 'Ожидание';

  // Стол
  const tc = $('tableCards');
  tc.innerHTML = '';
  s.table.forEach(t => {
    const pair = document.createElement('div');
    pair.className = 'table-pair';
    const c = createCardEl(t.card, true);
    pair.appendChild(c);
    if(t.beaten && t.beatenBy) {
      const bc = createCardEl(t.beatenBy, true);
      bc.classList.add('defense');
      pair.appendChild(bc);
    }
    tc.appendChild(pair);
  });

  // Рука
  const hc = $('hand');
  hc.innerHTML = '';
  const tableRanks = new Set(s.table.map(t => t.card.rank));
  const unbeaten = s.table.find(t => !t.beaten);

  s.you.hand.forEach(card => {
    const el = createCardEl(card, false);
    
    let canPlay = false;
    let action = '';
    if (s.you.role === 'atk') {
      if (s.table.length === 0) { canPlay = true; action = 'attack'; }
      else if (s.table.length < 6 && tableRanks.has(card.rank)) { canPlay = true; action = 'attack'; }
    } else if (s.you.role === 'def' && unbeaten) {
      if (checkBeat(card, unbeaten.card, s.trump)) { canPlay = true; action = 'defend'; }
      else if (card.rank === unbeaten.card.rank) { canPlay = true; action = 'translate'; }
    }

    if (!canPlay) el.classList.add('disabled');
    el.onclick = () => {
      if(!canPlay) return;
      socket.emit('action', { action, cardId: card.id }, (r) => {
        if(r.error) toast(r.error);
      });
    };
    hc.appendChild(el);
  });

  // Лог
  $('log').innerHTML = s.log.map(l => `<div>${l.text}</div>`).join('');
  
  // Кнопки
  $('btnTake').style.display = (s.you.role === 'def' && s.table.length > 0) ? 'block' : 'none';
  $('btnPass').style.display = (s.you.role === 'atk' && s.table.length > 0) ? 'block' : 'none';
});

function createCardEl(card, isTable) {
  const el = document.createElement('div');
  el.className = `card ${(card.suit === '♥' || card.suit === '♦') ? 'red' : 'black'}`;
  if (isTable) el.classList.add('table-card');
  el.innerHTML = `<div class="rank">${card.rank}</div><div class="big-suit">${card.suit}</div><div class="suit">${card.suit}</div>`;
  return el;
}

function checkBeat(a, b, trump) {
  const W = { '6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
  const aT = a.suit === trump, bT = b.suit === trump;
  if (aT && !bT) return true;
  if (!aT && bT) return false;
  if (a.suit === b.suit) return W[a.rank] > W[b.rank];
  return false;
}

$('btnTake').onclick = () => socket.emit('action', { action: 'take' });
$('btnPass').onclick = () => socket.emit('action', { action: 'pass' });
$('btnLeave').onclick = () => { localStorage.removeItem('durak_sid'); location.reload(); };

socket.on('game_over', (d) => {
  $('overTitle').textContent = d.winnerId === socket.id ? '🏆 ПОБЕДА' : '💩 ДУРАК';
  $('overMsg').textContent = d.message;
  $('over').classList.add('active');
});