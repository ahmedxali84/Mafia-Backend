process.env.TIMER_SCALE = '0.05';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const { rooms } = require('../rooms');
const { clearTimers } = require('../game/phases');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const until = (fn, ms = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(iv); reject(new Error('timeout')); }, ms);
    const iv = setInterval(() => { if (fn()) { clearTimeout(t); clearInterval(iv); resolve(); } }, 20);
  });

test('a whisper reaches only sender + receiver; others get nothing at all', async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const cs = Array.from({ length: 5 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, state: null, msgs: [], socket: connect(url, { forceNew: true }) }));
  for (const c of cs) {
    c.socket.on('state', (st) => (c.state = st));
    c.socket.on('chat_message', (m) => c.msgs.push(m));
  }
  const { code } = await emit(cs[0].socket, 'create_room', { playerId: cs[0].id, name: cs[0].name });
  for (const c of cs.slice(1)) await emit(c.socket, 'join_room', { code, playerId: c.id, name: c.name });

  // Not allowed in the lobby
  assert.ok((await emit(cs[0].socket, 'whisper', { targetId: 'w1', text: 'x' })).error);

  await emit(cs[0].socket, 'start_game', {});
  // keep the game from ending while we wait: just wait for the first discussion phase
  cs.forEach((c) =>
    c.socket.on('state', (st) => {
      const alive = st.players.filter((p) => p.alive && p.id !== c.id);
      if (st.you.alive && st.phase === 'NIGHT' && !st.you.nightTarget && ['MAFIA', 'DOCTOR', 'DETECTIVE'].includes(st.you.role)) {
        const t = st.you.role === 'MAFIA' ? alive.filter((p) => p.role !== 'MAFIA') : alive;
        c.socket.emit('night_action', { targetId: t[0].id }, () => {});
      }
    })
  );
  await until(() => cs.every((c) => c.state?.phase === 'DISCUSSION'));

  const aliveIds = cs[0].state.players.filter((p) => p.alive).map((p) => p.id);
  assert.ok(aliveIds.length >= 3);
  const [a, b, ...others] = aliveIds;
  const A = cs.find((c) => c.id === a);
  const B = cs.find((c) => c.id === b);
  const SECRET = 'meet me behind the bar';

  const res = await emit(A.socket, 'whisper', { targetId: b, text: SECRET });
  assert.ok(res.ok, res.error);
  assert.equal(res.whispersLeft, 1);
  await until(() => B.msgs.some((m) => m.channel === 'whisper'));
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(B.msgs.find((m) => m.channel === 'whisper').text, SECRET);
  assert.ok(A.msgs.some((m) => m.channel === 'whisper'));
  for (const c of cs) {
    if (c !== A && c !== B) assert.ok(!c.msgs.some((m) => m.channel === 'whisper' || m.channel === 'notice'), `${c.name} must not learn of the whisper`);
  }
  // reconnect snapshots must not leak either
  for (const id of others) {
    const c = cs.find((x) => x.id === id);
    assert.ok(!c.state.chat.some((m) => JSON.stringify(m).includes(SECRET)));
  }

  cs.forEach((c) => c.socket.close());
  Object.values(rooms).forEach(clearTimers); // stop the running game so the process can exit
  io.close();
});
