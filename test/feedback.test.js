// Week 8: the feedback form's server side.
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.NODE_ENV = 'test';
process.env.FEEDBACK_FILE = path.join(os.tmpdir(), `mafia-feedback-${process.pid}.jsonl`);
process.env.FEEDBACK_TOKEN = 'test-secret-token';
const test = require('node:test');
const assert = require('node:assert/strict');
const { server, io } = require('../index');
const { validate } = require('../feedback');

let url;
test.before(() => new Promise((r) => server.listen(0, () => { url = `http://localhost:${server.address().port}`; r(); })));
test.after(() => {
  io.close();
  fs.rmSync(process.env.FEEDBACK_FILE, { force: true });
});

const send = (body, ip = '10.0.0.1') =>
  fetch(`${url}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

test('validation: rating 1-5 required; text trimmed and capped; unknown fields dropped', () => {
  for (const bad of [{}, { rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: 'x' }, null]) assert.ok(validate(bad).error, JSON.stringify(bad));
  const { entry } = validate({ rating: '4', text: `  ${'a'.repeat(1500)}  `, page: 'hacker', name: 'Usman', isAdmin: true });
  assert.equal(entry.rating, 4);
  assert.equal(entry.text.length, 1000);
  assert.equal(entry.page, 'menu', 'unknown page falls back');
  assert.equal(entry.isAdmin, undefined);
});

test('a player can send feedback; the team reads it with the token only', async () => {
  const ok = await send({ rating: 5, text: 'Loved the kill animation', page: 'game-over', name: 'Usman', gameId: 'ABCD-1' });
  assert.equal(ok.status, 201);
  assert.equal((await send({ rating: 9 })).status, 400);

  assert.equal((await fetch(`${url}/feedback`)).status, 401, 'no token');
  assert.equal((await fetch(`${url}/feedback`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const res = await fetch(`${url}/feedback`, { headers: { authorization: 'Bearer test-secret-token' } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.count, 1);
  assert.equal(data.averageRating, 5);
  assert.equal(data.latest[0].text, 'Loved the kill animation');
  assert.equal(data.latest[0].page, 'game-over');
});

test('spam limit: 5 per visitor per 10 minutes, other visitors unaffected', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await send({ rating: 3 }, '10.0.0.9')).status, 201);
  assert.equal((await send({ rating: 3 }, '10.0.0.9')).status, 429);
  assert.equal((await send({ rating: 3 }, '10.0.0.10')).status, 201, 'a different player can still send');
});

test('oversized or broken bodies are rejected without crashing', async () => {
  const big = await fetch(`${url}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.20' }, body: JSON.stringify({ rating: 3, text: 'x'.repeat(10000) }) });
  assert.equal(big.status, 413);
  const broken = await fetch(`${url}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.21' }, body: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal((await fetch(`${url}/health`)).status, 200, 'server still up');
});

test('CORS: the deployed frontend may post feedback', async () => {
  const pre = await fetch(`${url}/feedback`, { method: 'OPTIONS', headers: { origin: 'https://mafia-frontend-lyart.vercel.app', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://mafia-frontend-lyart.vercel.app');
});
