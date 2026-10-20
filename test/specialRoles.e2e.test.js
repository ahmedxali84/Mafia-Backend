process.env.TIMER_SCALE = '0.02';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../index');
const rm = require('../rooms');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const EXTRAS = ['JESTER', 'THIEF'];
let url;

test.before(() => new Promise((r) => server.listen(0, () => {
  url = `http://localhost:${server.address().port}`;
  r();
})));
test.after(() => io.close());

// Two humans (on autopilot) + 5 bots = 7 seats, enough for both extra roles.
async function table(roleLists) {
  const humans = roleLists.map((roles, i) => ({
    socket: connect(url, { forceNew: true }), id: `h${i}-${Math.random()}`, name: `H${i}`, roles,
    state: null, leaks: [], over: null, told: [],
  }));
  for (const h of humans) {
    h.socket.on('your_role', (r) => h.told.push(r.role));
    h.socket.on('game_over', (g) => (h.over = g));
    h.socket.on('state', (st) => {
      h.state = st;
      if (st.phase !== 'GAME_OVER') {
        for (const p of st.players) {
          if (p.role && p.id !== h.id && p.alive && !(st.you.role === 'MAFIA' && p.role === 'MAFIA')) h.leaks.push([st.phase, p.role]);
        }
      }
      const others = st.players.filter((p) => p.alive && p.id !== h.id);
      if (st.you.alive && st.phase === 'NIGHT' && !st.you.nightTarget && ['MAFIA', 'DOCTOR', 'DETECTIVE', 'THIEF'].includes(st.you.role)) {
        const t = st.you.role === 'MAFIA' ? others.filter((p) => p.role !== 'MAFIA').reverse() : others;
        const target = (h.markId && st.you.role === 'THIEF' && h.markId) || t[0]?.id;
        if (target) h.socket.emit('night_action', { targetId: target }, () => {});
      }
      if (st.you.alive && st.phase === 'VOTING' && !st.you.vote && others.length) {
        h.socket.emit('cast_vote', { targetId: others[0].id }, () => {});
      }
    });
  }
  const [host, guest] = humans;
  const created = await emit(host.socket, 'create_room', { playerId: host.id, name: host.name, bots: 5, roles: host.roles });
  assert.ok(created.ok, created.error);
  assert.ok((await emit(guest.socket, 'join_room', { code: created.code, playerId: guest.id, name: guest.name, roles: guest.roles })).ok);
  return { humans, code: created.code };
}

async function finish({ humans }) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('game did not finish')), 30000);
    const iv = setInterval(() => {
      if (humans.every((h) => h.over)) {
        clearTimeout(t);
        clearInterval(iv);
        resolve();
      }
    }, 20);
  });
  humans.forEach((h) => h.socket.close());
}

test('an old client at the table: no Jester or Thief is dealt, and the lobby says so', async () => {
  const t = await table([EXTRAS, undefined]);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(t.humans[0].state.extraRoles, [], 'lobby mix shows no extras');
  assert.ok((await emit(t.humans[0].socket, 'start_game', {})).ok);
  const dealt = rm.rooms[t.code].players.map((p) => p.role);
  assert.ok(!dealt.includes('JESTER') && !dealt.includes('THIEF'), dealt.join());
  await finish(t);
  for (const h of t.humans) {
    assert.ok(['MAFIA', 'VILLAGERS'].includes(h.over.winner));
    assert.deepEqual(h.leaks, []);
  }
});

test('new clients: both roles are dealt and full games finish with no leaks', async () => {
  const winners = {};
  let humanThefts = 0;
  for (let i = 0; i < 8; i++) {
    const t = await table([EXTRAS, EXTRAS]);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(t.humans[1].state.extraRoles, EXTRAS);
    assert.ok((await emit(t.humans[0].socket, 'start_game', {})).ok);
    const dealt = rm.rooms[t.code].players.map((p) => p.role);
    assert.ok(dealt.includes('JESTER') && dealt.includes('THIEF'), dealt.join());
    await finish(t);
    for (const h of t.humans) {
      assert.deepEqual(h.leaks, [], 'a living role leaked');
      assert.ok(['MAFIA', 'VILLAGERS', 'JESTER'].includes(h.over.winner));
      // A human Thief who robbed someone was told their new role; so was a robbed human.
      const me = rm.rooms[t.code].players.find((p) => p.id === h.id);
      if (me.stole || me.robbed) {
        humanThefts++;
        assert.equal(h.told.length, 2, 'role told at the deal and again after the theft');
        assert.equal(h.told[1], me.stole ? me.stole.role : 'VILLAGER');
      }
    }
    winners[t.humans[0].over.winner] = (winners[t.humans[0].over.winner] || 0) + 1;
  }
  console.log('winners', winners, 'human thefts', humanThefts);
});

test('a human Thief robs a human Mafia: both are told, the family channel moves to the thief', async () => {
  const t = await table([EXTRAS, EXTRAS]);
  const [thief, mafia] = t.humans;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await emit(thief.socket, 'start_game', {})).ok);
  // Rig the deal: the host is the Thief, the guest one of the Mafia.
  const room = rm.rooms[t.code];
  const seat = (id) => room.players.find((p) => p.id === id);
  const swap = (a, role) => {
    if (a.role === role) return;
    const holder = room.players.find((p) => p.role === role && p.id !== a.id);
    [a.role, holder.role] = [holder.role, a.role];
  };
  swap(seat(thief.id), 'THIEF');
  swap(seat(mafia.id), 'MAFIA');
  thief.markId = mafia.id;

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no theft')), 10000);
    const iv = setInterval(() => {
      if (seat(thief.id).stole) {
        clearTimeout(to);
        clearInterval(iv);
        resolve();
      }
    }, 10);
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(thief.told.at(-1), 'MAFIA');
  assert.equal(mafia.told.at(-1), 'VILLAGER');
  assert.deepEqual(thief.state.you.stole, { targetId: mafia.id, role: 'MAFIA', day: 1 });
  assert.equal(thief.state.you.team, 'MAFIA');
  assert.equal(mafia.state.you.robbed.role, 'MAFIA');
  assert.equal(mafia.state.you.team, 'VILLAGERS');
  assert.ok(mafia.state.chat.every((m) => m.channel !== 'mafia'), 'the victim can no longer read the family channel');
  assert.equal(mafia.state.players.find((p) => p.id === thief.id).role, undefined, 'and cannot see the thief');
  await finish(t);
  for (const h of t.humans) assert.deepEqual(h.leaks, []);
});
