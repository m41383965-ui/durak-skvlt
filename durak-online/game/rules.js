// game/rules.js
const { beats } = require('./deck');

// Можно ли атаковать картой card при текущем столе
// Правило: первая карта — любая, далее — только ранг, который уже есть на столе
function canAttack(card, table, trump) {
  if (table.length === 0) return true;
  // Нельзя атаковать, если все карты на столе уже побиты (защитник ещё не отбился)
  const ranksOnTable = new Set(table.filter(t => !t.beaten).map(t => t.card.rank));
  return ranksOnTable.has(card.rank);
}

// Можно ли подкинуть карту (для подкидывающего в паре)
function canThrowIn(card, table, trump) {
  if (table.length === 0) return false;
  const ranksOnTable = new Set(table.filter(t => !t.beaten).map(t => t.card.rank));
  // Также учитываем побитые карты — по классическим правилам подкидывать можно по любому рангу на столе
  const allRanks = new Set(table.map(t => t.card.rank));
  return allRanks.has(card.rank);
}

// Можно ли отбить карту attack картой defend
function canDefend(attack, defend, trump) {
  return beats(defend, attack, trump);
}

// Все ли карты на столе побиты
function allBeaten(table) {
  return table.every(t => t.beaten);
}

// Есть ли у защитника карта для отбоя
function hasDefense(defenderHand, attackCard, trump) {
  return defenderHand.some(c => beats(c, attackCard, trump));
}

module.exports = { canAttack, canThrowIn, canDefend, allBeaten, hasDefense };