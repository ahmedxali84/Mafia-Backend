# Mafia — Backend

Game server for the multiplayer Mafia web game: **Node + Express + Socket.IO**.
All live game state is kept in server memory. Also relays signaling for the in-game
voice chat (audio itself is peer-to-peer, see [docs/VOICE.md](docs/VOICE.md)).

Frontend repo: `mafia-frontend` (Next.js).

## Requirements

- Node.js **22+** (`.nvmrc`)
- npm

## Run locally

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:4000  (auto-restarts on file changes)
```

`npm start` runs without the file watcher (use it if the project lives in a synced
folder like OneDrive, which can trigger restarts that wipe running games).

Check it: `GET /health` → `{ "ok": true, "rooms": 0 }`

## Environment variables

| Name | Required | Description |
|---|---|---|
| `PORT` | no | Port to listen on (default `4000`; hosts set it for you) |
| `NODE_ENV` | prod | `production` disables the debug "Add bots" buttons |
| `CLIENT_ORIGIN` | no | Frontend URL(s) allowed by CORS, comma separated. Empty = `https://mafia-frontend-lyart.vercel.app` + `localhost:3000` |
| `ENABLE_DEBUG` | no | `true` keeps debug bots on in production |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | no | TURN relay for voice chat when players are behind strict NATs |

## Tests

```bash
npm test
```

Unit tests for roles, win check, night actions, voting, whispers and voice routing, plus
end-to-end games over real sockets (no role or whisper leaks, voice signaling rules).

Fill a room with socket bots while testing: `npm run bots -- ABCD` (room code).

## Deploy

The server needs a host that keeps a **long-running Node process with WebSockets**
(Render, Railway, Fly.io…). Serverless platforms like Vercel do **not** work for this repo.
Run a **single instance**: rooms live in memory.

**Render** (blueprint included):
1. Push this repo to GitHub.
2. Render → New → **Blueprint** → pick the repo (uses `render.yaml`).
3. The live frontend `https://mafia-frontend-lyart.vercel.app` is allowed by default; set `CLIENT_ORIGIN` only to use other/extra URLs (e.g. Vercel preview links).

**Railway / other:** build `npm ci`, start `npm start`, health check `/health`,
env `NODE_ENV=production` (`CLIENT_ORIGIN` only if the frontend URL differs from the default).

Then set the frontend's `NEXT_PUBLIC_SERVER_URL` to this server's public URL.

> Free Render instances sleep when idle; the first visit after a while takes ~30–60 s.

## Layout

```
index.js        sockets + HTTP (health)
rooms.js        create/join/leave, reconnects, cleanup
view.js         what each player may see / hear (roles, chat, voice routes)
game/           roles, phases, actions, win check, whispers, bots
test/           node:test suites
scripts/        addBots.js (socket bots for manual testing)
docs/VOICE.md   voice chat design + signaling protocol
```

## Rules (summary)

- 5–12 players. Mafia: 1 (5–6), 2 (7–9), 3 (10–12). Always 1 Doctor + 1 Detective.
- Jester (6+ players): plays alone. If the town votes them out, the game ends at once and the Jester wins. Killed at night, they just die. The Detective sees them as not Mafia.
- Thief (7+ players): on the first night, picks a player and takes their role and team at dawn; that player becomes a Villager. The night still resolves on the old roles (a robbed Mafia's kill counts, checks see the old role). Robbing the night's victim gets nothing. After night 1 there is no Thief: an unused Thief settles as a Villager. Everyone hears that a role was stolen, not by whom.
- The Jester and Thief are only dealt when every human at the table runs a frontend that can show them (clients list them in `roles` on `create_room` / `join_room`), so an old frontend never receives a role it doesn't know. Deploy order between backend and frontend doesn't matter.
- Phases: LOBBY → ROLE_REVEAL → NIGHT → DAY_RESULT → DISCUSSION → VOTING → VOTE_RESULT → (NIGHT | GAME_OVER).
- Voice and chat: public by day, Mafia-only at night, ghosts only talk to ghosts.
