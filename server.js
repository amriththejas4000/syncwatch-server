const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const rooms = new Map();

const avatarColors = ["#7c6dfa","#fa6d9a","#4dfa9a","#faa04d","#4db8fa","#fa4d4d","#c44dfa","#4dfae0"];

io.on("connection", (socket) => {
  // user identity comes from client (stored locally)
  socket.on("set-identity", (user) => { socket.user = user; });

  socket.on("create-room", ({ controlMode, syncUrl, user }, callback) => {
    socket.user = user;
    const roomId = Math.random().toString(36).substring(2,8).toUpperCase();
    const msg1 = { id: Date.now(), system: true, text: `${user.name} created the room 🎉` };
    const msg2 = { id: Date.now()+1, system: true, isLink: true, url: syncUrl, text: `📌 Syncing: ${syncUrl}` };
    rooms.set(roomId, {
      hostId: socket.id,
      controlMode: controlMode || "everyone",
      syncUrl,
      members: new Map([[socket.id, user]]),
      messages: [msg1, msg2],
    });
    socket.join(roomId);
    socket.roomId = roomId;
    callback({ roomId, isHost: true });
    io.to(roomId).emit("chat-message", msg1);
    io.to(roomId).emit("chat-message", msg2);
  });

  socket.on("join-room", ({ roomId, user }, callback) => {
    socket.user = user;
    const room = rooms.get(roomId);
    if (!room) return callback({ error: "Room not found" });
    room.members.set(socket.id, user);
    socket.join(roomId);
    socket.roomId = roomId;
    const joinMsg = { id: Date.now(), system: true, text: `${user.name} joined 👋` };
    room.messages.push(joinMsg);
    callback({ roomId, isHost: false, controlMode: room.controlMode, syncUrl: room.syncUrl, history: room.messages.slice(0,-1) });
    socket.to(roomId).emit("member-joined", { user, memberCount: room.members.size });
    io.to(roomId).emit("chat-message", joinMsg);
  });

  socket.on("sync-event", (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.controlMode === "host-only" && socket.id !== room.hostId) return;
    socket.to(socket.roomId).emit("sync-event", data);
    const u = socket.user?.name || "Someone";
    const t = s => `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
    const texts = { play:`▶ ${u} played`, pause:`⏸ ${u} paused`, seek:`⏩ ${u} skipped to ${t(data.currentTime)}`, "ad-start":`📺 ${u} got an ad — everyone paused`, "ad-end":`✅ ${u}'s ad ended — resuming` };
    if (texts[data.type]) {
      const msg = { id: Date.now(), system: true, text: texts[data.type] };
      room.messages.push(msg);
      io.to(socket.roomId).emit("chat-message", msg);
    }
  });

  socket.on("chat-message", ({ text }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !text?.trim()) return;
    const msg = { id: Date.now(), system: false, sender: socket.user, text: text.trim() };
    room.messages.push(msg);
    // send to everyone INCLUDING sender (single source of truth)
    io.to(socket.roomId).emit("chat-message", msg);
  });

  socket.on("typing-start", () => {
    const room = rooms.get(socket.roomId);
    if (!room || !socket.user) return;
    socket.to(socket.roomId).emit("typing-start", { name: socket.user.name, color: socket.user.color });
  });

  socket.on("typing-stop", () => {
    const room = rooms.get(socket.roomId);
    if (!room || !socket.user) return;
    socket.to(socket.roomId).emit("typing-stop", { name: socket.user.name });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.members.delete(socket.id);
    if (room.members.size === 0) { rooms.delete(socket.roomId); return; }
    if (room.hostId === socket.id) {
      room.hostId = [...room.members.keys()][0];
      io.to(room.hostId).emit("promoted-to-host");
    }
    const msg = { id: Date.now(), system: true, text: `${socket.user?.name || "Someone"} left` };
    room.messages.push(msg);
    io.to(socket.roomId).emit("member-left", { user: socket.user, memberCount: room.members.size });
    io.to(socket.roomId).emit("chat-message", msg);
  });
});

server.listen(process.env.PORT||3000, () => console.log("🔥 Server on http://localhost:3000"));