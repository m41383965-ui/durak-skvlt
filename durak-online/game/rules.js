// game/rules.js
// ============================================================
//  ПРАВИЛА ДУРАКА (с переводом)
// ============================================================
const { beats, RANK_WEIGHT } = require('./deck');

// Можно ли атаковать картой card при текущем столе
function canAttack(card, table) {
  if (table.length === 0) return true;
  const ranksOnTable = new Set(table.map(t => t.card.rank));
  return ranksOnTable.has(card.rank);
}

// Можно ли подкинуть карту (для подкидывающего)
function canThrowIn(card, table, maxTableCards = 6) {
  if (table.length === 0) return false;
  if (table.length >= maxTableCards) return false;
  const ranksOnTable = new Set(table.map(t => t.card.rank));
  return ranksOnTable.has(card.rank);
}

// Можно ли отбить карту attack картой defend
function canDefend(attack, defend, trump) {
  return beats(defend, attack, trump);
}

// Все ли карты на столе побиты
function allBeaten(table) {
  return table.length > 0 && table.every(t => t.beaten);
}

// Есть ли у защитника чем отбить
function hasDefense(hand, attackCard, trump) {
  return hand.some(c => beats(c, attackCard, trump));
}

// Можно ли перевести (переводной дурак)
// Перевод разрешён, если у защитника есть карта того же ранга,
// которой он может побить атакующую карту
function canTranslate(hand, attackCard, trump) {
  if (hand.length === 0) return false;
  return hand.some(c => c.rank === attackCard.rank && beats(c, attackCard, trump));
}

// Проверка: сыграна ли карта из руки
function cardInHand(hand, card) {
  return hand.some(c => c.id === card.id);
}

// Проверка: можно ли атаковать (с учётом лимита карт)
function canPlayerAttack(table, maxTableCards = 6) {
  return table.length < maxTableCards;
}

module.exports = {
  canAttack,
  canThrowIn,
  canDefend,
  allBeaten,
  hasDefense,
  canTranslate,
  cardInHand,
  canPlayerAttack
};