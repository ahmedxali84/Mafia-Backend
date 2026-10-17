require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const rm = require('./rooms');
const phases = require('./game/phases');
const actions = require('./game/actions');
const { teamOf } = require('./game/roles');
const whispers = require('./game/whispers');
const { stateFor, chatChannel, canSeeMessage } = require('./view');

const PORT = process.env.PORT || 4000;
// Set CLIENT_ORIGIN (comma separated) in production; '*' only for local testing.
const ORIGIN = process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',') : '*';
const DEBUG = process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEBUG === 'true';

// WebRTC servers for voice chat. STUN finds a direct path; TURN relays audio when that fails.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
}
const SIGNAL_MAX = 16000; // bytes per signaling message (SDP is ~3-6 KB)
const ack = (cb) => (typeof cb === 'function' ? cb : () => {});
const SIGNAL_RATE = 300; // messages per second per socket (joining a full table sends ~11 offers + their ICE candidates)

const app = express();
app.use(cors({ origin: ORIGIN }));
app.get('/', (_req, res) => res.send('Mafia server running'));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: Object.keys(rm.rooms).length }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGIN } });

const socketOf = (p) => (p.socketId ? io.sockets.sockets.get(p.socketId) : null);

// Sends every player their own personalised snapshot of the room.
function broadcast(room) {
  io.to(room.code).emit('room_update', room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected || !!p.bot })));
  for (const p of room.players) {
    const s = socketOf(p);
    if (s) s.emit('state', stateFor(room, p));
  }
}

// Stores a chat message and sends it to everyone allowed to see it.
function deliver(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > 200) room.chat.shift();
  for (const p of room.players) {
    if (canSeeMessage(room, p, msg)) {
      const s = socketOf(p);
      if (s) s.emit('chat_message', msg);
    }
  }
}

// Convenience wrapper used by chat and by the bots.
function postChat(room, player, text, channel) {
  deliver(room, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, channel, from: player.id, name: player.name, text, ts: Date.now() });
}

const ctx = {
  onBotChat: postChat,
  onChange: broadcast,
  onPhase: (room) => io.to(room.code).emit('phase_change', { phase: room.phase, endsAt: room.endsAt }),
  onRole: (_room, p) => {
    const s = socketOf(p);
    if (s) s.emit('your_role', { role: p.role, team: teamOf(p.role) });
  },
  onCheck: (_room, det, c) => {
    const s = socketOf(det);
    if (s) s.emit('investigation_result', { targetId: c.targetId, isMafia: c.isMafia });
  },
  onGameOver: (room) => {
    io.to(room.code).emit('game_over', {
      winner: room.winner,
      roles: Object.fromEntries(room.players.map((p) => [p.id, p.role])),
    });
  },
};

