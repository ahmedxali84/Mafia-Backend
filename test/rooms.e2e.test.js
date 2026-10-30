// Week 2 QA: the "5 browser tabs" room test, automated. Every client is a real
// Socket.IO connection, exactly like a browser tab.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const { rooms } = require('../rooms');
const { MAX_PLAYERS } = require('../game/roles');
const { clearTimers } = require('../game/phases');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const until = (fn, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(iv); reject(new Error('timeout')); }, ms);
    const iv = setInterval(() => { if (fn()) { clearTimeout(t); clearInterval(iv); resolve(); } }, 20);
  });

let url;
const open = [];
function tab(id, name = id) {
  const socket = connect(url, { forceNew: true });
  const c = { id, name, socket, list: [], state: null };
  socket.on('room_update', (l) => (c.list = l));
  socket.on('state', (st) => (c.state = st));
  open.push(socket);
  return c;
}
const names = (c) => c.list.map((p) => p.name).sort();

test.before(() => new Promise((r) => server.listen(0, () => { url = `http://localhost:${server.address().port}`; r(); })));
test.after(() => {
  open.forEach((s) => s.close());
  Object.values(rooms).forEach(clearTimers);
  io.close();
});

test('5 tabs: create, join, and everyone sees the same live player list', async () => {
  const tabs = ['Ali', 'Sara', 'Bilal', 'Hina', 'Zain'].map((n, i) => tab(`t${i}`, n));
  const created = await emit(tabs[0].socket, 'create_room', { playerId: tabs[0].id, name: tabs[0].name });
  assert.ok(created.ok);
  assert.match(created.code, /^[A-Z2-9]{4}$/);

  for (const [i, c] of tabs.slice(1).entries()) {
    const res = await emit(c.socket, 'join_room', { code: created.code, playerId: c.id, name: c.name });
    assert.ok(res.ok, res.error);
    // Everyone already in the room sees the newcomer straight away.
    await until(() => tabs.slice(0, i + 2).every((t) => t.list.length === i + 2));
  }
  const expected = tabs.map((t) => t.name).sort();
  for (const t of tabs) assert.deepEqual(names(t), expected);
  for (const t of tabs) assert.equal(t.state.hostId, tabs[0].id);
  for (const t of tabs) assert.ok(t.list.every((p) => !('role' in p)), 'room_update carries no roles');
});

test('codes are case-insensitive; a wrong code is rejected', async () => {
  const host = tab('c-host', 'Host');
  const { code } = await emit(host.socket, 'create_room', { playerId: host.id, name: host.name });
  const guest = tab('c-guest', 'Guest');
  assert.equal((await emit(guest.socket, 'join_room', { code: 'QQQQ', playerId: guest.id, name: 'Guest' })).error, 'Room not found');
  assert.equal((await emit(guest.socket, 'join_room', { code: '', playerId: guest.id, name: 'Guest' })).error, 'Room not found');
  assert.ok((await emit(guest.socket, 'join_room', { code: code.toLowerCase(), playerId: guest.id, name: 'Guest' })).ok);
});

test('names: required, trimmed to 16 chars, unique per room (case-insensitive)', async () => {
  const host = tab('n-host', 'Boss');
  assert.equal((await emit(host.socket, 'create_room', { playerId: host.id, name: '   ' })).error, 'Name is required');
  const { code } = await emit(host.socket, 'create_room', { playerId: host.id, name: 'Boss' });
  const g = tab('n-guest');
  assert.equal((await emit(g.socket, 'join_room', { code, playerId: g.id, name: '' })).error, 'NAME_REQUIRED');
  assert.equal((await emit(g.socket, 'join_room', { code, playerId: g.id, name: 'boss' })).error, 'That name is already taken in this room');
  assert.ok((await emit(g.socket, 'join_room', { code, playerId: g.id, name: 'A really really long name' })).ok);
  await until(() => host.list.length === 2);
  assert.equal(host.list[1].name.length, 16);
});

test(`full room: ${MAX_PLAYERS} players fit, the next one is turned away`, async () => {
  const tabs = Array.from({ length: MAX_PLAYERS }, (_, i) => tab(`f${i}`, `Full${i}`));
  const { code } = await emit(tabs[0].socket, 'create_room', { playerId: tabs[0].id, name: tabs[0].name });
  for (const c of tabs.slice(1)) assert.ok((await emit(c.socket, 'join_room', { code, playerId: c.id, name: c.name })).ok);
  await until(() => tabs.every((t) => t.list.length === MAX_PLAYERS));
  const extra = tab('f-extra', 'Extra');
  assert.equal((await emit(extra.socket, 'join_room', { code, playerId: extra.id, name: extra.name })).error, 'Room is full');
  assert.equal(tabs[0].list.length, MAX_PLAYERS);
});

