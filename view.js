// Builds what each player is allowed to see. Roles are never broadcast:
// you see your own role, your Mafia teammates (if Mafia), and the role of
// anyone who is dead or once the game is over.
const { teamOf } = require('./game/roles');

function canSeeRole(room, viewer, p) {
  if (room.phase === 'GAME_OVER') return true;
  if (p.id === viewer.id) return true;
  if (!p.alive) return true;
  return viewer.role === 'MAFIA' && p.role === 'MAFIA';
}

// Which chat channel the player writes to right now (null = cannot chat).
function chatChannel(room, p) {
  if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') return 'public';
  if (room.phase === 'ROLE_REVEAL') return null;
  if (!p.alive) return 'dead';
  if (room.phase === 'NIGHT') return p.role === 'MAFIA' ? 'mafia' : null;
  return 'public';
}

function canSeeMessage(room, viewer, msg) {
  if (msg.channel === 'public' || msg.channel === 'notice') return true;
  if (msg.channel === 'whisper') return viewer.id === msg.from || viewer.id === msg.to;
  if (msg.channel === 'mafia') return viewer.role === 'MAFIA';
  if (msg.channel === 'dead') return !viewer.alive || room.phase === 'GAME_OVER';
  return false;
}

// Voice uses the chat rules: you hear a speaker iff you could read what they write right now.
function hears(room, listener, speaker) {
  if (listener.id === speaker.id || listener.bot || speaker.bot) return false;
  const channel = chatChannel(room, speaker);
  return !!channel && canSeeMessage(room, listener, { channel });
}

// Who the player sends their mic to / hears, among players currently in voice.
function voiceFor(room, p) {
  const inVoice = room.players.filter((x) => x.voice && x.connected && x.id !== p.id);
  return {
    channel: chatChannel(room, p),
    sendTo: inVoice.filter((x) => hears(room, x, p)).map((x) => x.id),
    hearFrom: inVoice.filter((x) => hears(room, p, x)).map((x) => x.id),
  };
}

function stateFor(room, viewer) {
  const started = room.phase !== 'LOBBY';
  return {
    code: room.code,
    phase: room.phase,
    endsAt: room.endsAt,
    phaseMs: room.phaseMs || 0,
    votedIds: room.phase === 'VOTING' ? Object.keys(room.votes) : [],
    serverNow: Date.now(),
    day: room.day,
    hostId: room.host,
    winner: room.winner,
    gameId: room.startedAt ? `${room.code}-${room.startedAt}` : null,
    result: room.result,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected || !!p.bot,
      bot: !!p.bot,
      role: started && canSeeRole(room, viewer, p) ? p.role : undefined,
      voice: p.voice && p.connected ? { session: p.voice.session, muted: p.voice.muted } : null,
    })),
    you: {
      id: viewer.id,
      role: viewer.role,
      team: viewer.role ? teamOf(viewer.role) : null,
      alive: viewer.alive,
      nightTarget: room.night.actions[viewer.id] || null,
      vote: room.votes[viewer.id] || null,
      checks: viewer.checks || [],
      chatChannel: chatChannel(room, viewer),
      whispersLeft: viewer.whispersLeft || 0,
      voice: voiceFor(room, viewer),
    },
    chat: room.chat.filter((m) => canSeeMessage(room, viewer, m)),
  };
}

module.exports = { stateFor, chatChannel, canSeeMessage, voiceFor };
