const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const rooms = new Map();

io.on("connection", (socket) => {
  socket.on("set-identity", (user) => { socket.user = user; });

  socket.on("create-room", ({ controlMode, syncUrl, user }, callback) => {
    socket.user = user;
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const msg1 = { id: Date.now(), system: true, text: `${user.name} created the room 🎉` };
    const msg2 = { id: Date.now() + 1, system: true, isLink: true, url: syncUrl, text: `📌 Syncing: ${syncUrl}` };
    rooms.set(roomId, {
      hostId: socket.id,
      controlMode: controlMode || "everyone",
      syncUrl,
      members: new Map([[socket.id, user]]),
      messages: [msg1, msg2],
      membersInAd: new Set(),
      // track playback state for rejoin sync
      playback: { currentTime: 0, paused: true, updatedAt: Date.now() },
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

    // calculate current playback position accounting for elapsed time
    const pb = room.playback;
    let currentTime = pb.currentTime;
    if (!pb.paused) {
      // add elapsed seconds since last update
      currentTime += (Date.now() - pb.updatedAt) / 1000;
    }

    callback({
      roomId, isHost: false, controlMode: room.controlMode,
      syncUrl: room.syncUrl, history: room.messages.slice(0, -1),
      // send current playback so joiner can seek immediately
      playback: { currentTime, paused: pb.paused },
    });
    socket.to(roomId).emit("member-joined", { user, memberCount: room.members.size });
    io.to(roomId).emit("chat-message", joinMsg);
  });

  socket.on("sync-event", (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.controlMode === "host-only" && socket.id !== room.hostId) return;

    // update server-side playback state
    room.playback = { currentTime: data.currentTime, paused: data.paused, updatedAt: Date.now() };

    socket.to(socket.roomId).emit("sync-event", data);

    const u = socket.user?.name || "Someone";
    const t = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
    const texts = {
      play: `▶ ${u} played`,
      pause: `⏸ ${u} paused`,
      seek: `⏩ ${u} skipped to ${t(data.currentTime)}`,
    };
    if (texts[data.type]) {
      const msg = { id: Date.now(), system: true, text: texts[data.type] };
      room.messages.push(msg);
      io.to(socket.roomId).emit("chat-message", msg);
    }
  });

  // heartbeat — clients send this every 5s so server knows current time
  socket.on("playback-heartbeat", (data) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.controlMode === "host-only" && socket.id !== room.hostId) return;
    room.playback = { currentTime: data.currentTime, paused: data.paused, updatedAt: Date.now() };
  });

  // request current playback state (for rejoin / buffer catchup)
  socket.on("request-sync", (_, callback) => {
    const room = rooms.get(socket.roomId);
    if (!room) return callback(null);
    const pb = room.playback;
    let currentTime = pb.currentTime;
    if (!pb.paused) currentTime += (Date.now() - pb.updatedAt) / 1000;
    callback({ currentTime, paused: pb.paused });
  });

  socket.on("force-sync-notify", () => {
    const room = rooms.get(socket.roomId);
    if (!room || !socket.user) return;
    
    let text = `${socket.user.name} used sync 🔄`;
    if (room.membersInAd?.size > 0) {
      text += ` (Paused since someone is in an ad 📺)`;
    }
    
    const msg = { id: Date.now(), system: true, text };
    room.messages.push(msg);
    io.to(socket.roomId).emit("chat-message", msg);
  });

  socket.on("url-change", ({ url }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.controlMode === "host-only" && socket.id !== room.hostId) return;
    
    room.syncUrl = url;
    const msg = { id: Date.now(), system: true, isLink: true, url, text: `📌 Now Syncing: ${url}` };
    room.messages.push(msg);
    io.to(socket.roomId).emit("chat-message", msg);
    socket.to(socket.roomId).emit("sync-event", { type: "nav", url });
  });

  socket.on("ad-status", ({ playing }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !socket.user) return;
    
    if (playing) {
      room.membersInAd.add(socket.id);
      if (room.membersInAd.size === 1) {
        socket.to(socket.roomId).emit("sync-event", { type: "pause" });
        room.playback = { ...room.playback, paused: true, updatedAt: Date.now() };
      }
      const msg = { id: Date.now(), system: true, text: `📺 ${socket.user.name} got an ad, pausing video...` };
      room.messages.push(msg);
      io.to(socket.roomId).emit("chat-message", msg);
    } else {
      room.membersInAd.delete(socket.id);
      const msg = { id: Date.now(), system: true, text: `▶️ ${socket.user.name}'s ad finished!` };
      room.messages.push(msg);
      io.to(socket.roomId).emit("chat-message", msg);
      
      if (room.membersInAd.size === 0) {
        socket.to(socket.roomId).emit("sync-event", { type: "play" });
        socket.to(socket.roomId).emit("sync-event", { type: "seek", currentTime: room.playback.currentTime });
        room.playback = { ...room.playback, paused: false, updatedAt: Date.now() };
      }
    }
  });

  socket.on("chat-message", ({ text }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !text?.trim()) return;
    const msg = { id: Date.now(), system: false, sender: socket.user, text: text.trim() };
    room.messages.push(msg);
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
    
    if (room.membersInAd?.has(socket.id)) {
      room.membersInAd.delete(socket.id);
      if (room.membersInAd.size === 0 && room.members.size > 0) {
        socket.to(socket.roomId).emit("sync-event", { type: "play" });
        socket.to(socket.roomId).emit("sync-event", { type: "seek", currentTime: room.playback.currentTime });
        room.playback = { ...room.playback, paused: false, updatedAt: Date.now() };
      }
    }
    
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

server.listen(process.env.PORT || 3000, () => console.log("🔥 Server running"));