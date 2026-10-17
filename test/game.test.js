const test = require('node:test');
const assert = require('node:assert/strict');
const { assignRoles, mafiaCount } = require('../game/roles');
const { winCheck } = require('../game/winCheck');
const A = require('../game/actions');

const mk = (roles) => ({
  phase: 'NIGHT',
  night: { actions: {} },
  votes: {},
  players: roles.map((role, i) => ({ id: `p${i}`, name: `P${i}`, role, alive: true })),
});

test('mafia count by player count', () => {
  assert.equal(mafiaCount(5), 1);
  assert.equal(mafiaCount(6), 1);
  assert.equal(mafiaCount(7), 2);
  assert.equal(mafiaCount(9), 2);
  assert.equal(mafiaCount(10), 3);
  assert.equal(mafiaCount(12), 3);
});

test('assignRoles gives correct role counts for 5-12 players', () => {
  for (let n = 5; n <= 12; n++) {
    const players = Array.from({ length: n }, (_, i) => ({ id: i }));
    assignRoles(players);
    const c = (r) => players.filter((p) => p.role === r).length;
    assert.equal(c('MAFIA'), mafiaCount(n));
    assert.equal(c('DOCTOR'), 1);
    assert.equal(c('DETECTIVE'), 1);
    assert.equal(c('VILLAGER'), n - mafiaCount(n) - 2);
  }
});

test('winCheck', () => {
  assert.equal(winCheck(mk(['MAFIA', 'DOCTOR', 'VILLAGER']).players.map((p, i) => (i === 0 ? { ...p, alive: false } : p))), 'VILLAGERS');
  assert.equal(winCheck(mk(['MAFIA', 'MAFIA', 'VILLAGER', 'DOCTOR', 'DETECTIVE']).players.map((p, i) => (i > 2 ? { ...p, alive: false } : p))), 'MAFIA');
  assert.equal(winCheck(mk(['MAFIA', 'VILLAGER', 'VILLAGER', 'DOCTOR', 'DETECTIVE']).players), null);
});

test('mafia kill succeeds when doctor saves someone else', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  assert.ok(A.submitNightAction(room, 'p0', 'p3').ok);
  assert.ok(A.submitNightAction(room, 'p1', 'p2').ok);
  const res = A.resolveNight(room);
  assert.equal(res.killed.id, 'p3');
  assert.equal(room.players[3].alive, false);
});

test('doctor save blocks the kill', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  A.submitNightAction(room, 'p0', 'p3');
  A.submitNightAction(room, 'p1', 'p3');
  const res = A.resolveNight(room);
  assert.equal(res.killed, null);
  assert.equal(res.saved, true);
  assert.equal(room.players[3].alive, true);
});

test('detective gets the correct result', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  A.submitNightAction(room, 'p2', 'p0');
  assert.deepEqual(A.resolveNight(room).checks[0], { detectiveId: 'p2', targetId: 'p0', isMafia: true });
});

test('night action validation', () => {
  const room = mk(['MAFIA', 'MAFIA', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  assert.ok(A.submitNightAction(room, 'p3', 'p0').error, 'villager has no action');
  assert.ok(A.submitNightAction(room, 'p0', 'p1').error, 'mafia cannot target mafia');
  assert.ok(A.submitNightAction(room, 'p2', 'p2').error, 'detective cannot check self');
  room.players[4].alive = false;
  assert.ok(A.submitNightAction(room, 'p0', 'p4').error, 'dead target');
  room.players[0].alive = false;
  assert.ok(A.submitNightAction(room, 'p0', 'p3').error, 'dead players cannot act');
  room.phase = 'DISCUSSION';
  assert.ok(A.submitNightAction(room, 'p1', 'p3').error, 'wrong phase');
});

test('allNightActionsIn only waits for living night roles', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  room.players[1].alive = false;
  A.submitNightAction(room, 'p0', 'p3');
  assert.equal(A.allNightActionsIn(room), false);
  A.submitNightAction(room, 'p2', 'p0');
  assert.equal(A.allNightActionsIn(room), true);
});

test('voting: most votes eliminated, tie eliminates nobody', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  room.phase = 'VOTING';
  A.castVote(room, 'p0', 'p3');
  A.castVote(room, 'p1', 'p3');
  A.castVote(room, 'p2', 'p0');
  assert.equal(A.allVotesIn(room), false);
  const res = A.tallyVotes(room);
  assert.equal(res.eliminated.id, 'p3');

  const room2 = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  room2.phase = 'VOTING';
  A.castVote(room2, 'p0', 'p3');
  A.castVote(room2, 'p1', 'p0');
  const r2 = A.tallyVotes(room2);
  assert.equal(r2.eliminated, null);
  assert.equal(r2.tie, true);
});

test('voting validation', () => {
  const room = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  room.phase = 'VOTING';
  assert.ok(A.castVote(room, 'p0', 'p0').error, 'no self vote');
  room.players[1].alive = false;
  assert.ok(A.castVote(room, 'p1', 'p0').error, 'dead cannot vote');
  assert.ok(A.castVote(room, 'p0', 'p1').error, 'cannot vote dead');
});
