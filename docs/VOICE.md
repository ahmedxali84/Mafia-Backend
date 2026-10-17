# In-game voice chat

Players at the same table can talk in real time, like squad voice in PUBG.

## Concept: WebRTC mesh + Socket.IO signaling

- **Audio never touches our server.** Every pair of players in voice opens a direct
  `RTCPeerConnection` (Opus audio, echo cancellation + noise suppression from the browser).
- **The Socket.IO server is only the switchboard** ("signaling"): it relays the SDP offer/answer
  and ICE candidates between two players of the same room (`voice_signal`).
- **Mesh** (everyone ↔ everyone) is fine for a Mafia table: max 12 players, so at most 11
  connections × ~30 kbit/s per player. No media server (SFU) to deploy or pay for.
- STUN (Google) is used by default. Players behind strict NATs need a TURN relay: set
  `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` on the server (sent to clients on join).

## Who hears whom (server-authoritative)

Voice follows **exactly the same rules as text chat** (`server/view.js`):
a listener hears a speaker iff the listener could read a chat message the speaker writes right now.

| Phase | Alive Mafia | Alive Town | Dead |
|---|---|---|---|
| Lobby / Game over | everyone | everyone | everyone |
| Role reveal | nobody | nobody | nobody |
| Night | Mafia only | nobody (silent) | ghosts only |
| Day phases | everyone | everyone | ghosts only |

The server puts `you.voice = { channel, sendTo, hearFrom }` into every personal `state`.
Each client only feeds its microphone to the peers in `sendTo`
(`RTCRtpSender.replaceTrack(track | null)` — no renegotiation on phase changes) and mutes
audio from anyone not in `hearFrom`. Because the **speaker's own client** gates what it sends,
a modified client cannot eavesdrop on Mafia at night: honest Mafia clients never send it audio.

## Signaling protocol

| Event (client → server) | Payload | Notes |
|---|---|---|
| `voice_join` | – | after mic permission; ack `{ session, iceServers }` |
| `voice_leave` | – | also automatic on disconnect / leaving the room |
| `voice_mute` | `{ muted }` | shows a muted mic to others |
| `voice_signal` | `{ to, toSession, data }` | relayed as `{ from, fromSession, data }` |

- Each `voice_join` gets a fresh random `session`; a refresh = new session, so stale
  connections and stale signals are dropped on both sides.
- Glare-free negotiation: for each pair, the player with the **smaller id** sends the offer.
- The server only relays between two players of the same room who are both in voice with the
  expected session, caps the payload size and rate-limits per socket.

## Staying up mid-game

- **Reconnects / refresh:** the server drops a player's voice when their socket changes; the
  client notices (its session is missing from a state newer than its join) and rejoins by itself.
- **Old tabs** can't touch voice: `voice_*` events are ignored unless they come from the player's
  current socket.
- **Stale states:** every relayed signal carries the server time `at`; a peer is only closed by a
  room state that is newer than the connection, so a late state can't kill a fresh call.
- **Rebuilt calls:** each offer carries a `pcId`; a new id replaces the old connection, the same id
  is an ICE restart. Answers/candidates for an unknown `pcId` are ignored.
- **Watchdog:** a connection that is not `connected` for 15 s is torn down and re-offered.
- **Double joins** (auto-rejoin + click) share one in-flight start; leaving during the mic prompt
  cancels it. Push-to-talk is released whenever your channel changes (e.g. night falls).
- Malformed payloads are ignored; signaling is capped at 16 KB/message and 300 messages/s.

## Controls (client)

- Join/leave voice (choice remembered per browser), microphone permission errors shown.
- **Push-to-talk** (hold `T` or the on-screen button) or **open mic**.
- Mute mic, deafen (mute everyone), per-player mute + volume.
- Speaking indicators (Web Audio level meter) on the player list, mic-off icons,
  and a label saying who can hear you right now (Everyone / Mafia only / Ghosts only / Nobody).

## Files

- `server/view.js` – `voiceFor()` routing rules, voice info in `stateFor()`
- `server/index.js` – `voice_*` events
- `client/lib/voice.js` – `VoiceManager` (mic, peer connections, levels)
- `client/lib/useVoice.js` – React hook tying the manager to room state
- `client/components/VoicePanel.js` – controls, roster, push-to-talk button
- `server/test/voice.test.js`, `server/test/voice.e2e.test.js`
