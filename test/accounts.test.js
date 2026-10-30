const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyToken, signToken } = require('../auth');
const stats = require('../stats');

const SECRET = 'test-secret-123';
const exp = (s) => Math.floor(Date.now() / 1000) + s;
const tok = (claims, secret = SECRET) => signToken({ sub: 'g-1', name: 'Ali Khan', picture: 'https://x.test/a.png', exp: exp(3600), ...claims }, secret);

// Minimal in-memory stand-in for the MongoDB collection (only what stats.js uses).
function fakeUsers() {
  const docs = new Map();
  const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
  const set = (o, path, val) => {
    const keys = path.split('.');
    let cur = o;
    for (const k of keys.slice(0, -1)) cur = cur[k] ||= {};
    cur[keys.at(-1)] = val;
  };
  return {
    docs,
    async updateOne({ _id }, u, { upsert } = {}) {
      let d = docs.get(_id);
      if (!d) {
        if (!upsert) return;
        d = { _id, ...u.$setOnInsert };
        docs.set(_id, d);
      }
      Object.assign(d, u.$set);
      for (const [k, n] of Object.entries(u.$inc || {})) set(d, k, (get(d, k) || 0) + n);
      for (const [k, { $each, $slice }] of Object.entries(u.$push || {})) set(d, k, [...$each, ...(get(d, k) || [])].slice(0, $slice));
    },
    async findOne({ _id }) {
      return docs.get(_id) || null;
    },
  };
}

test('a valid game token gives the player id, name and picture', () => {
  assert.deepEqual(verifyToken(tok(), SECRET), { id: 'g-1', name: 'Ali Khan', image: 'https://x.test/a.png' });
});

test('bad tokens are rejected: wrong secret, expired, tampered, no subject, no secret on the server', () => {
  assert.equal(verifyToken(tok({}, 'other'), SECRET), null);
  assert.equal(verifyToken(tok({ exp: exp(-5) }), SECRET), null);
  const [h, , s] = tok().split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: exp(3600) })).toString('base64url');
  assert.equal(verifyToken(`${h}.${forged}.${s}`, SECRET), null);
  assert.equal(verifyToken(tok({ sub: '' }), SECRET), null);
  assert.equal(verifyToken(tok(), ''), null, 'no GAME_TOKEN_SECRET: everyone is a guest');
  for (const junk of [null, undefined, 42, {}, 'a.b', 'x'.repeat(5000)]) assert.equal(verifyToken(junk, SECRET), null);
});

test('a non-https picture is dropped', () => {
  assert.equal(verifyToken(tok({ picture: 'javascript:alert(1)' }), SECRET).image, null);
});

test('results: only signed-in humans count, judged by their final role', () => {
  const acc = (id) => ({ id, name: id, image: null });
  const room = {
    winner: 'MAFIA',
    players: [
      { id: 'a', role: 'MAFIA', account: acc('A') }, // Thief who stole Mafia ends as MAFIA: a win
      { id: 'b', role: 'VILLAGER', account: acc('B') },
      { id: 'c', role: 'DOCTOR' }, // guest
      { id: 'd', role: 'MAFIA', bot: true, account: acc('BOT') },
    ],
  };
  assert.deepEqual(stats.resultsFor(room).map((r) => [r.account.id, r.role, r.won]), [['A', 'MAFIA', true], ['B', 'VILLAGER', false]]);
  room.winner = 'JESTER';
  room.players[1].role = 'JESTER';
  assert.deepEqual(stats.resultsFor(room).map((r) => r.won), [false, true]);
});

test('recordGame adds up games, wins, losses, per-role counts and recent games', async () => {
  const store = fakeUsers();
  stats.useStore(store);
  try {
    const me = { id: 'g-1', name: 'Ali', image: null };
    const game = (winner, role, n) => ({ code: 'ABCD', startedAt: n, winner, players: [{ id: 'p', role, account: me }] });
    await stats.recordGame(game('VILLAGERS', 'DOCTOR', 1));
    await stats.recordGame(game('MAFIA', 'DOCTOR', 2));
    await stats.recordGame(game('MAFIA', 'MAFIA', 3));
    const s = await stats.getStats('g-1');
    assert.equal(s.games, 3);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.deepEqual(s.byRole, { DOCTOR: { games: 2, wins: 1 }, MAFIA: { games: 1, wins: 1 } });
    assert.deepEqual(s.recent.map((r) => [r.role, r.won, r.gameId]), [['MAFIA', true, 'ABCD-3'], ['DOCTOR', false, 'ABCD-2'], ['DOCTOR', true, 'ABCD-1']]);
    assert.deepEqual(await stats.getStats('nobody'), { games: 0, wins: 0, losses: 0, byRole: {}, recent: [] });
  } finally {
    stats.useStore(null);
  }
});

test('without a database nothing is saved and nothing throws', async () => {
  stats.useStore(null);
  assert.equal(stats.enabled(), false);
  assert.equal(await stats.recordGame({ code: 'X', players: [{ role: 'MAFIA', account: { id: 'a' } }], winner: 'MAFIA' }), 0);
  assert.equal(await stats.getStats('a'), null);
});

module.exports = { fakeUsers, tok, SECRET };

test('the same account in two seats at one table is counted once', () => {
  const acc = { id: 'G', name: 'G', image: null };
  const room = { winner: 'VILLAGERS', players: [{ id: 't1', role: 'DOCTOR', account: acc }, { id: 't2', role: 'MAFIA', account: acc }] };
  assert.deepEqual(stats.resultsFor(room).map((r) => [r.account.id, r.role, r.won]), [['G', 'DOCTOR', true]]);
});
