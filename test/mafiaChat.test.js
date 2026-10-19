const test = require('node:test');
const assert = require('node:assert/strict');
const { stateFor, canWriteMafiaChat } = require('../view');

const mk = (roles, phase = 'DISCUSSION') => ({
  phase,
  night: { actions: {} },
  votes: {},
  chat: [],
  players: roles.map((role, i) => ({ id: `p${i}`, name: `P${i}`, role, alive: true })),
});

test('two or more Mafia get a private channel, open day and night', () => {
  for (const phase of ['ROLE_REVEAL', 'NIGHT', 'DISCUSSION', 'VOTING']) {
    const room = mk(['MAFIA', 'MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER', 'VILLAGER'], phase);
    assert.deepEqual(stateFor(room, room.players[0]).you.mafiaChat, { canWrite: true }, phase);
    assert.equal(stateFor(room, room.players[2]).you.mafiaChat, null, 'town never gets it');
  }
});

test('a lone Mafia has no channel; the dead can read but not write', () => {
  const solo = mk(['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER']);
  assert.equal(stateFor(solo, solo.players[0]).you.mafiaChat, null);

  const room = mk(['MAFIA', 'MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER', 'VILLAGER']);
  room.players[1].alive = false;
  assert.deepEqual(stateFor(room, room.players[1]).you.mafiaChat, { canWrite: false });
  assert.equal(canWriteMafiaChat(room, room.players[1]), false);
  assert.equal(canWriteMafiaChat(room, room.players[0]), true);

  room.phase = 'GAME_OVER';
  assert.equal(canWriteMafiaChat(room, room.players[0]), false, 'closed once the game ends');
});

test('Mafia messages are only visible to the Mafia', () => {
  const room = mk(['MAFIA', 'MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER', 'VILLAGER', 'VILLAGER']);
  room.chat.push({ id: 'm1', channel: 'mafia', from: 'p0', name: 'P0', text: 'take the doctor' });
  assert.equal(stateFor(room, room.players[1]).chat.length, 1);
  for (const p of room.players.slice(2)) assert.equal(stateFor(room, p).chat.length, 0);
});
