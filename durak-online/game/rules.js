// game/rules.js
const { beats } = require('./deck');
const { MAX_TABLE } = require('./constants');

function canAttack(card, table) {
  if (table.length === 0) return true;
  return table.some(t => t.card.rank === card.rank);
}

function canThrowIn(card, table) {
  if (table.length === 0 || table.length >= MAX_TABLE) return false;
  return table.some(t => t.card.rank === card.rank);
}

function canDefend(attackCard, defendCard, trump) {
  return beats(defendCard, attackCard, trump);
}

function allBeaten(table) {
  return table.length > 0 && table.every(t => t.beaten);
}

function canTranslate(hand, attackCard, trump) {
  return hand.some(c => c.rank === attackCard.rank && beats(c, attackCard, trump));
}

module.exports = { canAttack, canThrowIn, canDefend, allBeaten, canTranslate };