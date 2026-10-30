# Socket events

The client and server talk over Socket.IO. This is the full list, taken from `index.js`.
Voice signaling is described in more detail in [VOICE.md](VOICE.md).

**Rules that every event follows**

- Players are identified by `playerId` (a random id kept in the browser's `localStorage`), never by
  the socket id. A refresh or a new connection with the same `playerId` gets the same seat back.
- Client → server events take an optional acknowledgement callback. It is called with
  `{ ok: true, ... }` or `{ error: 'message' }`. A missing or malformed payload is treated as `{}`
  and never crashes the server.
- **Roles are never broadcast to the room.** Each player gets their own `state` snapshot that only
  shows what they may know (their own role, Mafia teammates if they are Mafia, the dead, and
  everything once the game is over). `your_role` and `investigation_result` go to one socket only.

## Client → server

| Event | Payload | Ack | Who / when |
| --- | --- | --- | --- |
| `create_room` | `{ playerId, name, bots?, roles?, authToken? }` | `{ ok, code }` | Anyone. `bots` fills seats (max 11). |
| `join_room` | `{ code, playerId, name, roles?, authToken? }` | `{ ok, code }` or `{ error: 'NAME_REQUIRED' \| ... }` | Lobby only for new players; reconnects work any time. |
| `rejoin_room` | same as `join_room` | same | Sent automatically after a reconnect. |
| `leave_room` | – | `{ ok }` | Leaves the table. Mid-game the seat stays (autopilot) for reconnects. |
| `start_game` | – | `{ ok }` / `{ error }` | Host only, at least 5 players, in the lobby. |
| `play_again` | – | `{ ok }` | Host only, after game over. Back to the lobby. |
| `night_action` | `{ targetId }` | `{ ok }` / `{ error }` | Living Mafia (kill), Doctor (save), Detective (check), Thief (steal, night 1). |
| `cast_vote` | `{ targetId \| 'SKIP' }` | `{ ok }` / `{ error }` | Living players, voting phase only, not for yourself. |
| `ready_vote` | `{ ready }` | `{ ok }` | Living players in discussion. A majority of living humans starts the vote. |
| `chat_message` | `{ text, channel?: 'mafia' }` | `{ ok }` / `{ error }` | The channel follows the phase (public by day, Mafia at night, ghosts for the dead). |
| `whisper` | `{ targetId, text }` | `{ ok, whispersLeft }` | Living players, discussion and voting, limited per game. |
| `add_bots` | `{ count }` | `{ ok }` | Host, lobby. |
| `remove_bots` | – | `{ ok }` | Host, lobby. |
| `voice_join` / `voice_leave` / `voice_mute` | `{ muted }` for mute | `{ ok, ... }` | See VOICE.md. |
| `voice_signal` | `{ to, toSession, data }` | – | WebRTC offer/answer/ICE, relayed to one player. |

`roles` lists the extra roles the client can display (`['JESTER', 'THIEF']`); the server only
deals an extra role if every human at the table can show it.
`authToken` is the signed-in player's game token (Google login, see below); without it the player
is a guest.

## Server → client

| Event | Payload | Sent to |
| --- | --- | --- |
| `state` | The room as this player may see it (`view.js` → `stateFor`) | Each player, after every change |
| `room_update` | `[{ id, name, connected }]` | The whole room (no roles) |
| `phase_change` | `{ phase, endsAt }` | The whole room |
| `your_role` | `{ role, team }` | One player: at the deal, and again if the Thief takes or swaps their role |
| `investigation_result` | `{ targetId, isMafia }` | The Detective only |
| `chat_message` | `{ id, channel, from, name, text, ts }` | Only players allowed to read that channel |
| `game_over` | `{ winner, roles }` | The whole room (roles are public once the game ends) |
| `voice_signal` | `{ from, fromSession, data, at }` | One player in voice |

## HTTP

| Route | What |
| --- | --- |
| `GET /health` | `{ ok, rooms, accounts }` (`accounts`: the stats database is connected) |
| `POST /feedback`, `GET /feedback` | Player feedback (the list needs `FEEDBACK_TOKEN`) |
| `GET /stats/me` | Saved stats of the signed-in player. Header `Authorization: Bearer <game token>`. 503 when no database is set up. |

## Accounts (Google login + saved stats)

1. The frontend signs the player in with Google (Auth.js / NextAuth).
2. Its `/api/game-token` route gives the browser a short-lived token (HS256, signed with
   `GAME_TOKEN_SECRET`, which is the same value on Vercel and Render).
3. The browser sends it as `authToken` with `create_room` / `join_room`. The server checks it
   (`auth.js`) and remembers which Google account each seat belongs to. It is never shown to others.
4. At game over the server saves each signed-in player's win or loss to MongoDB (`stats.js`).
   Guests are not saved; their browser keeps its own stats as before.
