const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../game/actions');
const phases = require('../game/phases');
const { teamOf } = require('../game/roles');
const { winCheck } = require('../game/winCheck');
const { stateFor } = require('../view');

const mkCtx = () => {
  const c = { roles: [], gameOver: 0 };
  Object.assign(c, {
    onPhase() {},
    onChange() {},
    onCheck() {},
    onRole(_room, p) { c.roles.push([p.id, p.role]); },
    onGameOver() { c.gameOver++; },
  });
  return c;
};
const mk = (roles, phase = 'NIGHT') => ({
  code: 'TEST',
  phase,
  day: 1,
  night: { actions: {} },
  votes: {},
  ready: {},
  chat: [],
  history: [],
  botTimers: [],
  players: roles.map((role, i) => ({ id: `p${i}`, name: `P${i}`, role, alive: true, connected: true, checks: [] })),
});
const role = (room, id) => A.findPlayer(room, id).role;

// ── Jester ──

test('the Jester is their own team and has no night action', () => {
  assert.equal(teamOf('JESTER'), 'JESTER');
  const room = mk(['MAFIA', 'JESTER', 'DOCTOR', 'DETECTIVE', 'VILLAGER']);
  assert.match(A.submitNightAction(room, 'p1', 'p0').error, /no night action/);
});

test('the Detective sees the Jester as not Mafia', () => {
  const room = mk(['MAFIA', 'JESTER', 'DOCTOR', 'DETECTIVE', 'VILLAGER']);
  A.submitNightAction(room, 'p3', 'p1');
  assert.deepEqual(A.resolveNight(room).checks, [{ detectiveId: 'p3', targetId: 'p1', isMafia: false }]);
});

test('a Jester voted out wins at once and the game ends', () => {
  const room = mk(['MAFIA', 'JESTER', 'DOCTOR', 'DETECTIVE', 'VILLAGER'], 'VOTING');
  const ctx = mkCtx();
  for (const v of ['p0', 'p2', 'p3', 'p4']) A.castVote(room, v, 'p1');
  phases.checkEarlyEnd(room, ctx);
  assert.equal(room.phase, 'GAME_OVER');
  assert.equal(room.winner, 'JESTER');
  assert.equal(ctx.gameOver, 1);
  assert.equal(room.result.eliminatedRole, 'JESTER');
  assert.equal(stateFor(room, room.players[1]).you.team, 'JESTER', 'the Jester sees their own win');
});

