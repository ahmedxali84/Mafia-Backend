// Week 5: reconnecting mid-game. A player who drops (refresh, lost network, closed tab) and comes
// back with the same playerId must get their exact game back: role, actions, vote, chat, host.
process.env.TIMER_SCALE = '0.2';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const rm = require('../rooms');

let url;
test.before(() => new Promise((r) => server.listen(0, () => {
  url = `http://localhost:${server.address().port}`;
  r();
})));
test.after(() => io.close());

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

// A browser tab for one player: a socket plus the last state it received.
function tab(id) {
  const t = { id, socket: connect(url, { forceNew: true }), state: null, roles: [] };
  t.socket.on('state', (st) => (t.state = st));
  t.socket.on('your_role', (r) => t.roles.push(r.role));
  return t;
}
async function waitFor(cond, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
// Drops a tab the way a refresh or lost connection does, then opens a new one for the same player.
async function reconnect(t, code) {
  t.socket.close();
  await new Promise((r) => setTimeout(r, 150));
  const n = tab(t.id);
  const res = await emit(n.socket, 'rejoin_room', { code, playerId: t.id });
  assert.ok(res.ok, res.error);
  await waitFor(() => n.state, 3000, 'state after rejoin');
  return n;
}

// Two humans + 5 bots. `rig` swaps roles right after the deal (before the first night).
async function table(rig = {}) {
  const a = tab(`a-${Math.random()}`);
  const b = tab(`b-${Math.random()}`);
  const { code } = await emit(a.socket, 'create_room', { playerId: a.id, name: 'Ana', bots: 5, roles: ['JESTER', 'THIEF'] });
  await emit(b.socket, 'join_room', { code, playerId: b.id, name: 'Bilal', roles: ['JESTER', 'THIEF'] });
  assert.ok((await emit(a.socket, 'start_game', {})).ok);
  const room = rm.rooms[code];
  const rigged = new Set();
  for (const [who, role] of Object.entries(rig)) {
    const p = room.players.find((x) => x.id === (who === 'a' ? a.id : b.id));
    rigged.add(p.id);
    if (p.role === role) continue;
    const holder = room.players.find((x) => x.role === role && !rigged.has(x.id));
    if (holder) [p.role, holder.role] = [holder.role, p.role];
  }
  return { a, b, code, room };
}
const close = (...tabs) => tabs.forEach((t) => t.socket.close());

test('night: a refreshed Doctor keeps their role and their pick, and can still change it', async () => {
  const { a, b, code, room } = await table({ a: 'DOCTOR' });
  await waitFor(() => room.phase === 'NIGHT', 15000, 'night');
  assert.ok((await emit(a.socket, 'night_action', { targetId: b.id })).ok);

  const a2 = await reconnect(a, code);
  assert.equal(a2.state.phase, 'NIGHT');
  assert.equal(a2.state.you.role, 'DOCTOR');
  assert.equal(a2.state.you.nightTarget, b.id, 'the pick survived the refresh');
  assert.equal(a2.state.you.chatChannel, null, 'the town is silent at night');
  assert.ok((await emit(a2.socket, 'night_action', { targetId: a.id })).ok, 'and can still change it');
  assert.equal(room.night.actions[a.id], a.id);
  await waitFor(() => b.state.players.find((p) => p.id === a.id).connected, 3000, 'others see them back');
  close(a2, b);
});

test('voting: a dropped player can come back and vote; their vote counts', async () => {
  const { a, b, code, room } = await table();
  await waitFor(() => room.phase === 'DISCUSSION' || room.phase === 'GAME_OVER', 20000, 'discussion');
  if (room.phase === 'GAME_OVER') return close(a, b);
  const aliveHuman = [a, b].find((t) => room.players.find((p) => p.id === t.id).alive);
  if (!aliveHuman) return close(a, b);
  await emit(aliveHuman.socket, 'ready_vote', { ready: true });
  await waitFor(() => room.phase === 'VOTING', 30000, 'voting');

  const back = await reconnect(aliveHuman, code);
  assert.equal(back.state.phase, 'VOTING');
  const target = back.state.players.find((p) => p.alive && p.id !== back.id);
  assert.ok((await emit(back.socket, 'cast_vote', { targetId: target.id })).ok);
  assert.equal(room.votes[back.id], target.id);
  close(a, b, back);
});

test('a player killed while away comes back dead, spectating with ghost chat', async () => {
  const { a, b, code, room } = await table({ a: 'VILLAGER', b: 'DOCTOR' });
  await waitFor(() => room.phase === 'NIGHT', 15000, 'night');
  a.socket.close(); // a drops; the Mafia kill them tonight
  for (const m of room.players.filter((p) => p.role === 'MAFIA')) room.night.actions[m.id] = a.id;
  room.night.actions[b.id] = b.id; // the Doctor saves themselves, not a
  await waitFor(() => room.phase !== 'NIGHT', 15000, 'dawn');
  assert.equal(room.players.find((p) => p.id === a.id).alive, false);

  const a2 = await reconnect(a, code);
  assert.equal(a2.state.you.alive, false);
  assert.equal(a2.state.you.role, 'VILLAGER');
  assert.ok(['dead', null].includes(a2.state.you.chatChannel), 'only ghost chat (or none during reveals)');
  assert.ok(a2.state.result?.killedId === a.id || a2.state.history.some((e) => e.name === 'Ana'), 'they can see what happened to them');
  close(a2, b);
});

test('robbed by the Thief while away: the new role is waiting on return', async () => {
  const { a, b, code, room } = await table({ a: 'DETECTIVE', b: 'THIEF' });
  await waitFor(() => room.phase === 'NIGHT', 15000, 'night');
  a.socket.close();
  assert.ok((await emit(b.socket, 'night_action', { targetId: a.id })).ok);
  await waitFor(() => room.phase !== 'NIGHT', 15000, 'dawn');

  const a2 = await reconnect(a, code);
  if (!room.players.find((p) => p.id === a.id).alive) return close(a2, b); // killed the same night: robbing a corpse gets nothing
  assert.equal(a2.state.you.role, 'VILLAGER');
  assert.equal(a2.state.you.robbed?.role, 'DETECTIVE');
  assert.equal(b.state.you.role, 'DETECTIVE');
  assert.equal(b.state.you.stole?.targetId, a.id);
  close(a2, b);
});

test('host drops mid-game: the other human becomes host and can start the next game', async () => {
  const { a, b, code, room } = await table();
  await waitFor(() => room.phase === 'NIGHT', 15000, 'night');
  a.socket.close();
  await waitFor(() => room.host === b.id, 3000, 'host hand-over');
  await waitFor(() => room.phase === 'GAME_OVER', 60000, 'game over');
  await waitFor(() => b.state?.phase === 'GAME_OVER', 3000, 'b sees game over');

  const a2 = await reconnect(a, code);
  assert.equal(a2.state.phase, 'GAME_OVER');
  assert.ok(a2.state.winner, 'the returning player sees who won');
  assert.ok(a2.state.players.every((p) => p.role), 'all roles are shown after the game');
  assert.equal(a2.state.hostId, b.id, 'the new host keeps the table');
  assert.match((await emit(a2.socket, 'play_again', {})).error, /host/i);
  assert.ok((await emit(b.socket, 'play_again', {})).ok);
  await waitFor(() => a2.state.phase === 'LOBBY', 3000, 'back to the lobby');
  close(a2, b);
});

test('the Mafia chat history is there after a refresh', async () => {
  const { a, b, code, room } = await table({ a: 'MAFIA', b: 'MAFIA' });
  await waitFor(() => room.phase === 'NIGHT', 15000, 'night');
  assert.ok((await emit(a.socket, 'chat_message', { text: 'take the doctor', channel: 'mafia' })).ok);
  const b2 = await reconnect(b, code);
  assert.ok(b2.state.chat.some((m) => m.channel === 'mafia' && m.text === 'take the doctor'));
  assert.ok(b2.state.you.mafiaChat?.canWrite);
  assert.equal(b2.state.players.find((p) => p.id === a.id).role, 'MAFIA', 'still sees their teammate');
  close(a, b2);
});
