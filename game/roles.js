const MIN_PLAYERS = 5;
const MAX_PLAYERS = 12;
// Bigger tables get the extra roles: the Jester from 6 players, the Thief from 7.
const JESTER_FROM = 6;
const THIEF_FROM = 7;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function mafiaCount(n) {
  if (n <= 6) return 1;
  if (n <= 9) return 2;
  return 3;
}

// The Jester plays alone: they win only by getting themselves voted out.
// The Thief is town until they steal a role, then they belong to whatever team that role is on.
function teamOf(role) {
  if (role === 'MAFIA') return 'MAFIA';
  if (role === 'JESTER') return 'JESTER';
  return 'VILLAGERS';
}

// The roles dealt to a table of n players (unshuffled).
function rolesFor(n) {
  const roles = [];
  const m = mafiaCount(n);
  for (let i = 0; i < m; i++) roles.push('MAFIA');
  roles.push('DOCTOR', 'DETECTIVE');
  if (n >= JESTER_FROM) roles.push('JESTER');
  if (n >= THIEF_FROM) roles.push('THIEF');
  while (roles.length < n) roles.push('VILLAGER');
  return roles;
}

function assignRoles(players) {
  const roles = shuffle(rolesFor(players.length));
  players.forEach((p, i) => (p.role = roles[i]));
}

module.exports = { assignRoles, rolesFor, mafiaCount, teamOf, shuffle, MIN_PLAYERS, MAX_PLAYERS, JESTER_FROM, THIEF_FROM };
