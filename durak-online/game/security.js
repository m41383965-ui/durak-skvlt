// game/security.js
const crypto = require('crypto');

function hashPassword(password, salt = null) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(s + password).digest('hex');
  return { hash, salt: s };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.createHash('sha256').update(salt + password).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.attempts = new Map();
    // Автоочистка памяти
    setInterval(() => this.cleanup(), windowMs * 2);
  }
  check(ip) {
    const now = Date.now();
    const list = (this.attempts.get(ip) || []).filter(t => now - t < this.windowMs);
    if (list.length >= this.max) {
      return { allowed: false, retryAfter: Math.ceil((this.windowMs - (now - list[0])) / 1000) };
    }
    list.push(now);
    this.attempts.set(ip, list);
    return { allowed: true };
  }
  cleanup() {
    const now = Date.now();
    for (const [ip, list] of this.attempts.entries()) {
      const valid = list.filter(t => now - t < this.windowMs);
      if (valid.length === 0) this.attempts.delete(ip);
      else this.attempts.set(ip, valid);
    }
  }
}

module.exports = { hashPassword, verifyPassword, RateLimiter };