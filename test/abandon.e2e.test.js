// QA audit: a game must never hang. The only human leaves mid-game; their seat goes on
// autopilot and the game still reaches GAME_OVER on its own timers.
process.env.TIMER_SCALE = '0.01';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const { rooms } = require('../rooms');
const { clearTimers } = require('../game/phases');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const until = (fn, ms = 30000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(iv); reject(new Error('timeout')); }, ms);
    const iv = setInterval(() => { if (fn()) { clearTimeout(t); clearInterval(iv); resolve(); } }, 20);
  });

test('the only human drops mid-game: the game still finishes on its own', async () => {
  await new Promise((r) => server.listen(0, r));
  const socket = connect(`http://localhost:${server.address().port}`, { forceNew: true });
  const { code } = await emit(socket, 'create_room', { playerId: 'solo', name: 'Solo', bots: 4 });
  const room = rooms[code];
  try {
    assert.ok((await emit(socket, 'start_game', {})).ok);
    await until(() => room.phase === 'NIGHT');
    socket.close(); // tab closed mid-game
    await until(() => room.players.find((p) => p.id === 'solo').connected === false);
    const seen = new Set();
    await until(() => (seen.add(room.phase), room.phase === 'GAME_OVER'));
    assert.ok(seen.has('VOTING') || seen.has('DAY_RESULT'), `phases ran: ${[...seen]}`);
    assert.ok(rooms[code], 'kept for 5 minutes in case the player comes back');
  } finally {
    clearTimers(room);
    clearTimeout(room.cleanupTimer);
    socket.close();
    io.close();
  }
});
