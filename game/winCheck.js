// Returns 'VILLAGERS', 'MAFIA', or null while the game is still going.
function winCheck(players) {
  const alive = players.filter((p) => p.alive);
  const mafia = alive.filter((p) => p.role === 'MAFIA').length;
  const others = alive.length - mafia;
  if (mafia === 0) return 'VILLAGERS';
  if (mafia >= others) return 'MAFIA';
  return null;
}

module.exports = { winCheck };
