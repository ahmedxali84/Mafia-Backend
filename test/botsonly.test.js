// Audit 31 Oct 2026: when every human is dead or gone, nobody can talk or press "Vote now", so the
// discussion must not make the spectators wait the full 2 minutes.
process.env.TIMER_SCALE = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setPhase, clearTimers, DURATIONS } = require('../game/phases');

const ctx = { onChange() {}, onPhase() {}, onRole() {}, onCheck() {}, onGameOver() {} };
const room = (humanAlive, humanConnected = true) => ({
  code: 'BOTS', phase: 'DAY_RESULT', day: 1, night: { actions: {} }, votes: {}, chat: [], timer: null, botTimers: [], history: [],
  players: [
    { id: 'h', name: 'Human', alive: humanAlive, connected: humanConnected, role: 'VILLAGER', checks: [] },
    ...['a', 'b', 'c'].map((id) => ({ id, name: id, bot: true, alive: true, connected: true, role: id === 'a' ? 'MAFIA' : 'VILLAGER', checks: [] })),
  ],
});

test('only bots alive: discussion is cut to 15 s', () => {
  const r = room(false);
  setPhase(r, 'DISCUSSION', ctx);
  assert.equal(r.phaseMs, 15000);
  clearTimers(r);
});

test('the only living human has left: discussion is cut to 15 s', () => {
  const r = room(true, false);
  setPhase(r, 'DISCUSSION', ctx);
  assert.equal(r.phaseMs, 15000);
  clearTimers(r);
});

test('a living, connected human: the full discussion time', () => {
  const r = room(true);
  setPhase(r, 'DISCUSSION', ctx);
  assert.equal(r.phaseMs, DURATIONS.DISCUSSION);
  clearTimers(r);
});
