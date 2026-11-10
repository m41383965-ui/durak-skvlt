// game/deck.js
// Масти и ранги. Козырь определяется последней картой колоды.
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Веса для сравнения карт
const RANK_WEIGHT = {
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}${suit}` });
    }
  }
  return deck;
}

// Тасовка Фишера-Йетса
function shuffle(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Раздать n карт из колоды (мутирует колоду)
function draw(deck, n) {
  return deck.splice(0, n);
}

// Сравнение карт: бьёт ли a карту b при козыре trump
function beats(a, b, trump) {
  if (!a || !b) return false;
  const aTrump = a.suit === trump;
  const bTrump = b.suit === trump;

  if (aTrump && !bTrump) return true;
  if (!aTrump && bTrump) return false;

  if (a.suit === b.suit) {
    return RANK_WEIGHT[a.rank] > RANK_WEIGHT[b.rank];
  }
  return false;
}

module.exports = {
  SUITS, RANKS, RANK_WEIGHT,
  createDeck, shuffle, draw, beats
};