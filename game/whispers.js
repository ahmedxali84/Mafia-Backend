// Whispers: each player may secretly message one living player a limited number of
// times per game. Everyone sees THAT a whisper happened (a public notice) but never
// the text - only the sender and the receiver can read it.
const WHISPERS_PER_GAME = 2;
const MAX_LEN = 140;
const ALLOWED_PHASES = ['DISCUSSION', 'VOTING'];

function resetWhispers(room) {
  room.players.forEach((p) => {
    p.whispersLeft = WHISPERS_PER_GAME;
  });
}

const left = (p) => (typeof p.whispersLeft === 'number' ? p.whispersLeft : 0);

// Returns { error } or { whisper, notice } messages ready to be stored and delivered.
function sendWhisper(room, fromId, toId, text) {
  if (!ALLOWED_PHASES.includes(room.phase)) return { error: 'Whispers are only allowed during the day' };
  const from = room.players.find((p) => p.id === fromId);
  const to = room.players.find((p) => p.id === toId);
  if (!from || !from.alive) return { error: 'Dead players cannot whisper' };
  if (!to || !to.alive) return { error: 'Choose a living player' };
  if (from.id === to.id) return { error: 'You cannot whisper to yourself' };
  const clean = String(text || '').trim().slice(0, MAX_LEN);
  if (!clean) return { error: 'Write something first' };
  if (left(from) <= 0) return { error: 'You have no whispers left' };

  from.whispersLeft = left(from) - 1;
  const base = { ts: Date.now() };
  const id = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    whisper: { ...base, id: id(), channel: 'whisper', from: from.id, name: from.name, to: to.id, toName: to.name, text: clean },
    // The public notice deliberately carries no text.
    notice: { ...base, id: id(), channel: 'notice', from: from.id, name: from.name, to: to.id, toName: to.name, text: `${from.name} whispered to ${to.name}` },
  };
}

module.exports = { WHISPERS_PER_GAME, MAX_LEN, ALLOWED_PHASES, resetWhispers, sendWhisper, left };
