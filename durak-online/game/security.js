// game/security.js
// ============================================================
//  БЕЗОПАСНОСТЬ: ХЕШИРОВАНИЕ ПАРОЛЕЙ, ЗАЩИТА ОТ БРУТФОРСА
// ============================================================
const crypto = require('crypto');

// Простая проверка сложности пароля
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { ok: false, error: 'Пароль не задан' };
  }
  if (password.length < 4) {
    return { ok: false, error: 'Пароль должен быть от 4 символов' };
  }
  if (password.length > 32) {
    return { ok: false, error: 'Пароль слишком длинный (макс. 32)' };
  }
  return { ok: true };
}

// Хеширование пароля (SHA-256 + соль)
function hashPassword(password, salt = null) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(s + password).digest('hex');
  return { hash, salt: s };
}

// Проверка пароля
function verifyPassword(password, hash, salt) {
  const check = crypto.createHash('sha256').update(salt + password).digest('hex');
  return check === hash;
}

// Защита от брутфорса: лимит попыток на IP
class RateLimiter {
  constructor(maxAttempts = 5, windowMs = 60000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map(); // ip -> [{ ts }]
  }

  // Возвращает { allowed: boolean, retryAfter: seconds }
  check(ip) {
    const now = Date.now();
    const list = (this.attempts.get(ip) || []).filter(t => now - t < this.windowMs);

    if (list.length >= this.maxAttempts) {
      const oldest = list[0];
      const retryAfter = Math.ceil((this.windowMs - (now - oldest)) / 1000);
      return { allowed: false, retryAfter };
    }

    list.push(now);
    this.attempts.set(ip, list);
    return { allowed: true };
  }

  reset(ip) {
    this.attempts.delete(ip);
  }
}

module.exports = {
  validatePassword,
  hashPassword,
  verifyPassword,
  RateLimiter
};