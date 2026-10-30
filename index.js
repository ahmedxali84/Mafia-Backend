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
const feedback = require('./feedback');
const { verifyToken, bearer } = require('./auth');
const stats = require('./stats');
const { stateFor, chatChannel, canSeeMessage, canWriteMafiaChat } = require('./view');

const PORT = process.env.PORT || 4000;
// Sites allowed to talk to this server (CORS). CLIENT_ORIGIN (comma separated) replaces the defaults.
const DEFAULT_ORIGINS = ['https://mafia-frontend-lyart.vercel.app', 'http://localhost:3000', 'http://127.0.0.1:3000'];
const ORIGIN = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)
  : DEFAULT_ORIGINS;
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
// Render (and most hosts) sit one proxy in front of us: use the visitor's real IP (feedback rate limit).
app.set('trust proxy', 1);
app.use(cors({ origin: ORIGIN }));
app.get('/', (_req, res) => res.send('Mafia server running'));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: Object.keys(rm.rooms).length, accounts: stats.enabled() }));

// Saved stats of the signed-in player (Authorization: Bearer <game token>).
app.get('/stats/me', async (req, res) => {
  if (!stats.enabled()) return res.status(503).json({ error: 'Accounts are not set up on this server' });
  const account = verifyToken(bearer(req));
  if (!account) return res.status(401).json({ error: 'Sign in again' });
  try {
    res.json({ name: account.name, ...(await stats.getStats(account.id)) });
  } catch (err) {
    console.error('stats/me:', err.message);
    res.status(500).json({ error: 'Could not load stats' });
  }
});
app.use(feedback.router());

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
    // Signed-in players' wins/losses go to the database (no-op without MONGODB_URI).
    stats.recordGame(room).catch((err) => console.error('Could not save game stats:', err.message));
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

  // Registers a client event safely (from Hiban's hardening, branch `hiban`): a missing or
  // garbage payload becomes {}, a missing ack becomes a no-op, and a thrown error is reported
  // to that client instead of crashing the whole server (one bad client must not end every game).
  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      if (typeof payload === 'function') [payload, ack] = [{}, payload];
      const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const cb = typeof ack === 'function' ? ack : () => {};
      try {
        handler(data, cb);
      } catch (err) {
        console.error(`Error in ${event}:`, err);
        cb({ error: 'Server error' });
      }
    });
  };

  // Takes this socket out of its current room (as if the player pressed "Leave").
  function leave() {
    const { room, player } = me();
    current = null;
    if (!room || !player) return;
    socket.leave(room.code);
    if (player.socketId !== socket.id) return; // seat already taken over by a newer tab
    player.voice = null;
    if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') rm.leaveRoom(room, player.id, broadcast);
    else rm.disconnect(room, player.id, broadcast), broadcast(room);
  }

  // `roles`: the extra roles this client can show (see roles.extrasFor). Refreshed on every join,
  // since a reload may bring a newer client.
  // `authToken`: the signed-in player's game token (see auth.js); without one they play as a guest.
  function enter(room, player, roles, authToken) {
    // Same socket going to another room (e.g. browser Back, then create/join): leave the old one
    // first, otherwise it stays there as a "connected" ghost and keeps getting that room's events.
    if (current && current.code !== room.code) leave();
    player.knows = Array.isArray(roles) ? roles.filter((r) => typeof r === 'string').slice(0, 10) : [];
    player.account = verifyToken(authToken);
    if (player.socketId !== socket.id) player.voice = null; // a new tab/refresh must rejoin voice
    player.socketId = socket.id;
    current = { code: room.code, playerId: player.id };
    socket.join(room.code);
    broadcast(room);
  }

  on('create_room', ({ playerId, name, bots = 0, roles, authToken } = {}, cb = () => {}) => {
    if (!playerId || !rm.cleanName(name)) return cb({ error: 'Name is required' });
    const room = rm.createRoom(playerId, name);
    if (bots > 0) rm.addBots(room, Math.min(Number(bots) || 0, 11));
    enter(room, room.players[0], roles, authToken);
    cb({ ok: true, code: room.code });
  });

  // Fresh join or reconnect (same playerId gets its old seat back).
  const join = ({ code, playerId, name, roles, authToken } = {}, cb = () => {}) => {
    if (!playerId) return cb({ error: 'Missing player id' });
    const res = rm.joinRoom(code, playerId, name);
    if (res.error) return cb({ error: res.error });
    enter(res.room, res.player, roles, authToken);
    cb({ ok: true, code: res.room.code });
  };
  on('join_room', join);
  on('rejoin_room', join);

  on('leave_room', (_p, cb = () => {}) => {
    leave();
    cb({ ok: true });
  });

  on('start_game', (_p, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    if (room.host !== player.id) return cb({ error: 'Only the host can start' });
    cb(phases.startGame(room, ctx));
  });

  on('play_again', (_p, cb = () => {}) => {
    const { room, player } = me();
    if (!room || room.host !== player.id) return cb({ error: 'Only the host can do that' });
    if (room.phase !== 'GAME_OVER') return cb({ error: 'Game not over' });
    phases.backToLobby(room, ctx);
    rm.dropOffline(room, broadcast);
    cb({ ok: true });
  });

  on('night_action', ({ targetId } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    const res = actions.submitNightAction(room, player.id, targetId);
    if (res.error) return cb(res);
    // Mafia see each other's picks so they can coordinate.
    broadcast(room);
    phases.checkEarlyEnd(room, ctx);
    cb({ ok: true });
  });

  on('cast_vote', ({ targetId } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    const res = actions.castVote(room, player.id, targetId);
    if (res.error) return cb(res);
    broadcast(room);
    phases.checkEarlyEnd(room, ctx);
    cb({ ok: true });
  });

  // `channel: 'mafia'` writes to the Mafia's private channel (open day and night when there
  // are two or more Mafia); otherwise the message goes to the player's current channel.
  // During discussion: "I'm ready to vote". When every living human is ready, voting starts.
  on('ready_vote', ({ ready = true } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    const res = phases.setReady(room, player.id, !!ready, ctx);
    if (res.error) return cb(res);
    if (room.phase === 'DISCUSSION') broadcast(room); // otherwise setPhase already sent the new state
    cb({ ok: true });
  });

  on('chat_message', ({ text, channel: wanted } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    if (Date.now() - (player.lastChat || 0) < 600) return cb({ error: 'Slow down a little' });
    player.lastChat = Date.now();
    const clean = String(text || '').trim().slice(0, 300);
    if (!clean) return cb({ error: 'Empty message' });
    if (wanted === 'mafia' && !canWriteMafiaChat(room, player)) return cb({ error: 'The Mafia channel is closed' });
    const channel = wanted === 'mafia' ? 'mafia' : chatChannel(room, player);
    if (!channel) return cb({ error: 'You cannot chat right now' });
    postChat(room, player, clean, channel);
    cb({ ok: true });
  });

  // Secret message to one living player (limited per game). Nobody else learns it happened.
  on('whisper', ({ targetId, text } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room) return cb({ error: 'Not in a room' });
    const res = whispers.sendWhisper(room, player.id, targetId, text);
    if (res.error) return cb(res);
    deliver(room, res.whisper);
    broadcast(room); // refreshes the sender's whispers-left counter
    cb({ ok: true, whispersLeft: player.whispersLeft });
  });

  // The host can fill empty seats with bots so the game always has a table.
  on('add_bots', ({ count = 4 } = {}, cb = () => {}) => {
    const { room, player } = me();
    if (!room || room.host !== player.id || room.phase !== 'LOBBY') return cb({ error: 'Host only, in lobby' });
    rm.addBots(room, Math.min(Number(count) || 0, 11));
    broadcast(room);
    cb({ ok: true });
  });

  on('remove_bots', (_p, cb = () => {}) => {
    const { room, player } = me();
    if (!room || room.host !== player.id || room.phase !== 'LOBBY') return cb({ error: 'Host only, in lobby' });
    rm.removeBots(room);
    broadcast(room);
    cb({ ok: true });
  });

  // ── Voice chat (WebRTC). The server only relays signaling; see docs/VOICE.md. ──
  on('voice_join', (_p, done) => {
    const cb = ack(done);
    const { room, player } = meLive();
    if (!room) return cb({ error: 'Not in a room' });
    player.voice = { session: Math.random().toString(36).slice(2, 10), muted: false };
    broadcast(room);
    cb({ ok: true, session: player.voice.session, iceServers: ICE_SERVERS, at: Date.now() });
  });

  on('voice_leave', (_p, done) => {
    const cb = ack(done);
    const { room, player } = meLive();
    if (room && player?.voice) {
      player.voice = null;
      broadcast(room);
    }
    cb({ ok: true });
  });

  on('voice_mute', (p, done) => {
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
  on('voice_signal', (p) => {
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
  stats
    .connect()
    .then((on) => console.log(on ? 'MongoDB connected: saving stats for signed-in players' : 'No MONGODB_URI: account stats are off'))
    .catch((err) => console.error('MongoDB connection failed, account stats are off:', err.message));
}

module.exports = { server, io };
