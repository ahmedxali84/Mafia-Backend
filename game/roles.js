const MIN_PLAYERS = 5;
const MAX_PLAYERS = 12;

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

function teamOf(role) {
  return role === 'MAFIA' ? 'MAFIA' : 'VILLAGERS';
}

function assignRoles(players) {
  const roles = [];
  const m = mafiaCount(players.length);
  for (let i = 0; i < m; i++) roles.push('MAFIA');
  roles.push('DOCTOR', 'DETECTIVE');
  while (roles.length < players.length) roles.push('VILLAGER');
  shuffle(roles);
  players.forEach((p, i) => (p.role = roles[i]));
}

module.exports = { assignRoles, mafiaCount, teamOf, shuffle, MIN_PLAYERS, MAX_PLAYERS };
