process.env.TIMER_SCALE = '0.02';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

test('5 clients play a full game; roles never leak; game ends', async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const clients = Array.from({ length: 5 }, (_, i) => {
    const socket = connect(url, { forceNew: true });
    return { socket, id: `player-${i}`, name: `P${i}`, state: null, leaks: [], over: null };
  });

  for (const c of clients) {
    c.socket.on('state', (st) => {
      c.state = st;
      // Leak check: while playing, only own role, dead players and (for mafia) teammates are visible.
      if (st.phase !== 'GAME_OVER') {
        for (const p of st.players) {
          if (p.role && p.id !== c.id && p.alive) {
            if (!(st.you.role === 'MAFIA' && p.role === 'MAFIA')) c.leaks.push(p);
          }
        }
      }
      const alive = st.players.filter((p) => p.alive && p.id !== c.id);
      if (st.you.alive && st.phase === 'NIGHT' && !st.you.nightTarget && ['MAFIA', 'DOCTOR', 'DETECTIVE'].includes(st.you.role)) {
        const targets = st.you.role === 'MAFIA' ? alive.filter((p) => p.role !== 'MAFIA') : alive;
        c.socket.emit('night_action', { targetId: targets[0].id }, () => {});
      }
      if (st.you.alive && st.phase === 'VOTING' && !st.you.vote) {
        // everyone votes for the first living player that is not themselves
        c.socket.emit('cast_vote', { targetId: alive[0].id }, () => {});
      }
    });
    c.socket.on('game_over', (g) => (c.over = g));
  }

  const created = await emit(clients[0].socket, 'create_room', { playerId: clients[0].id, name: clients[0].name });
  assert.ok(created.code);
  assert.equal((await emit(clients[1].socket, 'join_room', { code: 'ZZZZ', playerId: 'x', name: 'X' })).error, 'Room not found');
  for (const c of clients.slice(1)) {
    const r = await emit(c.socket, 'join_room', { code: created.code, playerId: c.id, name: c.name });
    assert.ok(r.ok, r.error);
  }
  assert.ok((await emit(clients[1].socket, 'start_game', {})).error, 'non-host cannot start');
  assert.ok((await emit(clients[0].socket, 'start_game', {})).ok);
  const late = connect(url, { forceNew: true });
  assert.equal((await emit(late, 'join_room', { code: created.code, playerId: 'late', name: 'Late' })).error, 'Game already started');
  late.close();

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('game did not finish')), 20000);
    const iv = setInterval(() => {
      if (clients.every((c) => c.over)) {
        clearTimeout(t);
        clearInterval(iv);
        resolve();
      }
    }, 50);
  });

  assert.ok(['MAFIA', 'VILLAGERS'].includes(clients[0].over.winner));
  for (const c of clients) assert.deepEqual(c.leaks, [], 'role leaked');

  clients.forEach((c) => c.socket.close());
  io.close();
});
