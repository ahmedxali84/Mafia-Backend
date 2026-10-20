const { assignRoles, MIN_PLAYERS } = require('./roles');
const { winCheck } = require('./winCheck');
const actions = require('./actions');
const bots = require('./bots');
const { resetWhispers } = require('./whispers');

const scale = Number(process.env.TIMER_SCALE) || 1; // set small in tests

const DURATIONS = {
  ROLE_REVEAL: 8000,
  NIGHT: 30000,
  DAY_RESULT: 6000,
  DISCUSSION: 120000,
  VOTING: 30000,
  VOTE_RESULT: 6000,
};

function clearTimers(room) {
  clearTimeout(room.timer);
  (room.botTimers || []).forEach(clearTimeout);
  room.timer = null;
  room.botTimers = [];
}

// ctx: { onChange(room), onPhase(room), onRole(room, player), onCheck(room, check), onGameOver(room) }
// onRole is sent again to both players when the Thief steals a role.
function setPhase(room, phase, ctx) {
  clearTimers(room);
  room.phase = phase;
  const ms = DURATIONS[phase];
  room.endsAt = ms ? Date.now() + ms * scale : null;
  room.phaseMs = ms ? ms * scale : 0;
  if (ms) room.timer = setTimeout(() => onPhaseEnd(room, ctx), ms * scale);
  if (phase === 'NIGHT') {
    room.day += 1;
    actions.resetNight(room);
  }
  if (phase === 'DISCUSSION') {
    actions.resetVotes(room);
    room.ready = {};
  }
  ctx.onPhase(room);
  ctx.onChange(room);
  bots.schedule(room, ctx, { scale, after: (r) => { checkEarlyEnd(r, ctx); ctx.onChange(r); } });
}

function startGame(room, ctx) {
  if (room.phase !== 'LOBBY') return { error: 'Game already started' };
  if (room.players.length < MIN_PLAYERS) return { error: `Need at least ${MIN_PLAYERS} players` };
  assignRoles(room.players);
  room.players.forEach((p) => {
    p.alive = true;
    p.checks = [];
    p.stole = null;
    p.robbed = null;
  });
  resetWhispers(room);
  room.day = 0;
  room.startedAt = Date.now();
  room.claims = [];
  room.history = []; // what happened each day, shown as the match timeline
  room.result = null;
  room.winner = null;
  room.chat = [];
  room.players.forEach((p) => ctx.onRole(room, p));
  setPhase(room, 'ROLE_REVEAL', ctx);
  return { ok: true };
}

function finish(room, ctx, winner) {
  clearTimers(room);
  room.winner = winner;
  room.phase = 'GAME_OVER';
  room.endsAt = null;
  ctx.onPhase(room);
  ctx.onGameOver(room);
  ctx.onChange(room);
}

function endNight(room, ctx) {
  const res = actions.resolveNight(room);
  for (const c of res.checks) {
    const det = actions.findPlayer(room, c.detectiveId);
    det.checks.push({ targetId: c.targetId, isMafia: c.isMafia, day: room.day });
    ctx.onCheck(room, det, c);
  }
  if (res.theft) {
    const thief = actions.findPlayer(room, res.theft.thiefId);
    const mark = actions.findPlayer(room, res.theft.targetId);
    // The thief knows who they robbed; the victim only learns what they lost.
    thief.stole = { targetId: mark.id, role: res.theft.role, day: room.day };
    mark.robbed = { role: res.theft.role, day: room.day };
    ctx.onRole(room, thief);
    ctx.onRole(room, mark);
  }
  room.result = {
    type: 'NIGHT',
    day: room.day,
    killedId: res.killed ? res.killed.id : null,
    killedName: res.killed ? res.killed.name : null,
    killedRole: res.killed ? res.killed.role : null,
    saved: res.saved,
    theft: !!res.theft, // public: everyone hears that something was stolen, not by whom
  };
  record(room, { type: 'NIGHT', name: room.result.killedName, role: room.result.killedRole, saved: res.saved, ...(res.theft && { theft: true }) });
  setPhase(room, 'DAY_RESULT', ctx);
}

function endVoting(room, ctx) {
  const voteLog = Object.entries(room.votes).map(([voterId, targetId]) => ({ voterId, targetId }));
  const res = actions.tallyVotes(room);
  room.result = {
    votes: voteLog,
    type: 'VOTE',
    day: room.day,
    eliminatedId: res.eliminated ? res.eliminated.id : null,
    eliminatedName: res.eliminated ? res.eliminated.name : null,
    eliminatedRole: res.eliminated ? res.eliminated.role : null,
    tie: res.tie,
    counts: res.counts,
  };
  record(room, { type: 'VOTE', name: room.result.eliminatedName, role: room.result.eliminatedRole, tie: res.tie });
  // The Jester's whole plan: get voted out, and the game ends on the spot with them as the winner.
  if (res.eliminated && res.eliminated.role === 'JESTER') return finish(room, ctx, 'JESTER');
  setPhase(room, 'VOTE_RESULT', ctx);
}

// Public events only (deaths are revealed to everyone anyway), so the timeline can be shown to all.
function record(room, event) {
  (room.history ||= []).push({ day: room.day, ...event });
}

// DISCUSSION: marks a living player as ready to vote. Once a majority of the living humans
// (bots never press it) are ready, the discussion clock is dropped and the table moves
// straight to VOTING. Returns { ok } or { error }.
function setReady(room, playerId, ready, ctx) {
  if (room.phase !== 'DISCUSSION') return { error: 'Not discussion time' };
  const p = actions.findPlayer(room, playerId);
  if (!p || !p.alive) return { error: 'Only living players can do that' };
  room.ready ||= {};
  if (ready) room.ready[p.id] = true;
  else delete room.ready[p.id];
  const humans = room.players.filter((x) => x.alive && !x.bot && x.connected !== false);
  const readyN = humans.filter((x) => room.ready[x.id]).length;
  if (humans.length && readyN > humans.length / 2) setPhase(room, 'VOTING', ctx);
  return { ok: true };
}

function onPhaseEnd(room, ctx) {
  switch (room.phase) {
    case 'ROLE_REVEAL':
      return setPhase(room, 'NIGHT', ctx);
    case 'NIGHT':
      return endNight(room, ctx);
    case 'DAY_RESULT': {
      const w = winCheck(room.players);
      return w ? finish(room, ctx, w) : setPhase(room, 'DISCUSSION', ctx);
    }
    case 'DISCUSSION':
      return setPhase(room, 'VOTING', ctx);
    case 'VOTING':
      return endVoting(room, ctx);
    case 'VOTE_RESULT': {
      const w = winCheck(room.players);
      return w ? finish(room, ctx, w) : setPhase(room, 'NIGHT', ctx);
    }
  }
}

// Called after anyone acts so the phase can end early: the night once every night role has
// acted, the vote as soon as its result is decided.
function checkEarlyEnd(room, ctx) {
  if (room.phase === 'NIGHT' && actions.allNightActionsIn(room)) endNight(room, ctx);
  else if (actions.VOTE_PHASES.includes(room.phase) && actions.voteDecided(room)) endVoting(room, ctx);
}

function backToLobby(room, ctx) {
  clearTimers(room);
  room.phase = 'LOBBY';
  room.endsAt = null;
  room.result = null;
  room.winner = null;
  room.players.forEach((p) => {
    p.alive = true;
    p.role = null;
    p.checks = [];
    p.stole = null;
    p.robbed = null;
  });
  ctx.onPhase(room);
  ctx.onChange(room);
}

module.exports = { startGame, setPhase, checkEarlyEnd, setReady, backToLobby, clearTimers, DURATIONS };
