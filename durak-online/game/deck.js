// game/deck.js
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const RANK_WEIGHT = Object.freeze({
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14
});

const CARD_POINTS = Object.freeze({
  '6': 1, '7': 2, '8': 3, '9': 4, '10': 5,
  'J': 6, 'Q': 7, 'K': 8, 'A': 10
});

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}${suit}` });
    }
  }
  return deck;
}

function shuffle(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function draw(deck, n) {
  return deck.splice(0, n);
}

function beats(a, b, trump) {
  if (!a || !b) return false;
  const aTrump = a.suit === trump;
  const bTrump = b.suit === trump;
  if (aTrump && !bTrump) return true;
  if (!aTrump && bTrump) return false;
  if (a.suit === b.suit) return RANK_WEIGHT[a.rank] > RANK_WEIGHT[b.rank];
  return false;
}

function handPoints(hand) {
  return hand.reduce((sum, card) => sum + (CARD_POINTS[card.rank] || 0), 0);
}

module.exports = { createDeck, shuffle, draw, beats, handPoints, CARD_POINTS };