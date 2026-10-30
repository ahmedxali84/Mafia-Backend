// Win/loss stats for signed-in players, saved in MongoDB (week 7). Off unless MONGODB_URI is set:
// guests and a server without a database play exactly as before (the browser keeps its own stats).
// One document per Google account in the `users` collection:
//   { _id: <google id>, name, image, games, wins, losses, byRole: { MAFIA: { games, wins } }, recent: [...] }
const { teamOf } = require('./game/roles');

const RECENT = 10;
let users = null; // the collection, or a stand-in set by tests

async function connect(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || 'mafia') {
  if (!uri) return false;
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  users = client.db(dbName).collection('users');
  return true;
}

const enabled = () => !!users;
const useStore = (store) => (users = store); // tests

// Who gets a result recorded at the end of a game: humans who were signed in, once per account
// (the same account in two tabs at one table counts once, for the first seat).
// Won = their final role's team won (a Thief is judged by the role they stole).
function resultsFor(room) {
  const seen = new Set();
  return room.players
    .filter((p) => !p.bot && p.account && p.role && !seen.has(p.account.id) && seen.add(p.account.id))
    .map((p) => ({ account: p.account, role: p.role, won: teamOf(p.role) === room.winner }));
}

async function recordGame(room) {
  if (!users) return 0;
  const gameId = `${room.code}-${room.startedAt}`;
  const at = new Date();
  const results = resultsFor(room);
  await Promise.all(
    results.map(({ account, role, won }) =>
      users.updateOne(
        { _id: account.id },
        {
          $set: { name: account.name, image: account.image, updatedAt: at },
          $setOnInsert: { createdAt: at },
          $inc: { games: 1, wins: won ? 1 : 0, losses: won ? 0 : 1, [`byRole.${role}.games`]: 1, [`byRole.${role}.wins`]: won ? 1 : 0 },
          $push: { recent: { $each: [{ role, won, at, gameId }], $position: 0, $slice: RECENT } },
        },
        { upsert: true }
      )
    )
  );
  return results.length;
}

async function getStats(id) {
  if (!users) return null;
  const doc = await users.findOne({ _id: id });
  if (!doc) return { games: 0, wins: 0, losses: 0, byRole: {}, recent: [] };
  const { games = 0, wins = 0, losses = 0, byRole = {}, recent = [] } = doc;
  return { games, wins, losses, byRole, recent };
}

module.exports = { connect, enabled, useStore, resultsFor, recordGame, getStats };
