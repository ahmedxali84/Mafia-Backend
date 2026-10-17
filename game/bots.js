// Bot brains. Bots (and disconnected humans, on autopilot) act each phase so the
// game keeps moving. They also talk in chat to give the table some life.
const actions = require('./actions');

const NAMES = ['Vinnie', 'Rosa', 'Sal', 'Lucky', 'Dutch', 'Mickey', 'Velma', 'Frankie', 'Nico', 'Lola', 'Bugsy', 'Marlowe', 'Greta', 'Silk'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const fill = (line, vars) => line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

const LINES = {
  killed: ['Poor {name}. The streets got colder last night.', 'They found {name} in the alley. No witnesses.', '{name} didn\'t deserve that. Somebody here knows something.', 'Another body. This town is rotten.'],
  saved: ['Somebody tried. The Doctor got there first.', 'A close one last night. Someone was meant to die.', 'Nobody dead? The Mafia missed. Lucky us.'],
  suspect: ['Something about {name} doesn\'t sit right with me.', '{name} has been awfully quiet. Quiet people hide things.', 'I\'ve got my eye on {name}.', 'Where were you last night, {name}?', '{name}\'s story has more holes than a cheap suit.'],
  defend: ['Don\'t look at me. I was home all night.', 'I\'m just a villager trying to survive.', 'Accuse me if you want. You\'ll be wasting a vote.'],
  claim: ['I\'m the Detective. I checked {name} last night. They\'re MAFIA.', 'Listen up. I\'m the Detective and {name} came back dirty. Mafia.'],
  clear: ['I checked {name}. They\'re clean.'],
  liar: ['{name} is lying. Fake Detective, that\'s exactly what the Mafia would do.', 'Convenient story, {name}. I don\'t buy it.'],
  vote: ['My vote is on {name}.', 'I\'m going with {name}.', 'Sorry {name}. Nothing personal.'],
  mafiaNight: ['Let\'s take {name} tonight.', '{name}. Quick and quiet.', 'I say {name}. They\'re getting too close.'],
};

function say(room, ctx, bot, kind, vars, channel = 'public') {
  if (!ctx.onBotChat) return;
  // Avoid repeating a line someone at the table said recently.
  const recent = (room.botSaid ||= []);
  const options = LINES[kind].filter((l) => !recent.includes(l));
  const line = pick(options.length ? options : LINES[kind]);
  recent.push(line);
  if (recent.length > 8) recent.shift();
  ctx.onBotChat(room, bot, fill(line, vars || {}), channel);
}

function botName(room) {
  const used = new Set(room.players.map((p) => p.name.toLowerCase()));
  const free = NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length) return pick(free);
  let i = 2;
  while (used.has(`bot ${i}`)) i++;
  return `Bot ${i}`;
}

// Public "I'm the Detective, X is Mafia" claims, made by bot detectives.
function claims(room) {
  return (room.claims ||= []);
}

// Who the bots collectively suspect most right now (alive only).
function topSuspect(room, excludeIds = []) {
  const alive = (id) => actions.findPlayer(room, id)?.alive && !excludeIds.includes(id);
  const c = claims(room).filter((x) => alive(x.targetId) && actions.findPlayer(room, x.by)?.alive);
  return c.length ? c[c.length - 1].targetId : null;
}

