const { shuffle } = require('./roles');

const NIGHT_ROLES = ['MAFIA', 'DOCTOR', 'DETECTIVE'];

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function resetNight(room) {
  room.night = { actions: {} }; // playerId -> targetId
}

function resetVotes(room) {
  room.votes = {}; // voterId -> targetId
}

// Validates and records a night action. Returns { ok } or { error }.
function submitNightAction(room, playerId, targetId) {
  if (room.phase !== 'NIGHT') return { error: 'Not night' };
  const me = findPlayer(room, playerId);
  if (!me || !me.alive) return { error: 'Dead players cannot act' };
  if (!NIGHT_ROLES.includes(me.role)) return { error: 'Your role has no night action' };
  const target = findPlayer(room, targetId);
  if (!target || !target.alive) return { error: 'Invalid target' };
  if (me.role === 'MAFIA' && target.role === 'MAFIA') return { error: 'Cannot target your team' };
  if (me.role === 'DETECTIVE' && target.id === me.id) return { error: 'Cannot investigate yourself' };
  room.night.actions[playerId] = targetId;
  return { ok: true };
}

// True when every living night-role player has acted.
function allNightActionsIn(room) {
  return room.players
    .filter((p) => p.alive && NIGHT_ROLES.includes(p.role))
    .every((p) => room.night.actions[p.id]);
}

// Resolves the night. Applies the kill and returns what happened.
// { killed: player|null, saved: boolean, checks: [{detectiveId, targetId, isMafia}] }
function resolveNight(room) {
  const { actions } = room.night;

  // Mafia pick the target with the most mafia votes; ties are broken randomly.
  const tally = {};
  for (const p of room.players) {
    if (p.alive && p.role === 'MAFIA' && actions[p.id]) {
      tally[actions[p.id]] = (tally[actions[p.id]] || 0) + 1;
    }
  }
  let targetId = null;
  const max = Math.max(0, ...Object.values(tally));
  if (max > 0) {
    targetId = shuffle(Object.keys(tally).filter((id) => tally[id] === max))[0];
  }

  const doctor = room.players.find((p) => p.alive && p.role === 'DOCTOR');
  const savedId = doctor ? actions[doctor.id] : null;

  let killed = null;
  let saved = false;
  if (targetId) {
    if (targetId === savedId) {
      saved = true;
    } else {
      killed = findPlayer(room, targetId);
      killed.alive = false;
    }
  }

  const checks = [];
  // A detective killed tonight still gets their result (action was simultaneous).
  const detectives = room.players.filter((p) => p.role === 'DETECTIVE' && actions[p.id]);
  for (const d of detectives) {
    const t = findPlayer(room, actions[d.id]);
    checks.push({ detectiveId: d.id, targetId: t.id, isMafia: t.role === 'MAFIA' });
  }

  return { killed, saved, checks };
}

// Records a vote. targetId may be 'SKIP'.
function castVote(room, voterId, targetId) {
  if (room.phase !== 'VOTING') return { error: 'Not voting time' };
  const voter = findPlayer(room, voterId);
  if (!voter || !voter.alive) return { error: 'Dead players cannot vote' };
  if (targetId !== 'SKIP') {
    const target = findPlayer(room, targetId);
    if (!target || !target.alive) return { error: 'Invalid target' };
    if (target.id === voterId) return { error: 'Cannot vote for yourself' };
  }
  room.votes[voterId] = targetId;
  return { ok: true };
}

function allVotesIn(room) {
  return room.players.filter((p) => p.alive).every((p) => room.votes[p.id]);
}

// Tallies votes. The player with the most votes is eliminated; a tie (or skip
// winning) eliminates nobody. Returns { eliminated: player|null, counts, tie }.
function tallyVotes(room) {
  const counts = {};
  for (const target of Object.values(room.votes)) {
    if (target !== 'SKIP') counts[target] = (counts[target] || 0) + 1;
  }
  const skips = Object.values(room.votes).filter((t) => t === 'SKIP').length;
  const max = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((id) => counts[id] === max);
  let eliminated = null;
  let tie = false;
  if (max === 0 || skips >= max) {
    tie = max > 0 && skips === max;
  } else if (leaders.length > 1) {
    tie = true;
  } else {
    eliminated = findPlayer(room, leaders[0]);
    eliminated.alive = false;
  }
  return { eliminated, counts, tie };
}

module.exports = {
  NIGHT_ROLES,
  findPlayer,
  resetNight,
  resetVotes,
  submitNightAction,
  allNightActionsIn,
  resolveNight,
  castVote,
  allVotesIn,
  tallyVotes,
};
