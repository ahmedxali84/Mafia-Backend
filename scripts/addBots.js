const { io } = require("socket.io-client");

// Usage: npm run bots -- <ROOM_CODE> [SERVER_URL]
// Jo room code aapke browser par show ho raha hai wo yahan dein, e.g. `npm run bots -- ABCD`
const ROOM_CODE = (process.argv[2] || process.env.ROOM_CODE || "").toUpperCase();
const SERVER_URL = process.argv[3] || process.env.SERVER_URL || "http://localhost:4000";
if (!ROOM_CODE) {
  console.error("Room code dein: npm run bots -- ABCD");
  process.exit(1);
}

console.log(`Connecting 5 bots to room: ${ROOM_CODE}...`);

for (let i = 1; i <= 5; i++) {
  const socket = io(SERVER_URL);

  socket.on("connect", () => {
    socket.emit("join_room", {
      code: ROOM_CODE,
      name: `Bot_${i}`,
      playerId: `bot_${i}_${Date.now()}`
    });
    console.log(`Bot_${i} joined successfully!`);
  });

  socket.on("connect_error", (err) => {
    console.error(`Bot_${i} connection error:`, err.message);
  });
}