// Current vote leader (alive, not SKIP).
function voteLeader(room) {
  const counts = {};
  for (const t of Object.values(room.votes)) if (t !== 'SKIP') counts[t] = (counts[t] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

function nightTarget(room, bot) {
  const others = room.players.filter((p) => p.alive && p.id !== bot.id);
  if (bot.role === 'MAFIA') {
    const victims = others.filter((p) => p.role !== 'MAFIA');
    if (!victims.length) return null;
    // Follow a teammate's pick so the family agrees.
    const mates = room.players.filter((p) => p.alive && p.role === 'MAFIA' && p.id !== bot.id);
    const matePick = mates.map((m) => room.night.actions[m.id]).find(Boolean);
    if (matePick) return matePick;
    // Go after anyone who publicly claimed Detective.
    const claimer = claims(room).map((c) => actions.findPlayer(room, c.by)).find((p) => p?.alive && p.role !== 'MAFIA');
    return (claimer || pick(victims)).id;
  }
  if (bot.role === 'DOCTOR') {
    const claimer = claims(room).map((c) => actions.findPlayer(room, c.by)).find((p) => p?.alive);
    if (claimer && chance(0.65)) return claimer.id;
    if (chance(0.3)) return bot.id;
    return others.length ? pick(others).id : bot.id;
  }
  if (bot.role === 'DETECTIVE') {
    const checked = new Set((bot.checks || []).map((c) => c.targetId));
    const fresh = others.filter((p) => !checked.has(p.id));
    return (fresh.length ? pick(fresh) : pick(others))?.id || null;
  }
  return null;
}

function voteTarget(room, bot) {
  const others = room.players.filter((p) => p.alive && p.id !== bot.id);
  if (!others.length) return 'SKIP';
  if (bot.role === 'DETECTIVE') {
    const known = (bot.checks || []).find((c) => c.isMafia && actions.findPlayer(room, c.targetId)?.alive);
    if (known) return known.targetId;
  }
  if (bot.role === 'MAFIA') {
    const ok = others.filter((p) => p.role !== 'MAFIA');
    if (!ok.length) return 'SKIP';
    const leader = voteLeader(room);
    if (leader && ok.some((p) => p.id === leader)) return leader;
    // Turn on whoever exposed a teammate.
    const accuser = claims(room).find((c) => actions.findPlayer(room, c.targetId)?.role === 'MAFIA');
    if (accuser && ok.some((p) => p.id === accuser.by)) return accuser.by;
    return pick(ok).id;
  }
  const suspect = topSuspect(room, [bot.id]);
  if (suspect && chance(0.8)) return suspect;
  const leader = voteLeader(room);
  if (leader && leader !== bot.id && chance(0.5)) return leader;
  if (chance(0.1)) return 'SKIP';
  return pick(others).id;
}

// Autopilot players: bots, plus humans who dropped mid-game.
const actors = (room) => room.players.filter((p) => p.alive && (p.bot || !p.connected));
const talkers = (room) => room.players.filter((p) => p.alive && p.bot);

function later(room, ms, fn) {
  room.botTimers.push(setTimeout(fn, ms));
}

// Called by setPhase. `scale` shrinks delays in tests; `after(room)` lets the
// engine end the phase early and broadcast.
function schedule(room, ctx, { scale, after }) {
  const phase = room.phase;
  const still = () => room.phase === phase;

  if (phase === 'NIGHT') {
    for (const bot of actors(room)) {
      if (!actions.NIGHT_ROLES.includes(bot.role)) continue;
      later(room, (2500 + Math.random() * 9000) * scale, () => {
        if (!still() || !bot.alive) return;
        const t = nightTarget(room, bot);
        if (!t) return;
        actions.submitNightAction(room, bot.id, t);
        const humanMates = room.players.some((p) => p.role === 'MAFIA' && !p.bot && p.alive);
        if (bot.bot && bot.role === 'MAFIA' && humanMates && chance(0.6)) {
          say(room, ctx, bot, 'mafiaNight', { name: actions.findPlayer(room, t).name }, 'mafia');
        }
        after(room);
      });
    }
  }

  if (phase === 'DISCUSSION') {
    const r = room.result;
    talkers(room).forEach((bot, i) => {
      // First reactions to the night, then accusations.
      later(room, (2000 + i * 1800 + Math.random() * 3000) * scale, () => {
        if (!still() || !bot.alive) return;
        if (bot.role === 'DETECTIVE') {
          const last = (bot.checks || [])[bot.checks.length - 1];
          const target = last && actions.findPlayer(room, last.targetId);
          if (target?.alive && last.isMafia) {
            claims(room).push({ by: bot.id, targetId: target.id });
            return say(room, ctx, bot, 'claim', { name: target.name });
          }
          if (target?.alive && chance(0.35)) return say(room, ctx, bot, 'clear', { name: target.name });
        }
        if (r?.killedName && chance(0.55)) return say(room, ctx, bot, 'killed', { name: r.killedName });
        if (r?.saved && chance(0.5)) return say(room, ctx, bot, 'saved');
        if (chance(0.6)) {
          const others = room.players.filter((p) => p.alive && p.id !== bot.id && (bot.role !== 'MAFIA' || p.role !== 'MAFIA'));
          if (others.length) say(room, ctx, bot, 'suspect', { name: pick(others).name });
        }
      });
      // A mafia bot that was just exposed fights back.
      later(room, (9000 + Math.random() * 8000) * scale, () => {
        if (!still() || !bot.alive || bot.role !== 'MAFIA') return;
        const c = claims(room).find((x) => x.targetId === bot.id);
        const accuser = c && actions.findPlayer(room, c.by);
        if (accuser?.alive) say(room, ctx, bot, 'liar', { name: accuser.name });
        else if (chance(0.25)) say(room, ctx, bot, 'defend');
      });
    });
  }

  if (phase === 'VOTING') {
    actors(room).forEach((bot, i) => {
      later(room, (3000 + i * 1200 + Math.random() * 7000) * scale, () => {
        if (!still() || !bot.alive) return;
        const t = voteTarget(room, bot);
        actions.castVote(room, bot.id, t);
        if (bot.bot && t !== 'SKIP' && chance(0.3)) say(room, ctx, bot, 'vote', { name: actions.findPlayer(room, t).name });
        after(room);
      });
    });
  }
}

module.exports = { schedule, botName };
