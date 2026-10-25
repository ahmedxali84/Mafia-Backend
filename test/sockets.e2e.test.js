// Socket-level checks for the rooms/game-start/actions work (weeks 2-4):
// bad payloads, host hand-over, playerId reconnects, start_game rules,
// private your_role, and night_action / cast_vote validation.
process.env.TIMER_SCALE = '0.05';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const { rooms } = require('../rooms');
const { clearTimers } = require('../game/phases');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const waitFor = (s, ev, pred = () => true) =>
  new Promise((res) => {
    const h = (d) => {
      if (pred(d)) {
        s.off(ev, h);
        res(d);
      }
    };
    s.on(ev, h);
  });

let url;
const sockets = [];
const client = () => {
  const s = connect(url, { forceNew: true });
  sockets.push(s);
  return s;
};

// Creates a room with n human players. Returns { code, players: [{ socket, id, name }] }.
async function makeRoom(n, tag) {
  const players = Array.from({ length: n }, (_, i) => ({ socket: client(), id: `${tag}-${i}`, name: `${tag}${i}` }));
  const { code } = await emit(players[0].socket, 'create_room', { playerId: players[0].id, name: players[0].name });
  for (const p of players.slice(1)) {
    const r = await emit(p.socket, 'join_room', { code, playerId: p.id, name: p.name });
    assert.ok(r.ok, r.error);
  }
  return { code, players };
}

test.before(() => new Promise((r) => server.listen(0, () => {
  url = `http://localhost:${server.address().port}`;
  r();
})));

// Games started here never finish on their own (nobody acts), so stop their timers.
test.after(() => {
  Object.values(rooms).forEach(clearTimers);
  sockets.forEach((s) => s.close());
  io.close();
});

test('garbage payloads get an error instead of crashing the server', async () => {
  const s = client();
  for (const ev of ['night_action', 'cast_vote', 'create_room', 'join_room', 'chat_message', 'whisper']) {
    for (const bad of [null, 'text', 42]) {
      const res = await emit(s, ev, bad);
      assert.ok(res.error, `${ev}(${JSON.stringify(bad)}) should be rejected`);
    }
  }
  s.emit('night_action', null); // no ack at all
  const health = await fetch(`${url}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
});

test('host leaving the lobby hands the room to the next player', async () => {
  const { players } = await makeRoom(3, 'H');
  const update = waitFor(players[1].socket, 'state', (st) => st.hostId !== players[0].id);
  await emit(players[0].socket, 'leave_room', {});
  const st = await update;
  assert.equal(st.hostId, players[1].id);
  assert.equal(st.players.length, 2);
});

test('same playerId on a new socket gets the same seat back', async () => {
  const { code, players } = await makeRoom(2, 'R');
  players[1].socket.close();
  const fresh = client();
  const state = waitFor(fresh, 'state'); // the server sends state before the ack
  const r = await emit(fresh, 'rejoin_room', { code, playerId: players[1].id });
  assert.ok(r.ok, r.error);
  const st = await state;
  assert.equal(st.you.id, players[1].id);
  assert.equal(st.players.length, 2, 'no duplicate seat');
});

test('start_game: host only, minimum 5 players', async () => {
  const small = await makeRoom(4, 'S');
  assert.match((await emit(small.players[0].socket, 'start_game', {})).error, /at least 5/);

  const { players } = await makeRoom(5, 'T');
  assert.equal((await emit(players[1].socket, 'start_game', {})).error, 'Only the host can start');
  assert.ok((await emit(players[0].socket, 'start_game', {})).ok);
});

test('your_role goes privately to each player; night_action and cast_vote are validated', async () => {
  const { players } = await makeRoom(5, 'G');
  const roleMsgs = players.map((p) => {
    const got = [];
    p.socket.on('your_role', (r) => got.push(r));
    return got;
  });
  const leakedRoles = [];
  players[0].socket.on('room_update', (list) => list.forEach((p) => p.role && leakedRoles.push(p)));
  const night = waitFor(players[0].socket, 'phase_change', (p) => p.phase === 'NIGHT');

  assert.ok((await emit(players[0].socket, 'start_game', {})).ok);
  await night;

  // Each player got exactly one your_role, and the roles add up to a real game.
  roleMsgs.forEach((got) => assert.equal(got.length, 1));
  const roles = roleMsgs.map((got) => got[0].role);
  assert.equal(roles.filter((r) => r === 'MAFIA').length, 1);
  assert.ok(roles.includes('DOCTOR') && roles.includes('DETECTIVE'));
  assert.deepEqual(leakedRoles, [], 'room_update must never carry roles');

  const byRole = (role) => players[roles.indexOf(role)];
  const mafia = byRole('MAFIA');
  const villager = byRole('VILLAGER');
  const detective = byRole('DETECTIVE');

  assert.equal((await emit(villager.socket, 'night_action', { targetId: mafia.id })).error, 'Your role has no night action');
  assert.equal((await emit(mafia.socket, 'night_action', { targetId: mafia.id })).error, 'Cannot target your team');
  assert.equal((await emit(detective.socket, 'night_action', { targetId: detective.id })).error, 'Cannot investigate yourself');
  assert.equal((await emit(mafia.socket, 'night_action', { targetId: 'nobody' })).error, 'Invalid target');
  assert.equal((await emit(villager.socket, 'cast_vote', { targetId: mafia.id })).error, 'Not voting time');
});
