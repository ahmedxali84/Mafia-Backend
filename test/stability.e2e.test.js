// Week 6: performance and stability. Lean state updates (no repeated chat log), event flood limit,
// oversized messages, and the server staying up through all of it.
process.env.TIMER_SCALE = '0.05';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const rm = require('../rooms');
const { canSeeMessage } = require('../view');

let url;
test.before(() => new Promise((r) => server.listen(0, () => {
  url = `http://localhost:${server.address().port}`;
  r();
})));
test.after(() => io.close());

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tab(id) {
  const t = { id, socket: connect(url, { forceNew: true }), states: [], chat: [], log: [] };
  // `log` is what a lean client shows: the last full log it got, plus messages since.
  t.socket.on('state', (st) => {
    t.states.push(st);
    if (st.chat) t.log = [...st.chat];
  });
  t.socket.on('chat_message', (m) => {
    t.chat.push(m);
    if (!t.log.some((x) => x.id === m.id)) t.log.push(m);
  });
  return t;
}
// The lean client's chat must be exactly what the server says this player may read:
// nothing extra (a leak), and nothing missing (ignoring messages still in flight).
function chatCheck(room, t) {
  const me = room.players.find((p) => p.id === t.id);
  const may = room.chat.filter((m) => canSeeMessage(room, me, m));
  const mayIds = new Set(may.map((m) => m.id));
  const shownIds = new Set(t.log.map((m) => m.id));
  return {
    extra: t.log.filter((m) => !mayIds.has(m.id) && room.chat.some((x) => x.id === m.id)).map((m) => `${m.channel}:${m.text}`),
    missing: may.filter((m) => !shownIds.has(m.id) && Date.now() - m.ts > 300).map((m) => `${m.channel}:${m.text}`),
  };
}

test('lean clients get the chat log on join and when what they can read changes, not in every update', { timeout: 120000 }, async () => {
  const lean = tab(`lean-${Math.random()}`);
  const old = tab(`old-${Math.random()}`);
  const { code } = await emit(lean.socket, 'create_room', { playerId: lean.id, name: 'Lean', bots: 5, features: ['lean-state'] });
  await emit(old.socket, 'join_room', { code, playerId: old.id, name: 'Old' });
  await sleep(100);
  assert.ok(lean.states.at(-1), 'got state');
  assert.ok('chat' in lean.states[0], 'the first state after joining carries the log');

  for (let i = 0; i < 3; i++) {
    assert.ok((await emit(old.socket, 'chat_message', { text: `hello ${i}` })).ok);
    await sleep(650); // chat has a 600 ms per-player limit
  }
  await emit(lean.socket, 'add_bots', { count: 1 }); // a plain update for everyone
  await sleep(100);
  assert.equal('chat' in lean.states.at(-1), false, 'no chat log in an ordinary update');
  assert.equal(lean.chat.filter((m) => m.text.startsWith('hello')).length, 3, 'the messages arrived as events');
  assert.equal(old.states.at(-1).chat.filter((m) => m.text.startsWith('hello')).length, 3, 'older clients still get the log every time');

  // A new game: the lean client gets the fresh (empty) log.
  const room = rm.rooms[code];
  assert.ok((await emit(lean.socket, 'start_game', {})).ok);
  await sleep(50);
  assert.ok('chat' in lean.states.at(-1), 'a new game starts a fresh log');
  // Through the whole game (deaths, a possible theft, the end), the lean client's chat always matches
  // what it may read: nothing missing, nothing extra.
  const deadline = Date.now() + 90000; // the two humans never act, so some games run long
  let checks = 0;
  while (room.phase !== 'GAME_OVER' && Date.now() < deadline) {
    await sleep(40);
    if (room.chat.length) {
      assert.deepEqual(chatCheck(room, lean), { extra: [], missing: [] }, `chat mismatch in ${room.phase}`);
      checks++;
    }
  }
  await sleep(100);
  assert.equal(room.phase, 'GAME_OVER');
  assert.deepEqual(chatCheck(room, lean), { extra: [], missing: [] }, 'chat matches at game over');
  assert.ok(lean.states.filter((st) => 'chat' in st).length < lean.states.length / 2, 'most updates leave the log out');

  // A refresh gets the log again.
  lean.socket.close();
  const again = tab(lean.id);
  assert.ok((await emit(again.socket, 'rejoin_room', { code, playerId: lean.id, features: ['lean-state'] })).ok);
  await sleep(100);
  assert.ok('chat' in again.states[0]);
  again.socket.close();
  old.socket.close();
});

test('a client flooding events is told to slow down; others are unaffected', async () => {
  const spam = tab(`spam-${Math.random()}`);
  const other = tab(`calm-${Math.random()}`);
  const { code } = await emit(spam.socket, 'create_room', { playerId: spam.id, name: 'Spam', bots: 4 });
  await emit(other.socket, 'join_room', { code, playerId: other.id, name: 'Calm' });
  const answers = await Promise.all(Array.from({ length: 80 }, () => emit(spam.socket, 'ready_vote', { ready: true })));
  const limited = answers.filter((a) => a?.error === 'Too many requests, slow down').length;
  assert.ok(limited >= 30, `about half of 80 events in one second are refused (got ${limited})`);
  assert.ok((await emit(other.socket, 'add_bots', { count: 0 })).error, 'the other player still gets normal answers');
  await sleep(1100);
  assert.ok(!(await emit(spam.socket, 'add_bots', { count: 1 })).error?.includes('Too many'), 'the limit resets after a second');
  spam.socket.close();
  other.socket.close();
});

test('an oversized message is dropped and the server keeps running', async () => {
  const big = tab(`big-${Math.random()}`);
  await new Promise((r) => big.socket.on('connect', r));
  const closed = new Promise((r) => big.socket.on('disconnect', r));
  big.socket.emit('chat_message', { text: 'x'.repeat(300_000) });
  await Promise.race([closed, sleep(3000)]);
  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200, 'still serving');
  const fresh = tab(`fresh-${Math.random()}`);
  assert.ok((await emit(fresh.socket, 'create_room', { playerId: fresh.id, name: 'Fresh' })).ok);
  big.socket.close();
  fresh.socket.close();
});
