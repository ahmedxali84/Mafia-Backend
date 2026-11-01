const crypto = require('crypto');
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

// Seat key: a random secret each browser keeps to itself (the playerId is public: every client
// receives everyone's id). Only a hash is stored; reclaiming a seat needs the same secret, so
// nobody can take over another player's seat (and see their role) with the id from the state.
const hashSecret = (secret) =>
  typeof secret === 'string' && secret.length >= 16 && secret.length <= 128 ? crypto.createHash('sha256').update(secret).digest() : null;
function ownsSeat(player, secret) {
  if (!player.secretHash) return true; // seat from an older client without a key
  const h = hashSecret(secret);
  return !!h && crypto.timingSafeEqual(h, player.secretHash);
}

function createRoom(playerId, name, secret) {
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
    players: [newPlayer(playerId, name, { secretHash: hashSecret(secret) })],
  };
  return rooms[code];
}

function newPlayer(id, name, extra = {}) {
  return { id, name: cleanName(name), alive: true, role: null, connected: true, checks: [], ...extra };
}

// Returns { room, player } or { error }. Handles both fresh joins and reconnects.
function joinRoom(code, playerId, name, secret) {
  const room = rooms[String(code || '').toUpperCase()];
  if (!room) return { error: 'Room not found' };
  const existing = room.players.find((p) => p.id === playerId);
  if (existing) {
    if (existing.bot || !ownsSeat(existing, secret)) return { error: 'That seat belongs to another player' };
    if (!existing.secretHash) existing.secretHash = hashSecret(secret); // an old seat gets a key on its next join
    existing.connected = true;
    clearTimeout(existing.dropTimer);
    clearTimeout(room.cleanupTimer);
    // If the host is still away, the first player back takes over (else nobody could start).
    pickNewHost(room);
    return { room, player: existing };
  }
  if (!cleanName(name)) return { error: 'NAME_REQUIRED' };
  if (room.phase !== 'LOBBY') return { error: 'Game already started' };
  if (room.players.length >= MAX_PLAYERS) return { error: 'Room is full' };
  if (room.players.some((p) => p.name.toLowerCase() === cleanName(name).toLowerCase())) {
    return { error: 'That name is already taken in this room' };
  }
  const player = newPlayer(playerId, name, { secretHash: hashSecret(secret) });
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
    if (!room.players.some((p) => p.connected && !p.bot)) deleteRoom(room);
  }, room.phase === 'LOBBY' ? 15000 : 5 * 60 * 1000);
  room.cleanupTimer.unref();
}

// Only deletes this exact room: a late timer must not remove a newer room that reused the code.
function deleteRoom(room) {
  clearTimers(room);
  clearTimeout(room.cleanupTimer);
  if (rooms[room.code] === room) delete rooms[room.code];
}

function leaveRoom(room, playerId, onChange) {
  removePlayer(room, playerId);
  if (!room.players.some((p) => !p.bot)) return deleteRoom(room);
  onChange(room);
}

// Back in the lobby after a game: humans who left or dropped mid-game get the normal lobby
// grace period and are then removed, instead of keeping their seat (and being dealt a role).
function dropOffline(room, onChange) {
  for (const p of room.players) if (!p.bot && !p.connected) disconnect(room, p.id, onChange);
}

module.exports = { rooms, createRoom, joinRoom, addBots, removeBots, disconnect, leaveRoom, dropOffline, cleanName };
