let users = {};
let registeredUsers = {};
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

//  NEW: dynamic port (Render ke liye)
const PORT = process.env.PORT || 3000;

io.on("connection", (socket) => {

  // Helper: user list deduplicated by username, online true if any active socket
function getUniqueUserList() {
  const unique = {};
  Object.values(users).forEach((user) => {
    if (!unique[user.name]) {
      unique[user.name] = { name: user.name, online: user.online };
    } else if (user.online) {
      unique[user.name].online = true;
    }
  });
  return Object.values(unique);
}

  // USER JOIN

socket.on("authenticate", (username) => {
  socket.username = username;
  
  // Add to users list if not already there
  if (!users[socket.id]) {
    users[socket.id] = {
      name: username,
      online: true
    };
  }

  // Broadcast updated user list
  io.emit("userList", getUniqueUserList());

  console.log("User authenticated:", username);
});

socket.on("register", ({ username, password }) => {

  if(registeredUsers[username]){
    socket.emit("registerError", "User already exists");
    return;
  }

  registeredUsers[username] = password;

  socket.emit("registerSuccess", "Registered successfully");
});


socket.on("login", ({ username, password }) => {

  if(registeredUsers[username] === password){
    socket.username = username;

    users[socket.id] = {
      name: username,
      online: true
    };

    socket.emit("loginSuccess", username);

    io.emit("userList", getUniqueUserList());
  } else {
    socket.emit("loginError", "Invalid credentials");
  }
});



socket.on("delivered", ({ roomId, id }) => {
  socket.to(roomId).emit("delivered", id);
});

socket.on("seen", ({ roomId, id }) => {
  socket.to(roomId).emit("seen", id);
});

// Call signaling
socket.on("callOffer", (data) => {
  socket.to(data.to).emit("incomingCall", {
    from: data.from,
    type: data.type
  });
});

socket.on("callAnswer", (data) => {
  socket.to(data.to).emit("callAnswer", data);
});

socket.on("iceCandidate", (data) => {
  socket.to(data.to).emit("iceCandidate", data);
});

socket.on("endCall", (data) => {
  socket.to(data.to).emit("callEnded");
});

  // JOIN ROOM
  socket.on("joinRoom", (roomId) => {
    socket.join(roomId);
    console.log(socket.username + " joined room: " + roomId);
  });

  //  TYPING START
socket.on("typing", (roomId) => {
  socket.to(roomId).emit("typing", socket.username);
});

//  TYPING STOP
socket.on("stopTyping", (roomId) => {
  socket.to(roomId).emit("stopTyping");
});

  //  CHAT MESSAGE
 socket.on("chat message", async ({ msg, roomId, id }) => {

    if (!msg || msg.trim() === "") return;

    try {
      const translated = await translateMessage(msg);

      io.to(roomId).emit("chat message", {
        user: socket.username || "Anonymous",
        original: msg,
        translated: translated || msg,
        suggestion: "AI disabled",
        id: id
      });

    } catch (error) {
      console.error("Chat Error:", error.message);

      socket.emit("chat message", {
        user: socket.username || "Anonymous",
        original: msg,
        translated: "Error occurred",
        suggestion: "Try again"
      });
    }
  });

  // USER DISCONNECT
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // Remove disconnected socket
    if (users[socket.id]) {
      delete users[socket.id];
    }

    io.emit("userList", getUniqueUserList());
  });
});

// Translation function
async function translateMessage(text) {
  try {
    const res = await axios.post(
      "https://libretranslate.de/translate",
      {
        
        q: text,
        source: "auto",
        target: "en",
        format: "text"

      }
    );

    return res.data.translatedText || text;

  } catch (err) {

    console.error("Translation API Error:", err.message);
    return text;

  }
}

app.use(cors());
app.use(express.static("public"));

// UPDATED (IMPORTANT)
server.listen(PORT, () => {
  console.log("Server running on port " + PORT + " 🚀");

});