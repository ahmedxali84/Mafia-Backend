const { MAX_PLAYERS } = require('./game/roles');
const { clearTimers } = require('./game/phases');
const { botName } = require('./game/bots');

const rooms = {}; // { CODE: room }
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike chars

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
  } while (rooms[code]);
  return code;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 16);
}

function createRoom(playerId, name) {
  const code = makeCode();
  rooms[code] = {
    code,
    host: playerId,
    phase: 'LOBBY',
    endsAt: null,
    day: 0,
    result: null,
    winner: null,
    night: { actions: {} },
    votes: {},
    chat: [],
    timer: null,
    botTimers: [],
    players: [newPlayer(playerId, name)],
  };
  return rooms[code];
}

function newPlayer(id, name, extra = {}) {
  return { id, name: cleanName(name), alive: true, role: null, connected: true, checks: [], ...extra };
}

// Returns { room, player } or { error }. Handles both fresh joins and reconnects.
function joinRoom(code, playerId, name) {
  const room = rooms[String(code || '').toUpperCase()];
  if (!room) return { error: 'Room not found' };
  const existing = room.players.find((p) => p.id === playerId);
  if (existing) {
    existing.connected = true;
    clearTimeout(existing.dropTimer);
    return { room, player: existing };
  }
  if (!cleanName(name)) return { error: 'NAME_REQUIRED' };
  if (room.phase !== 'LOBBY') return { error: 'Game already started' };
  if (room.players.length >= MAX_PLAYERS) return { error: 'Room is full' };
  if (room.players.some((p) => p.name.toLowerCase() === cleanName(name).toLowerCase())) {
    return { error: 'That name is already taken in this room' };
  }
  const player = newPlayer(playerId, name);
  room.players.push(player);
  return { room, player };
}

function addBots(room, count) {
  let added = 0;
  while (added < count && room.players.length < MAX_PLAYERS) {
    const id = `bot-${room.code}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    room.players.push(newPlayer(id, botName(room), { bot: true }));
    added++;
  }
  return added;
}

function removeBots(room) {
  const before = room.players.length;
  room.players = room.players.filter((p) => !p.bot);
  return before - room.players.length;
}

function pickNewHost(room) {
  if (room.players.find((p) => p.id === room.host && p.connected && !p.bot)) return;
  const next = room.players.find((p) => p.connected && !p.bot);
  if (next) room.host = next.id;
}

function removePlayer(room, playerId) {
  room.players = room.players.filter((p) => p.id !== playerId);
  pickNewHost(room);
}

// Marks a player disconnected. In the lobby they are removed after a short grace period.
function disconnect(room, playerId, onChange) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return;
  p.connected = false;
  pickNewHost(room);
  if (room.phase === 'LOBBY') {
    p.dropTimer = setTimeout(() => {
      if (!p.connected && room.phase === 'LOBBY') {
        removePlayer(room, playerId);
        cleanupIfEmpty(room);
        if (rooms[room.code]) onChange(room);
      }
    }, 10000);
    p.dropTimer.unref();
  }
  cleanupIfEmpty(room);
}

// Rooms with no connected humans are deleted after a few minutes.
function cleanupIfEmpty(room) {
  clearTimeout(room.cleanupTimer);
  if (room.players.some((p) => p.connected && !p.bot)) return;
  room.cleanupTimer = setTimeout(() => {
    if (!room.players.some((p) => p.connected && !p.bot)) {
      clearTimers(room);
      delete rooms[room.code];
    }
  }, room.phase === 'LOBBY' ? 15000 : 5 * 60 * 1000);
  room.cleanupTimer.unref();
}

function leaveRoom(room, playerId, onChange) {
  removePlayer(room, playerId);
  if (!room.players.some((p) => !p.bot)) {
    clearTimers(room);
    delete rooms[room.code];
    return;
  }
  onChange(room);
}

module.exports = { rooms, createRoom, joinRoom, addBots, removeBots, disconnect, leaveRoom, cleanName };
