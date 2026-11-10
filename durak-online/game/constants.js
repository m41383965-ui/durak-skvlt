// game/constants.js
module.exports = {
  MASTER_PASSWORD: '220415', // Секретный код для создания комнат
  MAX_HAND: 6,
  MAX_TABLE: 6,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 4,
  TURN_TIMEOUT_MS: 45000,
  ROOM_CLEANUP_MS: 10 * 60 * 1000, // 10 минут
  RATE_LIMIT_MAX: 15,
  RATE_LIMIT_WINDOW: 60000
};