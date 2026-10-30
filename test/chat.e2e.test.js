// Week 5 QA: the three chats over real sockets. Seven players (2 Mafia) go through
// lobby → role reveal → night → day; each phase is frozen (timers cleared) while
// we check exactly who receives each message.
process.env.TIMER_SCALE = '0.05';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const { rooms } = require('../rooms');
const { clearTimers } = require('../game/phases');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (fn, ms = 10000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(iv); reject(new Error('timeout')); }, ms);
    const iv = setInterval(() => { if (fn()) { clearTimeout(t); clearInterval(iv); resolve(); } }, 10);
  });

let url;
const sockets = [];
test.before(() => new Promise((r) => server.listen(0, () => { url = `http://localhost:${server.address().port}`; r(); })));
test.after(() => {
  sockets.forEach((s) => s.close());
  Object.values(rooms).forEach(clearTimers);
  io.close();
});

function client(id) {
  const socket = connect(url, { forceNew: true });
  sockets.push(socket);
  const c = { id, name: id, socket, msgs: [], state: null };
  socket.on('chat_message', (m) => c.msgs.push(m));
  socket.on('state', (st) => (c.state = st));
  return c;
}

test('town chat by day, Mafia-only chat at night, ghosts in their own chat', async () => {
  const cs = Array.from({ length: 7 }, (_, i) => client(`c${i}`));
  const { code } = await emit(cs[0].socket, 'create_room', { playerId: cs[0].id, name: cs[0].name });
  for (const c of cs.slice(1)) await emit(c.socket, 'join_room', { code, playerId: c.id, name: c.name });
  const room = rooms[code];
  const roleOf = (c) => room.players.find((p) => p.id === c.id).role;
  // Sends a message and returns the ids of everyone it reached.
  let n = 0;
  async function say(c, text = `msg ${++n}`) {
    await sleep(650); // stay under the 600 ms per-player rate limit
    const res = await emit(c.socket, 'chat_message', { text });
    await sleep(120);
    return { res, got: cs.filter((x) => x.msgs.some((m) => m.text === text)).map((x) => x.id).sort() };
  }
  const ids = (list) => list.map((c) => c.id).sort();

  // Lobby: everyone, town channel.
  let r = await say(cs[1], 'hi from the lobby');
  assert.ok(r.res.ok);
  assert.deepEqual(r.got, ids(cs));
  assert.equal(cs[0].msgs.find((m) => m.text === 'hi from the lobby').channel, 'public');

  // Role reveal: chat closed.
  assert.ok((await emit(cs[0].socket, 'start_game', {})).ok);
  assert.equal(room.phase, 'ROLE_REVEAL');
  assert.equal((await emit(cs[2].socket, 'chat_message', { text: 'too early' })).error, 'You cannot chat right now');

  // Night (frozen): Mafia talk privately, nobody else may write.
  await until(() => room.phase === 'NIGHT');
  clearTimers(room);
  const mafia = cs.filter((c) => roleOf(c) === 'MAFIA');
  const town = cs.filter((c) => roleOf(c) !== 'MAFIA');
  assert.equal(mafia.length, 2);
  r = await say(mafia[0], 'take the baker tonight');
  assert.ok(r.res.ok);
  assert.deepEqual(r.got, ids(mafia), 'Mafia chat reaches both Mafia and nobody else');
  assert.equal(mafia[1].msgs.find((m) => m.text === 'take the baker tonight').channel, 'mafia');
  for (const c of town) {
    assert.equal((await emit(c.socket, 'chat_message', { text: 'anyone awake?' })).error, 'You cannot chat right now', `${roleOf(c)} is silent at night`);
  }

  // Resolve the night: the Mafia kill a plain villager, the Doctor saves themselves.
  const victim = town.find((c) => roleOf(c) === 'VILLAGER');
  const doctor = town.find((c) => roleOf(c) === 'DOCTOR');
  const detective = town.find((c) => roleOf(c) === 'DETECTIVE');
  await emit(doctor.socket, 'night_action', { targetId: doctor.id });
  await emit(detective.socket, 'night_action', { targetId: mafia[0].id });
  for (const m of mafia) await emit(m.socket, 'night_action', { targetId: victim.id });
  await until(() => room.phase === 'DISCUSSION');
  clearTimers(room);
  assert.equal(room.players.find((p) => p.id === victim.id).alive, false);
  const alive = cs.filter((c) => c !== victim);

  // Day: the living write to town chat (everyone reads it, ghosts too) ...
  r = await say(doctor, 'who did this?');
  assert.ok(r.res.ok);
  assert.deepEqual(r.got, ids(cs));
  // ... the dead write to ghost chat, which no living player receives.
  r = await say(victim, 'it was them, I saw it');
  assert.ok(r.res.ok);
  assert.deepEqual(r.got, [victim.id], 'only the dead read ghost chat');
  assert.equal(victim.msgs.find((m) => m.text === 'it was them, I saw it').channel, 'dead');

  // A refresh restores the chat history, filtered by the same rules.
  async function refresh(c) {
    const tab = client(c.id);
    assert.ok((await emit(tab.socket, 'rejoin_room', { code, playerId: c.id })).ok);
    await until(() => tab.state);
    return new Set(tab.state.chat.map((m) => m.channel));
  }
  for (const c of alive) {
    const chans = await refresh(c);
    assert.ok(chans.has('public'), `${c.id} keeps town chat`);
    assert.ok(!chans.has('dead'), `${c.id} must not get ghost chat on refresh`);
    assert.equal(chans.has('mafia'), roleOf(c) === 'MAFIA', `${c.id} (${roleOf(c)}) Mafia history`);
  }
  const ghostChans = await refresh(victim);
  assert.ok(ghostChans.has('dead') && ghostChans.has('public'));
  assert.ok(!ghostChans.has('mafia'), 'a dead villager never sees Mafia chat');
});

test('chat input rules: empty, too long, rate limit, not in a room', async () => {
  const [a, b] = [client('in-a'), client('in-b')];
  assert.equal((await emit(b.socket, 'chat_message', { text: 'hello' })).error, 'Not in a room');
  const { code } = await emit(a.socket, 'create_room', { playerId: a.id, name: 'A' });
  await emit(b.socket, 'join_room', { code, playerId: b.id, name: 'B' });

  assert.equal((await emit(a.socket, 'chat_message', { text: '   ' })).error, 'Empty message');
  await sleep(650);
  assert.ok((await emit(a.socket, 'chat_message', { text: 'x'.repeat(500) })).ok);
  await until(() => b.msgs.length === 1);
  assert.equal(b.msgs[0].text.length, 300, 'long messages are cut to 300 characters');
  assert.equal((await emit(a.socket, 'chat_message', { text: 'spam' })).error, 'Slow down a little');
  // HTML is delivered as plain text (React escapes it when it renders).
  await sleep(650);
  await emit(a.socket, 'chat_message', { text: '<img src=x onerror=alert(1)>' });
  await until(() => b.msgs.length === 2);
  assert.equal(b.msgs[1].text, '<img src=x onerror=alert(1)>');
});
