// Week 5 QA: the three chats. Who may write where, and who may read what, in every phase.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatChannel, canSeeMessage, stateFor } = require('../view');
const { PHASES } = require('../game/phases');

const P = (id, role, alive = true) => ({ id, name: id, role, alive, connected: true, checks: [] });
const room = (phase, players = []) => ({ code: 'TEST', phase, players, night: { actions: {} }, votes: {}, chat: [], day: 1 });

const mafia = P('mafia', 'MAFIA');
const villager = P('villager', 'VILLAGER');
const doctor = P('doctor', 'DOCTOR');
const detective = P('detective', 'DETECTIVE');
const ghost = P('ghost', 'VILLAGER', false);
const deadMafia = P('deadMafia', 'MAFIA', false);
const DAY = ['DAY_RESULT', 'DISCUSSION', 'VOTING', 'VOTE_RESULT'];

test('who writes where: lobby/game over = town, role reveal = closed', () => {
  for (const phase of ['LOBBY', 'GAME_OVER']) {
    for (const p of [mafia, villager, ghost]) assert.equal(chatChannel(room(phase), p), 'public', `${p.id} in ${phase}`);
  }
  for (const p of [mafia, villager, doctor, ghost]) assert.equal(chatChannel(room('ROLE_REVEAL'), p), null, p.id);
});

test('day: the living write to town chat, the dead to ghost chat', () => {
  for (const phase of DAY) {
    for (const p of [mafia, villager, doctor, detective]) assert.equal(chatChannel(room(phase), p), 'public', `${p.id} in ${phase}`);
    assert.equal(chatChannel(room(phase), ghost), 'dead', phase);
    assert.equal(chatChannel(room(phase), deadMafia), 'dead', `dead mafia in ${phase}`);
  }
});

test('night: only living Mafia can write (Mafia chat); town is silent; ghosts keep talking', () => {
  const r = room('NIGHT');
  assert.equal(chatChannel(r, mafia), 'mafia');
  for (const p of [villager, doctor, detective]) assert.equal(chatChannel(r, p), null, p.id);
  assert.equal(chatChannel(r, ghost), 'dead');
  assert.equal(chatChannel(r, deadMafia), 'dead', 'a dead Mafia member joins the ghosts, not the Mafia chat');
});

test('every phase in the game has a chat rule (none left undefined)', () => {
  for (const phase of PHASES) {
    for (const p of [mafia, villager, ghost]) {
      const ch = chatChannel(room(phase), p);
      assert.ok(ch === null || ['public', 'mafia', 'dead'].includes(ch), `${phase}/${p.id} -> ${ch}`);
    }
  }
});

test('who reads what: town = everyone, Mafia chat = Mafia only, ghost chat = dead only', () => {
  const msg = (channel, extra = {}) => ({ channel, from: 'x', ...extra });
  for (const phase of ['NIGHT', ...DAY]) {
    const r = room(phase);
    for (const p of [mafia, villager, doctor, detective, ghost, deadMafia]) {
      assert.equal(canSeeMessage(r, p, msg('public')), true, `${p.id} reads town in ${phase}`);
      assert.equal(canSeeMessage(r, p, msg('mafia')), p.role === 'MAFIA', `${p.id} vs Mafia chat in ${phase}`);
      assert.equal(canSeeMessage(r, p, msg('dead')), !p.alive, `${p.id} vs ghost chat in ${phase}`);
    }
  }
});

test('game over: ghost chat is revealed to everyone; Mafia chat stays with the Mafia', () => {
  const r = room('GAME_OVER');
  assert.equal(canSeeMessage(r, villager, { channel: 'dead' }), true);
  assert.equal(canSeeMessage(r, villager, { channel: 'mafia' }), false);
  assert.equal(canSeeMessage(r, mafia, { channel: 'mafia' }), true);
});

test('chat history in state (what a refresh restores) follows the same rules', () => {
  const players = [mafia, villager, ghost].map((p) => ({ ...p }));
  const r = room('DISCUSSION', players);
  r.chat = [
    { id: '1', channel: 'public', from: 'villager', text: 'hello town' },
    { id: '2', channel: 'mafia', from: 'mafia', text: 'kill the villager' },
    { id: '3', channel: 'dead', from: 'ghost', text: 'boo' },
  ];
  const texts = (id) => stateFor(r, players.find((p) => p.id === id)).chat.map((m) => m.text);
  assert.deepEqual(texts('villager'), ['hello town']);
  assert.deepEqual(texts('mafia'), ['hello town', 'kill the villager']);
  assert.deepEqual(texts('ghost'), ['hello town', 'boo']);
  for (const id of ['villager', 'mafia', 'ghost']) {
    assert.equal(stateFor(r, players.find((p) => p.id === id)).you.chatChannel, chatChannel(r, players.find((p) => p.id === id)));
  }
});