io.on('connection', (socket) => {
  let current = null; // { code, playerId }

  const me = () => {
    if (!current) return {};
    const room = rm.rooms[current.code];
    const player = room && room.players.find((p) => p.id === current.playerId);
    return { room, player };
  };

  // The player, but only if this socket is their current connection (an old tab can't touch voice).
  const meLive = () => {
    const { room, player } = me();
    return room && player && player.socketId === socket.id ? { room, player } : {};
  };

  function enter(room, player) {
    if (player.socketId !== socket.id) player.voice = null; // a new tab/refresh must rejoin voice
    player.socketId = socket.id;
    current = { code: room.code, playerId: player.id };
    socket.join(room.code);
    broadcast(room);
  }

  socket.on('create_room', ({ playerId, name, bots = 0 } = {}, cb = () => {}) => {
    if (!playerId || !rm.cleanName(name)) return cb({ error: 'Name is required' });
    const room = rm.createRoom(playerId, name);
    if (bots > 0) rm.addBots(room, Math.min(Number(bots) || 0, 11));
    enter(room, room.players[0]);
    cb({ ok: true, code: room.code });
  });

  // Fresh join or reconnect (same playerId gets its old seat back).
  const join = ({ code, playerId, name } = {}, cb = () => {}) => {
    if (!playerId) return cb({ error: 'Missing player id' });
    const res = rm.joinRoom(code, playerId, name);
    if (res.error) return cb({ error: res.error });
    enter(res.room, res.player);
    cb({ ok: true, code: res.room.code });
  };
  socket.on('join_room', join);
  socket.on('rejoin_room', join);

  socket.on('leave_room', (_p, cb = () => {}) => {
    const { room, player } = me();
    if (!room || !player) return cb({ ok: true });
    player.voice = null;
    socket.leave(room.code);
    if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') rm.leaveRoom(room, player.id, broadcast);
    else rm.disconnect(room, player.id, broadcast), broadcast(room);
    current = null;
    cb({ ok: true });
  });

  socket.on('start_game', (_p, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    if (room.host !== player.id) return cb({ error: 'Only the host can start' });
    cb(phases.startGame(room, ctx));
  });

  socket.on('play_again', (_p, cb = () => {}) => {
    const { room, player } = me();
    if (!room || room.host !== player.id) return cb({ error: 'Only the host can do that' });
    if (room.phase !== 'GAME_OVER') return cb({ error: 'Game not over' });
    phases.backToLobby(room, ctx);
    cb({ ok: true });
  });

  socket.on('night_action', ({ targetId } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    const res = actions.submitNightAction(room, player.id, targetId);
    if (res.error) return cb(res);
    // Mafia see each other's picks so they can coordinate.
    broadcast(room);
    phases.checkEarlyEnd(room, ctx);
    cb({ ok: true });
  });

  socket.on('cast_vote', ({ targetId } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    const res = actions.castVote(room, player.id, targetId);
    if (res.error) return cb(res);
    broadcast(room);
    phases.checkEarlyEnd(room, ctx);
    cb({ ok: true });
  });

  socket.on('chat_message', ({ text } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    if (Date.now() - (player.lastChat || 0) < 600) return cb({ error: 'Slow down a little' });
    player.lastChat = Date.now();
    const clean = String(text || '').trim().slice(0, 300);
    if (!clean) return cb({ error: 'Empty message' });
    const channel = chatChannel(room, player);
    if (!channel) return cb({ error: 'You cannot chat right now' });
    postChat(room, player, clean, channel);
    cb({ ok: true });
  });

  // Secret message to one living player (limited per game). Everyone sees only a notice.
  socket.on('whisper', ({ targetId, text } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    const res = whispers.sendWhisper(room, player.id, targetId, text);
    if (res.error) return cb(res);
    deliver(room, res.notice);
    deliver(room, res.whisper);
    broadcast(room); // refreshes the sender's whispers-left counter
    cb({ ok: true, whispersLeft: player.whispersLeft });
  });

  // The host can fill empty seats with bots so the game always has a table.
  socket.on('add_bots', ({ count = 4 } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room || room.host !== player.id || room.phase !== 'LOBBY') return cb({ error: 'Host only, in lobby' });
    rm.addBots(room, Math.min(Number(count) || 0, 11));
    broadcast(room);
    cb({ ok: true });
  });

  socket.on('remove_bots', (_p, cb = () => {}) => {
    const { room, player } = me();
    if (!room || room.host !== player.id || room.phase !== 'LOBBY') return cb({ error: 'Host only, in lobby' });
    rm.removeBots(room);
    broadcast(room);
    cb({ ok: true });
  });

  // ── Voice chat (WebRTC). The server only relays signaling; see docs/VOICE.md. ──
  socket.on('voice_join', (_p, done) => {
    const cb = ack(done);
    const { room, player } = meLive();
    if (!room) return cb({ error: 'Not in a room' });
    player.voice = { session: Math.random().toString(36).slice(2, 10), muted: false };
    broadcast(room);
    cb({ ok: true, session: player.voice.session, iceServers: ICE_SERVERS, at: Date.now() });
  });

  socket.on('voice_leave', (_p, done) => {
    const cb = ack(done);
    const { room, player } = meLive();
    if (room && player?.voice) {
      player.voice = null;
      broadcast(room);
    }
    cb({ ok: true });
  });

  socket.on('voice_mute', (p, done) => {
    const cb = ack(done);
    const muted = !!(p && p.muted);
    const { room, player } = meLive();
    if (!room || !player.voice) return cb({ error: 'Not in voice' });
    player.voice.muted = muted;
    broadcast(room);
    cb({ ok: true });
  });

  // Relays an SDP offer/answer or ICE candidate to one other player in voice in the same room.
  let signals = { at: 0, n: 0 };
  socket.on('voice_signal', (p) => {
    const { to, toSession, data } = p && typeof p === 'object' ? p : {};
    const { room, player } = meLive();
    if (!room || !player.voice) return;
    const now = Date.now();
    if (now - signals.at > 1000) signals = { at: now, n: 0 };
    if (++signals.n > SIGNAL_RATE) return;
    if (!data || typeof data !== 'object' || JSON.stringify(data).length > SIGNAL_MAX) return;
    const target = room.players.find((p) => p.id === to);
    if (!target || target.bot || !target.voice || target.voice.session !== toSession) return;
    const s = socketOf(target);
    // `at` lets the receiver tell whether a later room state already knew about this sender.
    if (s) s.emit('voice_signal', { from: player.id, fromSession: player.voice.session, data, at: now });
  });

  socket.on('disconnect', () => {
    const { room, player } = me();
    if (!room || !player || player.socketId !== socket.id) return; // replaced by a newer connection
    player.voice = null;
    rm.disconnect(room, player.id, broadcast);
    broadcast(room);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Server running on port ${PORT}${DEBUG ? ' (debug on)' : ''}`));
}

module.exports = { server, io };
