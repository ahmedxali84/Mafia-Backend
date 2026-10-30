// Builds what each player is allowed to see. Roles are never broadcast:
// you see your own role, your Mafia teammates (if Mafia), and the role of
// anyone who is dead or once the game is over.
const { teamOf, extrasFor } = require('./game/roles');
const { VOTE_PHASES } = require('./game/actions');

// The Mafia get their own always-open channel when there are two or more of them.
// Living members write to it; every Mafia member (dead too) can read it.
function hasMafiaChat(room, p) {
  if (p.role !== 'MAFIA' || room.phase === 'LOBBY') return false;
  return room.players.filter((x) => x.role === 'MAFIA').length >= 2;
}
const canWriteMafiaChat = (room, p) => hasMafiaChat(room, p) && p.alive && room.phase !== 'GAME_OVER';

// At night a Mafia member sees who each living teammate has marked, so the family can agree.
function mafiaPicks(room, viewer) {
  if (room.phase !== 'NIGHT' || viewer.role !== 'MAFIA') return {};
  const picks = {};
  for (const p of room.players) {
    if (p.id !== viewer.id && p.alive && p.role === 'MAFIA' && room.night.actions[p.id]) picks[p.id] = room.night.actions[p.id];
  }
  return picks;
}

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

// `chat: false` leaves the chat log out (clients that keep it from chat_message events only need it
// when they join and when the phase changes; see broadcast in index.js).
function stateFor(room, viewer, { chat = true } = {}) {
  const started = room.phase !== 'LOBBY';
  return {
    code: room.code,
    phase: room.phase,
    endsAt: room.endsAt,
    phaseMs: room.phaseMs || 0,
    votedIds: VOTE_PHASES.includes(room.phase) ? Object.keys(room.votes) : [],
    readyIds: room.phase === 'DISCUSSION' ? Object.keys(room.ready || {}) : [],
    history: room.phase === 'LOBBY' ? [] : room.history || [],
    serverNow: Date.now(),
    day: room.day,
    hostId: room.host,
    winner: room.winner,
    gameId: room.startedAt ? `${room.code}-${room.startedAt}` : null,
    result: room.result,
    extraRoles: room.phase === 'LOBBY' ? extrasFor(room.players) : [], // what the lobby's role mix will deal
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
      mafiaPicks: mafiaPicks(room, viewer),
      vote: room.votes[viewer.id] || null,
      checks: viewer.checks || [],
      stole: viewer.stole || null, // Thief: { targetId, role, day } after a theft
      robbed: viewer.robbed || null, // the Thief's victim: { role, day } (not who took it)
      chatChannel: chatChannel(room, viewer),
      whispersLeft: viewer.whispersLeft || 0,
      mafiaChat: hasMafiaChat(room, viewer) ? { canWrite: canWriteMafiaChat(room, viewer) } : null,
      voice: voiceFor(room, viewer),
    },
    ...(chat && { chat: room.chat.filter((m) => canSeeMessage(room, viewer, m)) }),
  };
}

module.exports = { stateFor, chatChannel, canSeeMessage, voiceFor, canWriteMafiaChat };
