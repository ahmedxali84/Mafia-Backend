process.env.TIMER_SCALE = '0.05';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const { rooms } = require('../rooms');
const { clearTimers } = require('../game/phases');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const until = (fn, ms = 60000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(iv); reject(new Error('timeout')); }, ms);
    const iv = setInterval(() => { if (fn()) { clearTimeout(t); clearInterval(iv); resolve(); } }, 20);
  });

let url;
const clients = [];
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
test.after(() => {
  clients.forEach((c) => c.socket.close());
  Object.values(rooms).forEach(clearTimers); // stop running games so the process can exit
  io.close();
});

function mk(id) {
  const c = { id, state: null, signals: [], socket: connect(url, { forceNew: true }) };
  c.socket.on('state', (st) => (c.state = st));
  c.socket.on('voice_signal', (m) => c.signals.push(m));
  clients.push(c);
  return c;
}
const voiceOf = (c, id) => c.state?.players.find((p) => p.id === id)?.voice;

test('signaling is relayed only between players in voice in the same room', async () => {
  const [a, b, c, x] = ['va', 'vb', 'vc', 'vx'].map(mk);
  const { code } = await emit(a.socket, 'create_room', { playerId: a.id, name: 'A' });
  await emit(b.socket, 'join_room', { code, playerId: b.id, name: 'B' });
  await emit(c.socket, 'join_room', { code, playerId: c.id, name: 'C' });
  await emit(x.socket, 'create_room', { playerId: x.id, name: 'X' }); // another room

  const ja = await emit(a.socket, 'voice_join');
  const jb = await emit(b.socket, 'voice_join');
  const jx = await emit(x.socket, 'voice_join');
  assert.ok(ja.session && jb.session && ja.session !== jb.session);
  assert.ok(Array.isArray(ja.iceServers) && ja.iceServers.length > 0);
  assert.equal(typeof ja.at, 'number');
  await until(() => voiceOf(c, 'vx') === undefined && voiceOf(c, 'vb')?.session === jb.session);
  assert.deepEqual(voiceOf(c, 'va'), { session: ja.session, muted: false });
  assert.deepEqual(a.state.you.voice.sendTo, ['vb']); // C is not in voice

  const offer = { sdp: { type: 'offer', sdp: 'v=0' }, pcId: 'p1' };
  a.socket.emit('voice_signal', { to: 'vb', toSession: jb.session, data: offer });
  a.socket.emit('voice_signal', { to: 'vb', toSession: 'stale', data: offer }); // wrong session
  a.socket.emit('voice_signal', { to: 'vc', toSession: undefined, data: offer }); // not in voice
  a.socket.emit('voice_signal', { to: 'vx', toSession: jx.session, data: offer }); // other room
  c.socket.emit('voice_signal', { to: 'va', toSession: ja.session, data: offer }); // sender not in voice
  a.socket.emit('voice_signal', { to: 'vb', toSession: jb.session, data: { blob: 'x'.repeat(20000) } }); // too big
  // Sentinel: once this arrives, everything sent before it has been handled.
  const done = { candidate: { done: true }, pcId: 'p1' };
  a.socket.emit('voice_signal', { to: 'vb', toSession: jb.session, data: done });
  await until(() => b.signals.some((m) => m.data.candidate?.done));
  await emit(c.socket, 'voice_leave'); // round trip so C's and X's sockets are drained too
  await emit(x.socket, 'voice_leave');
  assert.equal(b.signals.length, 2);
  const { at, ...relayed } = b.signals[0];
  assert.deepEqual(relayed, { from: 'va', fromSession: ja.session, data: offer });
  assert.equal(typeof at, 'number');
  assert.equal(c.signals.length + x.signals.length + a.signals.length, 0);

  // mute flag is shared, leaving clears it
  await emit(b.socket, 'voice_mute', { muted: true });
  await until(() => voiceOf(a, 'vb')?.muted === true);
  await emit(b.socket, 'voice_leave');
  await until(() => voiceOf(a, 'vb') === null);
});