test('a Jester killed at night just dies; the game goes on', () => {
  const room = mk(['MAFIA', 'JESTER', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  A.submitNightAction(room, 'p0', 'p1');
  A.resolveNight(room);
  assert.equal(A.findPlayer(room, 'p1').alive, false);
  assert.equal(winCheck(room.players), null);
});

test('voting out someone else keeps the game going', () => {
  const room = mk(['MAFIA', 'JESTER', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER'], 'VOTING');
  const ctx = mkCtx();
  for (const v of ['p0', 'p1', 'p2', 'p3', 'p5']) A.castVote(room, v, 'p4');
  try {
    phases.checkEarlyEnd(room, ctx);
    assert.equal(room.phase, 'VOTE_RESULT');
    assert.ok(!room.winner);
  } finally {
    phases.clearTimers(room);
  }
});

// ── Thief ──

test('the Thief takes a Mafia role; the victim becomes a Villager', () => {
  const room = mk(['MAFIA', 'THIEF', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  A.submitNightAction(room, 'p1', 'p0');
  const res = A.resolveNight(room);
  assert.deepEqual(res.theft, { thiefId: 'p1', targetId: 'p0', role: 'MAFIA' });
  assert.equal(role(room, 'p1'), 'MAFIA');
  assert.equal(role(room, 'p0'), 'VILLAGER');
});

test('the Thief cannot rob themselves, and only acts at night', () => {
  const room = mk(['MAFIA', 'THIEF', 'DOCTOR', 'DETECTIVE', 'VILLAGER']);
  assert.match(A.submitNightAction(room, 'p1', 'p1').error, /yourself/);
  room.phase = 'DISCUSSION';
  assert.match(A.submitNightAction(room, 'p1', 'p0').error, /Not night/);
});

test('the night resolves on dusk roles: the robbed Mafia still kills, checks see the old roles', () => {
  const room = mk(['MAFIA', 'THIEF', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  A.submitNightAction(room, 'p0', 'p4'); // mafia kills p4
  A.submitNightAction(room, 'p1', 'p0'); // thief robs the mafia
  A.submitNightAction(room, 'p3', 'p1'); // detective checks the thief
  const res = A.resolveNight(room);
  assert.equal(res.killed.id, 'p4');
  assert.deepEqual(res.checks[0], { detectiveId: 'p3', targetId: 'p1', isMafia: false });
  assert.equal(role(room, 'p1'), 'MAFIA');
});

test("robbing the night's victim gets nothing; the Thief settles as a Villager", () => {
  const room = mk(['MAFIA', 'THIEF', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  A.submitNightAction(room, 'p0', 'p2');
  A.submitNightAction(room, 'p1', 'p2');
  const res = A.resolveNight(room);
  assert.equal(res.theft, null);
  assert.equal(role(room, 'p1'), 'VILLAGER');
  assert.equal(res.killed.role, 'DOCTOR', 'the dead keep their real role');
});

test('a Thief who never acts becomes a Villager; a killed Thief stays the Thief', () => {
  const idle = mk(['MAFIA', 'THIEF', 'DOCTOR', 'DETECTIVE', 'VILLAGER']);
  assert.equal(A.resolveNight(idle).theft, null);
  assert.equal(role(idle, 'p1'), 'VILLAGER');

  const shot = mk(['MAFIA', 'THIEF', 'DOCTOR', 'DETECTIVE', 'VILLAGER']);
  A.submitNightAction(shot, 'p0', 'p1');
  A.submitNightAction(shot, 'p1', 'p3');
  const res = A.resolveNight(shot);
  assert.equal(res.theft, null);
  assert.equal(res.killed.role, 'THIEF');
  assert.equal(role(shot, 'p3'), 'DETECTIVE');
});

test("the Thief can steal the Jester's win condition", () => {
  const room = mk(['MAFIA', 'THIEF', 'JESTER', 'DETECTIVE', 'VILLAGER', 'DOCTOR']);
  A.submitNightAction(room, 'p1', 'p2');
  A.resolveNight(room);
  assert.equal(role(room, 'p1'), 'JESTER');
  assert.equal(role(room, 'p2'), 'VILLAGER');
});

test('after a theft both players are told, the town hears of it, and the Mafia see their new member', () => {
  const room = mk(['MAFIA', 'MAFIA', 'THIEF', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  const ctx = mkCtx();
  A.submitNightAction(room, 'p2', 'p0');
  try {
    phases.checkEarlyEnd(room, ctx);
    assert.equal(room.phase, 'NIGHT', 'still waiting on the other night roles');
    for (const id of ['p0', 'p1', 'p3', 'p4']) A.submitNightAction(room, id, 'p5');
    phases.checkEarlyEnd(room, ctx);
    assert.equal(room.phase, 'DAY_RESULT');
    assert.deepEqual(ctx.roles, [['p2', 'MAFIA'], ['p0', 'VILLAGER']]);
    assert.equal(room.result.theft, true);
    assert.equal(room.history[0].theft, true);

    const thief = stateFor(room, room.players[2]).you;
    assert.deepEqual(thief.stole, { targetId: 'p0', role: 'MAFIA', day: 1 });
    assert.equal(thief.team, 'MAFIA');
    const victim = stateFor(room, room.players[0]).you;
    assert.deepEqual(victim.robbed, { role: 'MAFIA', day: 1 });
    assert.equal(victim.mafiaChat, null, 'the victim is out of the family channel');

    const mate = stateFor(room, room.players[1]);
    assert.equal(mate.players.find((p) => p.id === 'p2').role, 'MAFIA', 'the family sees the thief');
    assert.equal(mate.players.find((p) => p.id === 'p0').role, undefined, 'and no longer sees the victim');
    assert.equal(stateFor(room, room.players[6]).players.find((p) => p.id === 'p2').role, undefined, 'the town sees nothing');
  } finally {
    phases.clearTimers(room);
  }
});
