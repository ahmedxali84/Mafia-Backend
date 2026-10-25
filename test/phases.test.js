process.env.TIMER_SCALE = '0.001'; // read when phases.js loads, so set it first
const test = require('node:test');
const assert = require('node:assert/strict');
const { PHASES, DURATIONS, startGame, clearTimers } = require('../game/phases');

const ctx = () => {
  const seen = [];
  return {
    seen,
    roles: [],
    onChange() {},
    onPhase(room) { seen.push(room.phase); },
    onRole(room, p) { this.roles.push(p.id); },
    onCheck() {},
    onGameOver() {},
  };
};

const lobby = (n) => ({
  phase: 'LOBBY',
  players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, connected: true })),
});

const waitFor = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

test('phase list is in game order and every timed phase is in it', () => {
  assert.deepEqual(PHASES, ['LOBBY', 'ROLE_REVEAL', 'NIGHT', 'DAY_RESULT', 'DISCUSSION', 'VOTING', 'VOTE_RESULT', 'GAME_OVER']);
  for (const p of Object.keys(DURATIONS)) assert.ok(PHASES.includes(p), p);
});

test('startGame refuses too few players and a started game', () => {
  assert.match(startGame(lobby(4), ctx()).error, /at least 5/);
  const room = lobby(5);
  room.phase = 'NIGHT';
  assert.match(startGame(room, ctx()).error, /already started/);
});

test('LOBBY -> ROLE_REVEAL -> NIGHT', async () => {
  const room = lobby(5);
  const c = ctx();
  assert.deepEqual(startGame(room, c), { ok: true });
  assert.equal(room.phase, 'ROLE_REVEAL');
  assert.equal(c.roles.length, 5, 'every player is told their role');
  assert.ok(room.players.every((p) => p.alive && p.role));

  await waitFor(() => room.phase === 'NIGHT');
  assert.equal(room.day, 1);
  assert.deepEqual(c.seen.slice(0, 2), ['ROLE_REVEAL', 'NIGHT']);
  clearTimers(room);
});