test('start rules: only the host, and only with 5+ players', async () => {
  const tabs = Array.from({ length: 5 }, (_, i) => tab(`s${i}`, `S${i}`));
  const { code } = await emit(tabs[0].socket, 'create_room', { playerId: tabs[0].id, name: tabs[0].name });
  for (const c of tabs.slice(1, 4)) await emit(c.socket, 'join_room', { code, playerId: c.id, name: c.name });
  assert.equal((await emit(tabs[0].socket, 'start_game', {})).error, 'Need at least 5 players');
  await emit(tabs[4].socket, 'join_room', { code, playerId: tabs[4].id, name: tabs[4].name });
  assert.equal((await emit(tabs[1].socket, 'start_game', {})).error, 'Only the host can start');
  assert.ok((await emit(tabs[0].socket, 'start_game', {})).ok);
  const late = tab('s-late', 'Late');
  assert.equal((await emit(late.socket, 'join_room', { code, playerId: late.id, name: late.name })).error, 'Game already started');
  clearTimers(rooms[code]);
});

test('refresh keeps the seat (same playerId, new socket); no duplicate in the list', async () => {
  const host = tab('r-host', 'Host');
  const { code } = await emit(host.socket, 'create_room', { playerId: host.id, name: host.name });
  const g = tab('r-guest', 'Guest');
  await emit(g.socket, 'join_room', { code, playerId: g.id, name: g.name });
  g.socket.close(); // tab refresh
  await until(() => host.list.find((p) => p.id === g.id)?.connected === false);
  const again = tab('r-guest');
  assert.ok((await emit(again.socket, 'rejoin_room', { code, playerId: g.id })).ok);
  await until(() => host.list.find((p) => p.id === g.id)?.connected === true);
  assert.equal(host.list.length, 2);
  assert.equal(again.state.you.id, g.id);
});

test('leaving updates the list; if the host leaves the next player becomes host', async () => {
  const tabs = Array.from({ length: 3 }, (_, i) => tab(`l${i}`, `L${i}`));
  const { code } = await emit(tabs[0].socket, 'create_room', { playerId: tabs[0].id, name: tabs[0].name });
  for (const c of tabs.slice(1)) await emit(c.socket, 'join_room', { code, playerId: c.id, name: c.name });
  await emit(tabs[0].socket, 'leave_room', {});
  await until(() => tabs[1].list.length === 2 && tabs[2].list.length === 2);
  assert.equal(tabs[1].state.hostId, tabs[1].id);
  // The new host can start/manage the room; the old host can no longer act on it.
  assert.equal((await emit(tabs[0].socket, 'start_game', {})).error, 'Not in a room');
});

test('a host who closes the tab hands the room to the next connected player', async () => {
  const tabs = Array.from({ length: 2 }, (_, i) => tab(`d${i}`, `D${i}`));
  const { code } = await emit(tabs[0].socket, 'create_room', { playerId: tabs[0].id, name: tabs[0].name });
  await emit(tabs[1].socket, 'join_room', { code, playerId: tabs[1].id, name: tabs[1].name });
  tabs[0].socket.close();
  await until(() => tabs[1].state?.hostId === tabs[1].id);
});

test('going to another room (browser Back, then create/join) leaves the old one', async () => {
  const a = tab('g-a', 'Alice');
  const b = tab('g-b', 'Bob');
  const first = await emit(a.socket, 'create_room', { playerId: a.id, name: a.name });
  await emit(b.socket, 'join_room', { code: first.code, playerId: b.id, name: b.name });
  const second = await emit(a.socket, 'create_room', { playerId: a.id, name: a.name });
  // Alice is gone from the first room and Bob is its host now.
  await until(() => b.list.length === 1 && b.state.hostId === b.id);
  assert.deepEqual(rooms[first.code].players.map((p) => p.id), [b.id]);
  // Alice no longer receives the first room's updates.
  a.list = [];
  await emit(b.socket, 'leave_room', {});
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(a.list, []);
  assert.equal(a.state.code, second.code);
});
