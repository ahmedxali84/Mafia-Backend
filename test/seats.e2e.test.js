// Audit 31 Oct 2026: every client receives every player's id, so the id alone must not be enough
// to take over a seat. A private seat key (only its hash is stored) is required to reclaim it.
process.env.NODE_ENV = 'test';
process.env.TIMER_SCALE = '0.2';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const { rooms } = require('../rooms');
const { clearTimers } = require('../game/phases');

const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY_V = 'victim-private-key-0123456789abcdef';
const KEY_A = 'attacker-private-key-0123456789abcd';

let url;
const sockets = [];
const tab = () => { const s = connect(url, { forceNew: true }); sockets.push(s); return s; };
test.before(() => new Promise((r) => server.listen(0, () => { url = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { sockets.forEach((s) => s.close()); Object.values(rooms).forEach(clearTimers); io.close(); });

test('someone with only the public id cannot take over a seat (or see its role)', async () => {
  const victim = tab();
  const attacker = tab();
  let aState;
  attacker.on('state', (s) => (aState = s));
  const { code } = await emit(victim, 'create_room', { playerId: 'victim-id', name: 'Victim', bots: 4, secret: KEY_V });
  await emit(attacker, 'join_room', { code, playerId: 'attacker-id', name: 'Attacker', secret: KEY_A });
  await emit(victim, 'start_game', {});
  await sleep(200);
  const victimId = aState.players.find((p) => p.name === 'Victim').id;

  const thief = tab();
  for (const secret of [undefined, KEY_A, 'x'.repeat(40)]) {
    const res = await emit(thief, 'rejoin_room', { code, playerId: victimId, secret });
    assert.equal(res.error, 'That seat belongs to another player', `refused with secret=${secret}`);
  }
  assert.equal(rooms[code].players.find((p) => p.id === victimId).socketId, victim.id, 'victim keeps the connection');
});

test('a real refresh (same id + same key) gets the seat back', async () => {
  const a = tab();
  const { code } = await emit(a, 'create_room', { playerId: 'p-refresh', name: 'Host', secret: KEY_V });
  a.close();
  const again = tab();
  const res = await emit(again, 'rejoin_room', { code, playerId: 'p-refresh', secret: KEY_V });
  assert.ok(res.ok, res.error);
});

test('bot seats cannot be taken over by id', async () => {
  const h = tab();
  let st;
  h.on('state', (s) => (st = s));
  const { code } = await emit(h, 'create_room', { playerId: 'p-host', name: 'Host', bots: 4, secret: KEY_V });
  await sleep(100);
  const bot = st.players.find((p) => p.bot);
  const res = await emit(tab(), 'join_room', { code, playerId: bot.id, name: 'Sneaky', secret: KEY_A });
  assert.equal(res.error, 'That seat belongs to another player');
});

test('older clients without a key still play; the seat is keyed on its first keyed join', async () => {
  const h = tab();
  const { code } = await emit(h, 'create_room', { playerId: 'p-old', name: 'Old' });
  assert.ok((await emit(tab(), 'rejoin_room', { code, playerId: 'p-old' })).ok, 'no key on either side still works');
  assert.ok((await emit(tab(), 'rejoin_room', { code, playerId: 'p-old', secret: KEY_V })).ok);
  assert.equal((await emit(tab(), 'rejoin_room', { code, playerId: 'p-old' })).error, 'That seat belongs to another player', 'now keyed');
});
