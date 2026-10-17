const test = require('node:test');
const assert = require('node:assert/strict');
const { voiceFor, stateFor } = require('../view');

// m0, m1 = Mafia, doc, det, v = villager, g = dead villager (ghost). Everyone is in voice.
const mk = (phase) => ({
  phase,
  night: { actions: {} },
  votes: {},
  chat: [],
  players: [
    ['m0', 'MAFIA'], ['m1', 'MAFIA'], ['doc', 'DOCTOR'], ['det', 'DETECTIVE'], ['v', 'VILLAGER'], ['g', 'VILLAGER'],
  ].map(([id, role]) => ({ id, name: id, role, alive: id !== 'g', connected: true, voice: { session: `s-${id}`, muted: false } })),
});
const P = (room, id) => room.players.find((p) => p.id === id);
const sorted = (a) => [...a].sort();

test('lobby and game over: everyone hears everyone', () => {
  for (const phase of ['LOBBY', 'GAME_OVER']) {
    const room = mk(phase);
    const v = voiceFor(room, P(room, 'v'));
    assert.equal(v.channel, 'public');
    assert.deepEqual(sorted(v.sendTo), ['det', 'doc', 'g', 'm0', 'm1']);
    assert.deepEqual(sorted(v.hearFrom), ['det', 'doc', 'g', 'm0', 'm1']);
  }
});

test('role reveal: nobody talks', () => {
  const room = mk('ROLE_REVEAL');
  for (const p of room.players) assert.deepEqual(voiceFor(room, p).sendTo, []);
});

test('night: only Mafia hear Mafia, town is silent, ghosts talk to ghosts', () => {
  const room = mk('NIGHT');
  P(room, 'm1').alive = false; // a dead mafioso still hears the family (like mafia chat), but talks as a ghost
  assert.deepEqual(voiceFor(room, P(room, 'm0')).sendTo, ['m1']);
  for (const id of ['doc', 'det', 'v']) {
    const v = voiceFor(room, P(room, id));
    assert.equal(v.channel, null);
    assert.deepEqual(v.sendTo, [], `${id} cannot talk at night`);
    assert.ok(!v.hearFrom.includes('m0'), `${id} must not hear the Mafia`);
  }
  assert.deepEqual(sorted(voiceFor(room, P(room, 'g')).sendTo), ['m1']);
  assert.deepEqual(sorted(voiceFor(room, P(room, 'm1')).sendTo), ['g']);
});

test('day: the living talk to all, the dead only to the dead', () => {
  for (const phase of ['DAY_RESULT', 'DISCUSSION', 'VOTING', 'VOTE_RESULT']) {
    const room = mk(phase);
    assert.deepEqual(sorted(voiceFor(room, P(room, 'v')).sendTo), ['det', 'doc', 'g', 'm0', 'm1']);
    assert.deepEqual(voiceFor(room, P(room, 'g')).sendTo, []); // no other ghosts
    assert.ok(!voiceFor(room, P(room, 'v')).hearFrom.includes('g'));
    assert.ok(voiceFor(room, P(room, 'g')).hearFrom.includes('v'));
  }
});

test('only connected humans in voice are routed', () => {
  const room = mk('DISCUSSION');
  P(room, 'doc').voice = null;
  P(room, 'det').connected = false;
  P(room, 'v').bot = true;
  assert.deepEqual(sorted(voiceFor(room, P(room, 'm0')).sendTo), ['g', 'm1']);
});

test('state exposes voice sessions and your own routes only', () => {
  const room = mk('NIGHT');
  const st = stateFor(room, P(room, 'v'));
  assert.deepEqual(st.players.find((p) => p.id === 'm0').voice, { session: 's-m0', muted: false });
  assert.deepEqual(st.you.voice, { channel: null, sendTo: [], hearFrom: [] });
});
