// game/manager.js
const { Room } = require('./room');
const { ROOM_CLEANUP_MS } = require('./constants');

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.sessions = new Map();
    setInterval(() => this.cleanup(), 60000);
  }

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(options) {
    const room = new Room(this.generateCode(), this.io, options);
    this.rooms.set(room.id, room);
    return room;
  }

  getRoom(id) { return this.rooms.get(id); }

  cleanup() {
    const now = Date.now();
    for (const [id, room] of this.rooms.entries()) {
      const active = room.players.filter(p => p.connected).length;
      if ((room.state === 'finished' || active === 0) && now - room.lastActivity > ROOM_CLEANUP_MS) {
        if (room.turnTimer) clearTimeout(room.turnTimer);
        this.rooms.delete(id);
        console.log(`🧹 Комната ${id} удалена`);
      }
    }
    // Очистка мертвых сессий
    for (const [sid, s] of this.sessions.entries()) {
      if (!s.connected && !this.rooms.has(s.roomId)) this.sessions.delete(sid);
    }
  }
}
module.exports = { RoomManager };