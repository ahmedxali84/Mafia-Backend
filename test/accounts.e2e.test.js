process.env.TIMER_SCALE = '0.02';
process.env.NODE_ENV = 'test';
process.env.GAME_TOKEN_SECRET = 'test-secret-123';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const stats = require('../stats');
const { signToken } = require('../auth');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const token = (sub, name) => signToken({ sub, name, exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.GAME_TOKEN_SECRET);
let url;

test.before(() => new Promise((r) => server.listen(0, () => {
  url = `http://localhost:${server.address().port}`;
  r();
})));
test.after(() => {
  stats.useStore(null);
  io.close();
});

test('/stats/me: 503 without a database, 401 without a valid token, the saved stats with one', async () => {
  stats.useStore(null);
  assert.equal((await fetch(`${url}/stats/me`)).status, 503);
  const docs = { 'g-ali': { _id: 'g-ali', games: 4, wins: 3, losses: 1, byRole: { MAFIA: { games: 1, wins: 1 } }, recent: [] } };
  stats.useStore({ findOne: async ({ _id }) => docs[_id] || null });
  assert.equal((await fetch(`${url}/stats/me`)).status, 401);
  assert.equal((await fetch(`${url}/stats/me`, { headers: { authorization: 'Bearer not-a-token' } })).status, 401);
  const res = await fetch(`${url}/stats/me`, { headers: { authorization: `Bearer ${token('g-ali', 'Ali')}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'Ali', games: 4, wins: 3, losses: 1, byRole: { MAFIA: { games: 1, wins: 1 } }, recent: [] });
  assert.equal((await (await fetch(`${url}/health`)).json()).accounts, true);
});

test('a full game saves the signed-in player and skips the guest', async () => {
  const saved = [];
  stats.useStore({ updateOne: async (filter, update) => saved.push({ id: filter._id, update }), findOne: async () => null });

  const players = [
    { id: 'signed-in', name: 'Ali', authToken: token('g-ali', 'Ali Khan') },
    { id: 'guest', name: 'Sara', authToken: undefined },
  ].map((p) => ({ ...p, socket: connect(url, { forceNew: true }), over: null, role: null }));
  for (const p of players) {
    p.socket.on('game_over', (g) => (p.over = g));
    // Autopilot: act at night, vote by day.
    p.socket.on('state', (st) => {
      p.role = st.you.role;
      const others = st.players.filter((x) => x.alive && x.id !== p.id);
      if (st.you.alive && st.phase === 'NIGHT' && !st.you.nightTarget && ['MAFIA', 'DOCTOR', 'DETECTIVE', 'THIEF'].includes(st.you.role)) {
        const t = st.you.role === 'MAFIA' ? others.filter((x) => x.role !== 'MAFIA') : others;
        if (t[0]) p.socket.emit('night_action', { targetId: t[0].id }, () => {});
      }
      if (st.you.alive && st.phase === 'VOTING' && !st.you.vote && others[0]) p.socket.emit('cast_vote', { targetId: others[0].id }, () => {});
    });
  }
  const [host, guest] = players;
  const created = await emit(host.socket, 'create_room', { playerId: host.id, name: host.name, bots: 4, authToken: host.authToken });
  assert.ok(created.ok, created.error);
  assert.ok((await emit(guest.socket, 'join_room', { code: created.code, playerId: guest.id, name: guest.name })).ok);
  // A forged token is just ignored (that player plays as a guest).
  assert.ok((await emit(guest.socket, 'rejoin_room', { code: created.code, playerId: guest.id, authToken: 'x.y.z' })).ok);
  assert.ok((await emit(host.socket, 'start_game', {})).ok);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('game did not finish')), 30000);
    const iv = setInterval(() => {
      if (players.every((p) => p.over) && saved.length) {
        clearTimeout(t);
        clearInterval(iv);
        resolve();
      }
    }, 20);
  });
  players.forEach((p) => p.socket.close());

  assert.equal(saved.length, 1, 'only the signed-in player is saved');
  const { id, update } = saved[0];
  assert.equal(id, 'g-ali');
  assert.equal(update.$set.name, 'Ali Khan');
  const winner = host.over.winner;
  const role = host.over.roles[host.id];
  const won = winner === (role === 'MAFIA' ? 'MAFIA' : role === 'JESTER' ? 'JESTER' : 'VILLAGERS');
  assert.equal(update.$inc.wins, won ? 1 : 0);
  assert.equal(update.$inc.losses, won ? 0 : 1);
  assert.equal(update.$inc[`byRole.${role}.games`], 1);
});

test('rejoining without a token keeps the account; signing out (null) clears it', async () => {
  const rm = require('../rooms');
  const s1 = connect(url, { forceNew: true });
  const { code } = await emit(s1, 'create_room', { playerId: 'keeper', name: 'Keeper', authToken: token('g-keep', 'Keep') });
  const seat = () => rm.rooms[code].players.find((p) => p.id === 'keeper');
  assert.equal(seat().account.id, 'g-keep');
  s1.close();
  const s2 = connect(url, { forceNew: true });
  assert.ok((await emit(s2, 'rejoin_room', { code, playerId: 'keeper' })).ok);
  assert.equal(seat().account?.id, 'g-keep', 'no token field: the account stays');
  assert.ok((await emit(s2, 'rejoin_room', { code, playerId: 'keeper', authToken: null })).ok);
  assert.equal(seat().account, null, 'signed out: now a guest');
  s2.close();
});

test('Play again: each game is saved separately', async () => {
  const saved = [];
  stats.useStore({ updateOne: async (filter, update) => saved.push(update.$push.recent.$each[0].gameId), findOne: async () => null });
  const s = connect(url, { forceNew: true });
  let over = 0;
  s.on('game_over', () => over++);
  const { code } = await emit(s, 'create_room', { playerId: 'again', name: 'Again', bots: 4, authToken: token('g-again', 'Again') });
  const rm = require('../rooms');
  const waitOver = async (n) => { const end = Date.now() + 60000; while (over < n && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); };
  assert.ok((await emit(s, 'start_game', {})).ok);
  rm.rooms[code].players.find((p) => p.id === 'again').connected = false; // autopilot plays for them
  await waitOver(1);
  rm.rooms[code].players.find((p) => p.id === 'again').connected = true;
  assert.ok((await emit(s, 'play_again', {})).ok);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await emit(s, 'start_game', {})).ok);
  rm.rooms[code].players.find((p) => p.id === 'again').connected = false;
  await waitOver(2);
  await new Promise((r) => setTimeout(r, 50));
  s.close();
  assert.equal(saved.length, 2, 'two games, two saves');
  assert.notEqual(saved[0], saved[1], 'different game ids');
});
