// QA audit: timers and room lifetimes. Fake clocks for the cleanup windows (10 s lobby
// grace, 15 s empty lobby, 5 min abandoned game) plus the room bugs found in the audit.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const rm = require('../rooms');
const { rooms } = rm;

const human = (room, id) => {
  const res = rm.joinRoom(room.code, id, id);
  assert.ok(res.player, res.error);
  return res.player;
};
const noop = () => {};
const SEC = 1000;
// Advance the fake clock in 1 s steps, so timers started by other timers also fire.
const wait = (t, ms) => { for (let i = 0; i < ms; i += SEC) t.mock.timers.tick(SEC); };

test('lobby: a dropped player is removed after 10 s, the empty room after 15 s more', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = rm.createRoom('host', 'Host');
  human(room, 'guest');
  rm.disconnect(room, 'guest', noop);
  wait(t, 9 * SEC);
  assert.ok(room.players.some((p) => p.id === 'guest'), 'still inside the grace period');
  wait(t, 2 * SEC);
  assert.ok(!room.players.some((p) => p.id === 'guest'), 'removed after 10 s');

  rm.disconnect(room, 'host', noop);
  wait(t, 30 * SEC);
  assert.equal(rooms[room.code], undefined, 'empty lobby deleted');
});

test('abandoned game: deleted 5 min after the last human leaves, and its timers stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = rm.createRoom('h1', 'Host');
  rm.addBots(room, 4);
  room.phase = 'NIGHT';
  let fired = false;
  room.timer = setTimeout(() => (fired = true), 10 * 60 * SEC); // a phase timer still pending
  rm.disconnect(room, 'h1', noop);
  wait(t, 4 * 60 * SEC);
  assert.ok(rooms[room.code], 'kept for 5 minutes so the player can come back');
  wait(t, 61 * SEC);
  assert.equal(rooms[room.code], undefined, 'deleted after 5 minutes');
  wait(t, 10 * 60 * SEC);
  assert.equal(fired, false, 'the phase timer was cleared with the room');
});

test('coming back in time cancels the deletion', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = rm.createRoom('h2', 'Host');
  room.phase = 'DISCUSSION';
  rm.disconnect(room, 'h2', noop);
  wait(t, 4 * 60 * SEC);
  rm.joinRoom(room.code, 'h2');
  wait(t, 10 * 60 * SEC);
  assert.equal(rooms[room.code], room);
});

test('a late cleanup timer never deletes a newer room that reused the same code', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = rm.createRoom('h3', 'Host');
  rm.disconnect(old, 'h3', noop); // schedules the old room's deletion
  // The old room disappears another way and a new room gets the same code.
  delete rooms[old.code];
  const fresh = { ...rm.createRoom('h4', 'Other'), code: old.code };
  delete rooms[fresh.code];
  rooms[old.code] = fresh;
  wait(t, 60 * SEC);
  assert.equal(rooms[old.code], fresh, 'the new room survives');
  delete rooms[old.code];
});

test('bug fix: host and guest drop; whoever comes back first becomes host', () => {
  const room = rm.createRoom('H', 'Host');
  human(room, 'G');
  room.phase = 'NIGHT';
  rm.disconnect(room, 'H', noop); // host passes to G
  rm.disconnect(room, 'G', noop); // nobody left to pass to
  assert.equal(room.host, 'G');
  rm.joinRoom(room.code, 'H'); // H returns, G is still away
  assert.equal(room.host, 'H', 'the returning player can start/replay the room');
  rm.joinRoom(room.code, 'G');
  assert.equal(room.host, 'H', 'a connected host is never replaced');
  delete rooms[room.code];
});

test('bug fix: after Play again, players who left mid-game lose their seat after the grace period', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = rm.createRoom('P1', 'Host');
  human(room, 'P2');
  room.phase = 'VOTING';
  rm.disconnect(room, 'P2', noop); // leaves mid-game: seat kept for autopilot
  wait(t, 60 * SEC);
  assert.ok(room.players.some((p) => p.id === 'P2'), 'kept during the game');
  room.phase = 'LOBBY'; // host pressed Play again
  rm.dropOffline(room, noop);
  wait(t, 5 * SEC);
  assert.ok(room.players.some((p) => p.id === 'P2'), 'a refresh still has 10 s to come back');
  wait(t, 6 * SEC);
  assert.deepEqual(room.players.map((p) => p.id), ['P1']);
  delete rooms[room.code];
});
