const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../game/whispers');
const { stateFor, canSeeMessage } = require('../view');

const mk = (phase = 'DISCUSSION') => {
  const room = {
    phase,
    night: { actions: {} },
    votes: {},
    chat: [],
    players: ['A', 'B', 'C', 'D', 'E'].map((n, i) => ({ id: `p${i}`, name: n, role: 'VILLAGER', alive: true })),
  };
  W.resetWhispers(room);
  return room;
};

test('everyone starts with the whisper allowance', () => {
  const room = mk();
  assert.ok(room.players.every((p) => p.whispersLeft === W.WHISPERS_PER_GAME));
});

test('a whisper costs one use and runs out', () => {
  const room = mk();
  assert.ok(W.sendWhisper(room, 'p0', 'p1', 'hi').whisper);
  assert.equal(room.players[0].whispersLeft, 1);
  assert.ok(W.sendWhisper(room, 'p0', 'p2', 'psst').whisper);
  assert.equal(W.sendWhisper(room, 'p0', 'p3', 'again').error, 'You have no whispers left');
  // The receiver replying uses THEIR own allowance
  assert.ok(W.sendWhisper(room, 'p1', 'p0', 'reply').whisper);
});

test('validation: phase, dead, self, empty, bad target', () => {
  assert.ok(W.sendWhisper(mk('NIGHT'), 'p0', 'p1', 'x').error);
  assert.ok(W.sendWhisper(mk('LOBBY'), 'p0', 'p1', 'x').error);
  assert.ok(W.sendWhisper(mk('VOTING'), 'p0', 'p1', 'x').whisper);
  const room = mk();
  room.players[1].alive = false;
  assert.ok(W.sendWhisper(room, 'p0', 'p1', 'x').error, 'dead target');
  assert.ok(W.sendWhisper(room, 'p1', 'p0', 'x').error, 'dead sender');
  assert.ok(W.sendWhisper(room, 'p0', 'p0', 'x').error, 'self');
  assert.ok(W.sendWhisper(room, 'p0', 'p2', '   ').error, 'empty');
  assert.ok(W.sendWhisper(room, 'p0', 'nobody', 'x').error, 'unknown');
  assert.equal(room.players[0].whispersLeft, W.WHISPERS_PER_GAME, 'failed attempts cost nothing');
});

test('text is capped; no public notice is produced', () => {
  const room = mk();
  const res = W.sendWhisper(room, 'p0', 'p1', 'secret '.repeat(100));
  assert.equal(res.whisper.text.length, W.MAX_LEN);
  assert.deepEqual(Object.keys(res), ['whisper']);
});

test('only sender and receiver know about a whisper', () => {
  const room = mk();
  const { whisper } = W.sendWhisper(room, 'p0', 'p1', 'the doctor is C');
  room.chat.push(whisper);
  const seen = (id) => stateFor(room, room.players.find((p) => p.id === id)).chat.map((m) => m.channel);
  assert.deepEqual(seen('p0'), ['whisper']);
  assert.deepEqual(seen('p1'), ['whisper']);
  for (const id of ['p2', 'p3', 'p4']) assert.deepEqual(seen(id), [], `${id} must not know a whisper happened`);
  // dead players (ghost chat) do not get to read whispers either
  room.players[4].alive = false;
  assert.equal(canSeeMessage(room, room.players[4], whisper), false);
});

test('stateFor exposes only your own whispers-left counter', () => {
  const room = mk();
  W.sendWhisper(room, 'p0', 'p1', 'x');
  assert.equal(stateFor(room, room.players[0]).you.whispersLeft, 1);
  assert.equal(stateFor(room, room.players[1]).you.whispersLeft, 2);
});
