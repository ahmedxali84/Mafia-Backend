const test = require('node:test');
const assert = require('node:assert/strict');
const phases = require('../game/phases');
const { stateFor } = require('../view');

const ctx = { onPhase() {}, onChange() {}, onRole() {}, onCheck() {}, onGameOver() {} };
const mk = (roles, phase = 'DISCUSSION') => ({
  code: 'TEST',
  phase,
  day: 1,
  night: { actions: {} },
  votes: {},
  ready: {},
  chat: [],
  botTimers: [],
  players: roles.map((role, i) => ({ id: `p${i}`, name: `P${i}`, role, alive: true, connected: true, checks: [] })),
});

test('discussion skips to voting once a majority of living humans are ready', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER', 'VILLAGER']);
  room.players[5].bot = true; // bots don't count
  room.players[4].alive = false; // nor do the dead -> 4 humans, majority is 3
  try {
    assert.ok(phases.setReady(room, 'p0', true, ctx).ok);
    assert.ok(phases.setReady(room, 'p1', true, ctx).ok);
    assert.deepEqual(stateFor(room, room.players[2]).readyIds.sort(), ['p0', 'p1']);
    assert.equal(room.phase, 'DISCUSSION', '2 of 4 is only half');
    assert.ok(phases.setReady(room, 'p1', false, ctx).ok, 'can take it back');
    phases.setReady(room, 'p2', true, ctx);
    assert.equal(room.phase, 'DISCUSSION');
    phases.setReady(room, 'p3', true, ctx);
    assert.equal(room.phase, 'VOTING', '3 of 4 is a majority');
    assert.ok(room.endsAt > Date.now(), 'the voting round runs on its own clock');
    assert.ok(phases.setReady(room, 'p0', true, ctx).error, 'only during discussion');
    assert.ok(phases.setReady(mk(['MAFIA', 'DOCTOR']), 'nobody', true, ctx).error);
  } finally {
    phases.clearTimers(room);
  }
});

test('a Mafia member sees teammates’ night picks; nobody else does', () => {
  const room = mk(['MAFIA', 'MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER', 'VILLAGER'], 'NIGHT');
  room.night.actions = { p1: 'p4', p2: 'p4' };
  assert.deepEqual(stateFor(room, room.players[0]).you.mafiaPicks, { p1: 'p4' });
  assert.deepEqual(stateFor(room, room.players[1]).you.mafiaPicks, {}, 'own pick is nightTarget, not a teammate pick');
  assert.deepEqual(stateFor(room, room.players[3]).you.mafiaPicks, {});
  room.phase = 'DISCUSSION';
  assert.deepEqual(stateFor(room, room.players[0]).you.mafiaPicks, {});
});

test('the match timeline records each night and vote', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER'], 'LOBBY');
  room.host = 'p0';
  try {
    phases.startGame(room, ctx);
    assert.deepEqual(room.history, []);
    const mafia = room.players.find((p) => p.role === 'MAFIA');
    const victim = room.players.find((p) => p.role === 'VILLAGER');
    phases.setPhase(room, 'NIGHT', ctx);
    room.night.actions[mafia.id] = victim.id;
    phases.checkEarlyEnd(room, ctx); // not everyone acted yet
    room.players.filter((p) => ['DOCTOR', 'DETECTIVE'].includes(p.role)).forEach((p) => (room.night.actions[p.id] = mafia.id));
    phases.checkEarlyEnd(room, ctx);
    assert.equal(room.phase, 'DAY_RESULT');
    assert.deepEqual(room.history, [{ day: 1, type: 'NIGHT', name: victim.name, role: 'VILLAGER', saved: false }]);
    assert.equal(stateFor(room, room.players[0]).history.length, 1);
  } finally {
    phases.clearTimers(room);
  }
});