test('a refresh drops voice, and the old tab cannot touch the new one', async () => {
  const [a, b] = ['ra', 'rb'].map(mk);
  const { code } = await emit(a.socket, 'create_room', { playerId: a.id, name: 'A' });
  await emit(b.socket, 'join_room', { code, playerId: b.id, name: 'B' });
  await emit(a.socket, 'voice_join');
  await emit(b.socket, 'voice_join');

  const a2 = mk('ra'); // same player, new tab / refresh
  await emit(a2.socket, 'rejoin_room', { code, playerId: 'ra' });
  await until(() => voiceOf(b, 'ra') === null); // new connection starts without voice

  const j2 = await emit(a2.socket, 'voice_join');
  assert.ok(j2.session);
  assert.ok((await emit(a.socket, 'voice_join')).error, 'old tab cannot join voice');
  await emit(a.socket, 'voice_leave');
  await emit(a.socket, 'voice_mute', { muted: true });
  a.socket.emit('voice_signal', { to: 'rb', toSession: voiceOf(a2, 'rb').session, data: { candidate: {} } });
  await emit(a.socket, 'voice_leave'); // round trip: the signal above has been handled
  await until(() => voiceOf(b, 'ra') !== null);
  assert.deepEqual(voiceOf(b, 'ra'), { session: j2.session, muted: false }, 'old tab changed nothing');
  assert.equal(b.signals.length, 0);

  // disconnect and leaving the room clear voice
  a2.socket.close();
  await until(() => voiceOf(b, 'ra') === null);
  await emit(b.socket, 'leave_room');
});

test('malformed voice payloads do not crash the server', async () => {
  const a = mk('ma');
  await emit(a.socket, 'create_room', { playerId: a.id, name: 'A' });
  a.socket.emit('voice_signal', null);
  a.socket.emit('voice_signal', 'junk');
  a.socket.emit('voice_mute', null);
  a.socket.emit('voice_join', null, 'not-a-function');
  a.socket.emit('voice_leave', 42);
  a.socket.emit('voice_signal', { to: 'nobody', toSession: 'x', data: null });
  assert.ok((await emit(a.socket, 'voice_join')).ok, 'server still answers');
});

test('signaling is rate limited but a full table fits', async () => {
  const [a, b] = ['la', 'lb'].map(mk);
  const { code } = await emit(a.socket, 'create_room', { playerId: a.id, name: 'A' });
  await emit(b.socket, 'join_room', { code, playerId: b.id, name: 'B' });
  await emit(a.socket, 'voice_join');
  const jb = await emit(b.socket, 'voice_join');
  await until(() => voiceOf(a, 'lb')?.session === jb.session);
  for (let i = 0; i < 700; i++) a.socket.emit('voice_signal', { to: 'lb', toSession: jb.session, data: { candidate: { i } } });
  await emit(a.socket, 'voice_mute', { muted: false }); // round trip: the whole burst has been handled
  await until(() => b.signals.length > 0);
  await emit(b.socket, 'voice_mute', { muted: false }); // and delivered to B
  // 300/s: a full table's join burst (~11 offers + candidates) fits, a flood does not.
  assert.ok(b.signals.length >= 250 && b.signals.length < 700, `relayed ${b.signals.length}`);
});

test('routes follow the game: Mafia-only at night, everyone by day', async () => {
  const cs = ['g0', 'g1', 'g2', 'g3', 'g4'].map(mk);
  const { code } = await emit(cs[0].socket, 'create_room', { playerId: 'g0', name: 'G0' });
  for (const c of cs.slice(1)) await emit(c.socket, 'join_room', { code, playerId: c.id, name: c.id.toUpperCase() });
  for (const c of cs) await emit(c.socket, 'voice_join');
  cs.forEach((c) =>
    c.socket.on('state', (st) => {
      const alive = st.players.filter((p) => p.alive && p.id !== c.id);
      if (st.you.alive && st.phase === 'NIGHT' && !st.you.nightTarget && ['MAFIA', 'DOCTOR', 'DETECTIVE'].includes(st.you.role)) {
        const t = st.you.role === 'MAFIA' ? alive.filter((p) => p.role !== 'MAFIA') : alive;
        c.socket.emit('night_action', { targetId: t[0].id }, () => {});
      }
    })
  );
  await emit(cs[0].socket, 'start_game', {});
  await until(() => cs.every((c) => c.state?.phase === 'NIGHT'));
  // A fast night can end before every client is seen in it, so this may be a later night with ghosts.
  for (const c of cs) {
    const v = c.state.you.voice;
    if (!c.state.you.alive) assert.equal(v.channel, 'dead');
    else if (c.state.you.role === 'MAFIA') assert.equal(v.channel, 'mafia');
    else {
      assert.equal(v.channel, null, `${c.id} (${c.state.you.role}) is silent at night`);
      assert.deepEqual(v.sendTo, []);
      assert.ok(!v.hearFrom.some((id) => c.state.players.find((p) => p.id === id).role === 'MAFIA' && c.state.players.find((p) => p.id === id).alive), 'town never hears living Mafia at night');
    }
  }
  await until(() => cs.every((c) => c.state?.phase === 'DISCUSSION'));
  for (const c of cs) {
    const others = c.state.players.filter((p) => p.id !== c.id);
    const v = c.state.you.voice;
    if (c.state.you.alive) assert.deepEqual([...v.sendTo].sort(), others.map((p) => p.id).sort(), `${c.id} is heard by all`);
    else assert.equal(v.channel, 'dead');
  }
});
