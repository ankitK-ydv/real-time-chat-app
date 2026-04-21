let users = {};
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cors = require("cors");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const bcrypt = require("bcryptjs");
require("dotenv").config();

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
const PRIMARY_MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/realtime_chat";
const LOCAL_MONGODB_URI = process.env.LOCAL_MONGODB_URI || "mongodb://127.0.0.1:27017/realtime_chat";
const ALLOW_LOCAL_MONGODB_FALLBACK = String(process.env.ALLOW_LOCAL_MONGODB_FALLBACK || "true").toLowerCase() !== "false";
const ALLOW_IN_MEMORY_MONGODB_FALLBACK = String(process.env.ALLOW_IN_MEMORY_MONGODB_FALLBACK || "true").toLowerCase() !== "false";
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const MAX_AVATAR_SIZE = 1_000_000;
const DATA_IMAGE_REGEX = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i;
const DB_UNAVAILABLE_MESSAGE = "Database unavailable. Please try again in a moment.";
const MONGO_RETRY_INITIAL_MS = Number(process.env.MONGO_RETRY_INITIAL_MS || 5000);
const MONGO_RETRY_MAX_MS = Number(process.env.MONGO_RETRY_MAX_MS || 60000);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    avatar: { type: String, default: "" }
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);

const connectionSchema = new mongoose.Schema(
  {
    users: [{ type: String }],
    members: [{ type: String }],
    pairKey: { type: String },
    requestedBy: { type: String, required: true },
    status: { type: String, enum: ["pending", "accepted"], default: "pending" }
  },
  { timestamps: true }
);

connectionSchema.index({ members: 1, status: 1 });
connectionSchema.index(
  { pairKey: 1 },
  {
    unique: true,
    partialFilterExpression: { pairKey: { $type: "string" } }
  }
);

connectionSchema.pre("validate", function setConnectionPairKey() {
  const pairSource = Array.isArray(this.members) && this.members.length === 2 ? this.members : this.users;
  if (Array.isArray(pairSource) && pairSource.length === 2) {
    this.members = getPair(pairSource[0], pairSource[1]);
    this.pairKey = getPairKey(this.members[0], this.members[1]);
  }
});

const messageSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    participants: [{ type: String, required: true }],
    sender: { type: String, required: true },
    original: { type: String, required: true },
    translated: { type: String, default: "" },
    clientMessageId: { type: String, default: "" },
    readBy: [{ type: String }]
  },
  { timestamps: true }
);

const Connection = mongoose.model("Connection", connectionSchema);
const Message = mongoose.model("Message", messageSchema);

const postSchema = new mongoose.Schema(
  {
    author: { type: String, required: true, index: true },
    text: { type: String, default: "" },
    media: { type: String, default: "" },
    mediaType: { type: String, enum: ["none", "image", "video"], default: "none" },
    likes: { type: Number, default: 0 },
    likedBy: [{ type: String }],
    shares: { type: Number, default: 0 },
    sharedBy: [{ type: String }]
  },
  { timestamps: true }
);

const Post = mongoose.model("Post", postSchema);

function getPair(userA, userB) {
  return [userA, userB].sort();
}

function getPairKey(userA, userB) {
  return JSON.stringify(getPair(userA, userB));
}

function getConnectionPairFilter(userA, userB) {
  const usersPair = getPair(userA, userB);
  return {
    $or: [
      { pairKey: getPairKey(userA, userB) },
      { members: usersPair },
      { users: usersPair }
    ]
  };
}

function getConnectionMembers(connection) {
  if (Array.isArray(connection.members) && connection.members.length) return connection.members;
  if (Array.isArray(connection.users) && connection.users.length) return connection.users;
  return [];
}

function getPrivateRoomId(userA, userB) {
  return getPair(userA, userB).join("_");
}

async function getSyncState(username) {
  const memberFilter = { $or: [{ members: username }, { users: username }] };
  const accepted = await Connection.find({ ...memberFilter, status: "accepted" }).select("members users").lean();
  const incoming = await Connection.find({ ...memberFilter, status: "pending", requestedBy: { $ne: username } }).select("requestedBy").lean();
  const outgoing = await Connection.find({ ...memberFilter, status: "pending", requestedBy: username }).select("members users").lean();
  const unreadMessages = await Message.find({
    participants: username,
    sender: { $ne: username },
    readBy: { $ne: username }
  }).select("participants").lean();

  const unreadByUser = {};
  unreadMessages.forEach((msg) => {
    const otherUser = msg.participants.find((user) => user !== username);
    if (!otherUser) return;
    unreadByUser[otherUser] = (unreadByUser[otherUser] || 0) + 1;
  });

  return {
    connections: accepted.map((item) => getConnectionMembers(item).find((user) => user !== username)).filter(Boolean),
    incomingRequests: incoming.map((item) => item.requestedBy),
    outgoingRequests: outgoing.map((item) => getConnectionMembers(item).find((user) => user !== username)).filter(Boolean),
    unreadByUser
  };
}

function mapUserSummary(userDoc, currentUsername, syncState) {
  const otherUser = userDoc.username;
  return {
    username: otherUser,
    avatar: userDoc.avatar || "",
    online: Object.values(users).some((item) => item.name === otherUser),
    unreadCount: syncState.unreadByUser[otherUser] || 0,
    hasIncomingRequest: syncState.incomingRequests.includes(otherUser),
    hasOutgoingRequest: syncState.outgoingRequests.includes(otherUser),
    isConnected: syncState.connections.includes(otherUser),
    canMessage: syncState.connections.includes(otherUser)
  };
}

async function getHomeData(username) {
  const syncState = await getSyncState(username);
  const connections = await Promise.all(
    syncState.connections.map(async (friendUsername) => {
      const profile = await User.findOne({ username: friendUsername }).select("username avatar").lean();
      if (!profile) return null;

      const lastMessage = await Message.findOne({
        participants: { $all: [username, friendUsername] }
      })
        .sort({ createdAt: -1 })
        .select("sender original createdAt")
        .lean();

      const summary = mapUserSummary(profile, username, syncState);

      return {
        ...summary,
        lastMessagePreview: lastMessage
          ? `${lastMessage.sender === username ? "You" : friendUsername}: ${lastMessage.original}`
          : "No messages yet",
        lastMessageAt: lastMessage?.createdAt || null
      };
    })
  );

  const incomingRequests = await Promise.all(
    syncState.incomingRequests.map(async (requestUsername) => {
      const profile = await User.findOne({ username: requestUsername }).select("username avatar").lean();
      return profile
        ? {
            username: profile.username,
            avatar: profile.avatar || ""
          }
        : null;
    })
  );

  const outgoingRequests = await Promise.all(
    syncState.outgoingRequests.map(async (requestUsername) => {
      const profile = await User.findOne({ username: requestUsername }).select("username avatar").lean();
      return profile
        ? {
            username: profile.username,
            avatar: profile.avatar || ""
          }
        : null;
    })
  );

  const recentPosts = await Post.find({
    author: { $in: [username, ...syncState.connections] }
  })
    .sort({ createdAt: -1 })
    .limit(40)
    .lean();

  return {
    me: username,
    connections: connections.filter(Boolean),
    incomingRequests: incomingRequests.filter(Boolean),
    outgoingRequests: outgoingRequests.filter(Boolean),
    unreadByUser: syncState.unreadByUser,
    posts: recentPosts.map((post) => ({
      id: String(post._id),
      author: post.author,
      text: post.text || "",
      media: post.media || "",
      mediaType: post.mediaType || "none",
      likes: post.likes || 0,
      shares: post.shares || 0,
      createdAt: post.createdAt,
      likedByMe: false,
      sharedByMe: false
    }))
  };
}

async function emitSyncStateToUser(ioServer, username) {
  if (!username) return;

  const targets = Object.entries(users)
    .filter(([, user]) => user.name === username)
    .map(([socketId]) => socketId);

  if (targets.length === 0) return;

  const syncState = await getSyncState(username);
  targets.forEach((socketId) => {
    ioServer.to(socketId).emit("syncState", syncState);
  });
}

function getOnlineUsernames() {
  return Array.from(
    new Set(
      Object.values(users)
        .filter((user) => user && user.online && user.name)
        .map((user) => user.name)
    )
  );
}

function emitPresenceSnapshot(ioServer = io) {
  ioServer.emit("presenceSnapshot", getOnlineUsernames());
}

async function hasAcceptedConnection(userA, userB) {
  const existingConnection = await Connection.findOne({
    ...getConnectionPairFilter(userA, userB),
    status: "accepted"
  }).select("_id").lean();
  return !!existingConnection;
}

let mongoReconnectTimer = null;
let mongoReconnectAttempts = 0;
let activeMongoUri = PRIMARY_MONGODB_URI;
let localFallbackAttempted = false;
let inMemoryFallbackAttempted = false;
let inMemoryMongoServer = null;

function isAtlasConnectionIssue(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("whitelist") ||
    message.includes("server selection") ||
    message.includes("timed out") ||
    message.includes("could not connect to any servers")
  );
}

function isAtlasUri(uri) {
  return typeof uri === "string" && uri.startsWith("mongodb+srv://");
}

function getMongoRetryDelay() {
  const exponentialDelay = MONGO_RETRY_INITIAL_MS * Math.pow(2, mongoReconnectAttempts);
  return Math.min(exponentialDelay, MONGO_RETRY_MAX_MS);
}

async function connectInMemoryMongoDB(trigger = "in_memory_fallback") {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return true;
  }

  try {
    if (!inMemoryMongoServer) {
      inMemoryMongoServer = await MongoMemoryServer.create({
        instance: { dbName: "realtime_chat" }
      });
    }

    activeMongoUri = inMemoryMongoServer.getUri();
    await mongoose.connect(activeMongoUri, {
      serverSelectionTimeoutMS: 5000
    });

    mongoReconnectAttempts = 0;
    console.log(`MongoDB connected (${trigger}) using in-memory fallback URI`);
    return true;
  } catch (error) {
    console.error("In-memory MongoDB startup failed:", error.message);

    if (inMemoryMongoServer) {
      try {
        await inMemoryMongoServer.stop();
      } catch (stopError) {
        console.error("In-memory MongoDB shutdown failed:", stopError.message);
      }
      inMemoryMongoServer = null;
    }

    return false;
  }
}

function scheduleMongoReconnect(reason = "unknown") {
  if (mongoReconnectTimer || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  const delay = getMongoRetryDelay();
  mongoReconnectAttempts += 1;

  console.log(`MongoDB reconnect scheduled in ${delay}ms (${reason})`);

  mongoReconnectTimer = setTimeout(() => {
    mongoReconnectTimer = null;
    connectMongoDB("retry");
  }, delay);
}

async function connectMongoDB(trigger = "startup") {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  try {
    await mongoose.connect(activeMongoUri, {
      serverSelectionTimeoutMS: 5000
    });
    mongoReconnectAttempts = 0;
    console.log(`MongoDB connected (${trigger}) using ${isAtlasUri(activeMongoUri) ? "Atlas" : "local"} URI`);
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);

    if (
      ALLOW_LOCAL_MONGODB_FALLBACK &&
      !localFallbackAttempted &&
      activeMongoUri === PRIMARY_MONGODB_URI &&
      isAtlasUri(PRIMARY_MONGODB_URI) &&
      isAtlasConnectionIssue(error)
    ) {
      localFallbackAttempted = true;
      activeMongoUri = LOCAL_MONGODB_URI;
      console.log("MongoDB Atlas is unreachable. Falling back to local MongoDB.");
      scheduleMongoReconnect("local_fallback");
      return;
    }

    if (ALLOW_IN_MEMORY_MONGODB_FALLBACK && !inMemoryFallbackAttempted) {
      inMemoryFallbackAttempted = true;
      console.log("MongoDB Atlas/local are unreachable. Falling back to in-memory MongoDB.");

      const inMemoryConnected = await connectInMemoryMongoDB("in_memory_fallback");
      if (inMemoryConnected) {
        return;
      }
    }

    scheduleMongoReconnect(error.message || "connect_failed");
  }
}

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

async function ensureConnectionIndexes() {
  if (!isDatabaseReady()) return;

  try {
    await Connection.createCollection();
    const collection = Connection.collection;
    const indexes = await collection.indexes();
    const oldUniqueUsersIndex = indexes.find((index) => index.name === "users_1" && index.unique);

    if (oldUniqueUsersIndex) {
      await collection.dropIndex("users_1");
      console.log("Dropped old unique users_1 connection index");
    }

    const needsPairKey = await Connection.find({
      $or: [
        { pairKey: { $exists: false } },
        { pairKey: "" },
        { members: { $exists: false } },
        { members: { $size: 0 } }
      ]
    });

    for (const connection of needsPairKey) {
      const existingMembers = getConnectionMembers(connection);
      if (existingMembers.length !== 2) continue;
      connection.members = getPair(existingMembers[0], existingMembers[1]);
      connection.pairKey = getPairKey(connection.members[0], connection.members[1]);
      await connection.save();
    }

    await collection.createIndex({ members: 1, status: 1 }, { name: "members_1_status_1" });
    await collection.createIndex(
      { pairKey: 1 },
      {
        name: "pairKey_1",
        unique: true,
        partialFilterExpression: { pairKey: { $type: "string" } }
      }
    );
  } catch (error) {
    console.error("Connection index maintenance failed:", error.message);
  }
}

io.on("connection", (socket) => {

  // Helper: user list deduplicated by username, online true if any active socket
  function getUniqueUserList() {
    const unique = {};
    Object.values(users).forEach((user) => {
      if (!unique[user.name]) {
        unique[user.name] = {
          name: user.name,
          online: user.online,
          avatar: user.avatar || ""
        };
      } else if (user.online) {
        unique[user.name].online = true;
      }
    });
    return Object.values(unique);
  }

  async function getAllUserDirectory(currentUsername) {
    const profiles = await User.find().select("username avatar").sort({ username: 1 }).lean();
    const onlineNames = new Set(Object.values(users).filter((user) => user && user.online).map((user) => user.name));

    return profiles
      .filter((profile) => profile.username !== currentUsername)
      .map((profile) => ({
        name: profile.username,
        online: onlineNames.has(profile.username),
        avatar: profile.avatar || ""
      }));
  }

  // USER JOIN

socket.on("authenticate", async (username) => {
  const safeUsername = typeof username === "string" ? username.trim() : "";
  if (!safeUsername) return;

  if (!isDatabaseReady()) {
    socket.emit("loginError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  try {
    socket.username = safeUsername;
    socket.join(safeUsername);
    const profile = await User.findOne({ username: safeUsername }).select("avatar").lean();

    users[socket.id] = {
      name: safeUsername,
      online: true,
      avatar: profile?.avatar || ""
    };

    socket.emit("authenticated", safeUsername);

    // Broadcast updated user list
    io.emit("userList", getUniqueUserList());
    emitPresenceSnapshot(io);
    socket.emit("allUsers", await getAllUserDirectory(safeUsername));
    socket.emit("syncState", await getSyncState(safeUsername));

    console.log("User authenticated:", safeUsername);
  } catch (error) {
    console.error("Authenticate Error:", error.message);
    socket.emit("loginError", "Authentication failed. Please login again.");
  }
});

socket.on("register", async ({ username, password }) => {
  const safeUsername = typeof username === "string" ? username.trim() : "";
  const safePassword = typeof password === "string" ? password : "";

  if (!isDatabaseReady()) {
    socket.emit("registerError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  if (!safeUsername || !safePassword.trim()) {
    socket.emit("registerError", "Username and password are required");
    return;
  }

  if (safePassword.length < 6) {
    socket.emit("registerError", "Password must be at least 6 characters");
    return;
  }

  try {
    const existingUser = await User.findOne({ username: safeUsername }).select("_id").lean();
    if (existingUser) {
      socket.emit("registerError", "User already exists");
      return;
    }

    const hashedPassword = await bcrypt.hash(safePassword, BCRYPT_ROUNDS);

    await User.create({
      username: safeUsername,
      password: hashedPassword,
      avatar: ""
    });

    socket.emit("registerSuccess", "Registered successfully");
  } catch (error) {
    console.error("Register Error:", error.message);
    if (error && error.code === 11000) {
      socket.emit("registerError", "User already exists");
      return;
    }

    if (error && typeof error.message === "string" && error.message.toLowerCase().includes("whitelist")) {
      socket.emit("registerError", "MongoDB Atlas IP not whitelisted. Please allow your current IP in Atlas Network Access.");
      return;
    }

    socket.emit("registerError", "Registration failed. " + error.message);
  }
});


socket.on("login", async ({ username, password }) => {
  const safeUsername = typeof username === "string" ? username.trim() : "";
  const safePassword = typeof password === "string" ? password : "";

  if (!isDatabaseReady()) {
    socket.emit("loginError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  if (!safeUsername || !safePassword.trim()) {
    socket.emit("loginError", "Username and password are required");
    return;
  }

  try {
    const user = await User.findOne({ username: safeUsername })
      .select("username password")
      .lean();

    if (!user) {
      socket.emit("loginError", "Invalid credentials");
      return;
    }

    let isPasswordValid = false;

    if (user.password && user.password.startsWith("$2")) {
      isPasswordValid = await bcrypt.compare(safePassword, user.password);
    } else if (user.password === safePassword) {
      // One-time migration for previously stored plain-text passwords.
      isPasswordValid = true;
      const migratedHash = await bcrypt.hash(safePassword, BCRYPT_ROUNDS);
      await User.updateOne({ _id: user._id }, { $set: { password: migratedHash } });
    }

    if (isPasswordValid) {
      socket.emit("loginSuccess", user.username);
    } else {
      socket.emit("loginError", "Invalid credentials");
    }
  } catch (error) {
    console.error("Login Error:", error.message);
    socket.emit("loginError", "Login failed. Please try again.");
  }
});

socket.on("getProfile", async (targetUsername) => {
  const target = typeof targetUsername === "string" ? targetUsername.trim() : socket.username;
  if (!target) return;

  if (!isDatabaseReady()) {
    socket.emit("profileError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  try {
    const profile = await User.findOne({ username: target }).select("username avatar").lean();
    socket.emit("profileData", {
      username: target,
      avatar: profile?.avatar || ""
    });
  } catch (error) {
    console.error("Get Profile Error:", error.message);
    socket.emit("profileError", "Unable to fetch profile");
  }
});

socket.on("fetchSyncState", async () => {
  if (!socket.username || !isDatabaseReady()) return;

  try {
    socket.emit("syncState", await getSyncState(socket.username));
  } catch (error) {
    console.error("Fetch Sync Error:", error.message);
  }
});

socket.on("fetchAllUsers", async () => {
  if (!socket.username || !isDatabaseReady()) return;

  try {
    socket.emit("allUsers", await getAllUserDirectory(socket.username));
  } catch (error) {
    console.error("Fetch All Users Error:", error.message);
  }
});

socket.on("sendConnectionRequest", async ({ to }) => {
  if (!socket.username) {
    socket.emit("connectionError", "Please login again");
    return;
  }

  if (!isDatabaseReady()) {
    socket.emit("connectionError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  const toUser = typeof to === "string" ? to.trim() : "";
  if (!toUser || toUser === socket.username) {
    socket.emit("connectionError", "Invalid user");
    return;
  }

  try {
    const targetExists = await User.findOne({ username: toUser }).select("_id").lean();
    if (!targetExists) {
      socket.emit("connectionError", "User not found");
      return;
    }

    const usersPair = getPair(socket.username, toUser);
    const pairKey = getPairKey(socket.username, toUser);
    const existingConnection = await Connection.findOne(getConnectionPairFilter(socket.username, toUser)).lean();

    if (existingConnection?.status === "accepted") {
      socket.emit("connectionError", "Already connected");
      return;
    }

    if (existingConnection?.status === "pending") {
      socket.emit("connectionError", "Request already pending");
      return;
    }

    await Connection.create({
      users: [pairKey],
      members: usersPair,
      pairKey,
      requestedBy: socket.username,
      status: "pending"
    });

    await emitSyncStateToUser(io, socket.username);
    await emitSyncStateToUser(io, toUser);
  } catch (error) {
    console.error("Send Connection Request Error:", error.message);
    socket.emit("connectionError", "Failed to send request");
  }
});

socket.on("respondConnectionRequest", async ({ from, action }) => {
  if (!socket.username) {
    socket.emit("connectionError", "Please login again");
    return;
  }

  if (!isDatabaseReady()) {
    socket.emit("connectionError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  const fromUser = typeof from === "string" ? from.trim() : "";
  const safeAction = action === "accept" ? "accept" : "reject";
  if (!fromUser || fromUser === socket.username) {
    socket.emit("connectionError", "Invalid request");
    return;
  }

  try {
    const request = await Connection.findOne({
      ...getConnectionPairFilter(socket.username, fromUser),
      status: "pending",
      requestedBy: fromUser
    });

    if (!request) {
      socket.emit("connectionError", "Request not found");
      return;
    }

    if (safeAction === "accept") {
      request.status = "accepted";
      await request.save();
    } else {
      await Connection.deleteOne({ _id: request._id });
    }

    await emitSyncStateToUser(io, socket.username);
    await emitSyncStateToUser(io, fromUser);
  } catch (error) {
    console.error("Respond Connection Request Error:", error.message);
    socket.emit("connectionError", "Failed to update request");
  }
});

socket.on("joinConversation", async ({ otherUser }) => {
  if (!socket.username) {
    socket.emit("conversationError", "Please login again");
    return;
  }

  if (!isDatabaseReady()) {
    socket.emit("conversationError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  const targetUser = typeof otherUser === "string" ? otherUser.trim() : "";
  if (!targetUser || targetUser === socket.username) {
    socket.emit("conversationError", "Invalid user");
    return;
  }

  try {
    const allowed = await hasAcceptedConnection(socket.username, targetUser);
    if (!allowed) {
      socket.emit("conversationError", "Connect request not accepted yet");
      return;
    }

    const roomId = getPrivateRoomId(socket.username, targetUser);
    socket.join(roomId);

    const history = await Message.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(300)
      .lean();

    socket.emit("conversationHistory", {
      otherUser: targetUser,
      roomId,
      messages: history.map((item) => ({
        id: String(item._id),
        user: item.sender,
        original: item.original,
        translated: item.translated,
        createdAt: item.createdAt,
        readBy: item.readBy || []
      }))
    });
  } catch (error) {
    console.error("Join Conversation Error:", error.message);
    socket.emit("conversationError", "Unable to open conversation");
  }
});

socket.on("markConversationRead", async ({ otherUser }) => {
  if (!socket.username || !isDatabaseReady()) return;

  const targetUser = typeof otherUser === "string" ? otherUser.trim() : "";
  if (!targetUser || targetUser === socket.username) return;

  try {
    const roomId = getPrivateRoomId(socket.username, targetUser);
    const unreadMessages = await Message.find({
      roomId,
      sender: targetUser,
      readBy: { $ne: socket.username }
    }).select("_id").lean();

    const seenIds = unreadMessages.map((item) => String(item._id));

    if (seenIds.length) {
      await Message.updateMany(
        {
          _id: { $in: seenIds },
          readBy: { $ne: socket.username }
        },
        {
          $addToSet: { readBy: socket.username }
        }
      );

      io.to(targetUser).emit("seen", {
        ids: seenIds,
        by: socket.username
      });
    }

    await emitSyncStateToUser(io, socket.username);
  } catch (error) {
    console.error("Mark Conversation Read Error:", error.message);
  }
});

socket.on("updateProfile", async ({ avatar }) => {
  if (!socket.username) {
    socket.emit("profileError", "Please login again");
    return;
  }

  if (!isDatabaseReady()) {
    socket.emit("profileError", DB_UNAVAILABLE_MESSAGE);
    return;
  }

  const safeAvatar = typeof avatar === "string" ? avatar.trim() : "";

  if (safeAvatar && safeAvatar.length > MAX_AVATAR_SIZE) {
    socket.emit("profileError", "Image is too large. Please use a smaller image.");
    return;
  }

  if (safeAvatar && !DATA_IMAGE_REGEX.test(safeAvatar)) {
    socket.emit("profileError", "Invalid image format. Please upload a valid image.");
    return;
  }

  try {
    const updatedUser = await User.findOneAndUpdate(
      { username: socket.username },
      { $set: { avatar: safeAvatar } },
      { new: true, projection: { username: 1, avatar: 1 } }
    ).lean();

    if (!updatedUser) {
      socket.emit("profileError", "User not found");
      return;
    }

    Object.keys(users).forEach((socketId) => {
      if (users[socketId].name === socket.username) {
        users[socketId].avatar = safeAvatar;
      }
    });

    socket.emit("profileUpdated", {
      username: updatedUser.username,
      avatar: updatedUser.avatar || ""
    });

    io.emit("userList", getUniqueUserList());
    emitPresenceSnapshot(io);
  } catch (error) {
    console.error("Update Profile Error:", error.message);
    socket.emit("profileError", "Failed to update profile");
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
  console.log("Call offer from", data.from, "to", data.to, "with SDP:", !!data.sdp);
  if (!data || !data.to) return;

  // Send both incomingCall notification and the actual offer with SDP
  io.to(data.to).emit("incomingCall", {
    from: data.from,
    type: data.type
  });

  // Send the offer with SDP separately
  io.to(data.to).emit("callOffer", {
    from: data.from,
    type: data.type,
    sdp: data.sdp
  });
});

socket.on("callAccepted", (data) => {
  if (!data || !data.to) return;
  console.log("Call accepted by", data.from);
  io.to(data.to).emit("callAccepted", data);
});

socket.on("callRejected", (data) => {
  if (!data || !data.to) return;
  console.log("Call rejected by", data.from);
  io.to(data.to).emit("callRejected", data);
});

socket.on("callAnswer", (data) => {
  if (!data || !data.to) return;
  console.log("Call answer from", data.from, "to", data.to);
  io.to(data.to).emit("callAnswer", data);
});

socket.on("iceCandidate", (data) => {
  if (!data || !data.to) return;
  io.to(data.to).emit("iceCandidate", data);
});

socket.on("endCall", (data) => {
  if (!data || !data.to) return;
  console.log("Call ended by", socket.username);
  io.to(data.to).emit("callEnded", {
    from: data.from || socket.username,
    type: data.type || "voice",
    reason: data.reason || "ended"
  });
});

socket.on("missedCall", (data) => {
  if (!data || !data.to) return;

  io.to(data.to).emit("missedCall", {
    from: data.from || socket.username,
    type: data.type || "voice",
    at: Date.now()
  });
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
 socket.on("chat message", async ({ msg, roomId, id, to }) => {

    if (!socket.username) return;

    if (!msg || msg.trim() === "") return;

    const targetUser = typeof to === "string" ? to.trim() : "";
    if (!targetUser || targetUser === socket.username) return;

    try {
      const allowed = await hasAcceptedConnection(socket.username, targetUser);
      if (!allowed) {
        socket.emit("conversationError", "Connect request not accepted yet");
        return;
      }

      const finalRoomId = getPrivateRoomId(socket.username, targetUser);
      const translated = await translateMessage(msg);
      const saved = await Message.create({
        roomId: finalRoomId,
        participants: getPair(socket.username, targetUser),
        sender: socket.username,
        original: msg,
        translated: translated || msg,
        clientMessageId: String(id || ""),
        readBy: [socket.username]
      });

      io.to(finalRoomId).to(targetUser).to(socket.username).emit("chat message", {
        user: socket.username || "Anonymous",
        original: msg,
        translated: translated || msg,
        suggestion: "AI disabled",
        id: String(saved._id),
        createdAt: saved.createdAt,
        readBy: saved.readBy || [socket.username]
      });

      await emitSyncStateToUser(io, targetUser);
      await emitSyncStateToUser(io, socket.username);

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

  socket.on("fetchHomeData", async () => {
    if (!socket.username || !isDatabaseReady()) {
      socket.emit("homeError", DB_UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      socket.emit("homeData", await getHomeData(socket.username));
    } catch (error) {
      console.error("Fetch Home Data Error:", error.message);
      socket.emit("homeError", "Unable to load home data");
    }
  });

  socket.on("createPost", async ({ text, media, mediaType }) => {
    if (!socket.username) {
      socket.emit("homeError", "Please login again");
      return;
    }

    if (!isDatabaseReady()) {
      socket.emit("homeError", DB_UNAVAILABLE_MESSAGE);
      return;
    }

    const safeText = typeof text === "string" ? text.trim() : "";
    const safeMedia = typeof media === "string" ? media.trim() : "";
    const safeMediaType = ["image", "video", "none"].includes(mediaType) ? mediaType : "none";

    if (!safeText && !safeMedia) {
      socket.emit("homeError", "Post text or media is required");
      return;
    }

    if (safeMedia && safeMedia.length > 6_000_000) {
      socket.emit("homeError", "Media is too large");
      return;
    }

    try {
      const post = await Post.create({
        author: socket.username,
        text: safeText,
        media: safeMedia,
        mediaType: safeMediaType
      });

      io.emit("newPost", {
        id: String(post._id),
        author: post.author,
        text: post.text || "",
        media: post.media || "",
        mediaType: post.mediaType || "none",
        likes: post.likes || 0,
        shares: post.shares || 0,
        createdAt: post.createdAt,
        likedByMe: false,
        sharedByMe: false
      });
    } catch (error) {
      console.error("Create Post Error:", error.message);
      socket.emit("homeError", "Failed to create post");
    }
  });

  socket.on("toggleLikePost", async ({ postId }) => {
    if (!socket.username || !isDatabaseReady()) return;

    try {
      const post = await Post.findById(postId);
      if (!post) return;

      const likedIndex = post.likedBy.indexOf(socket.username);
      if (likedIndex >= 0) {
        post.likedBy.splice(likedIndex, 1);
        post.likes = Math.max(0, post.likes - 1);
      } else {
        post.likedBy.push(socket.username);
        post.likes += 1;
      }

      await post.save();

      io.emit("postUpdated", {
        id: String(post._id),
        likes: post.likes,
        shares: post.shares,
        likedBy: post.likedBy
      });
    } catch (error) {
      console.error("Toggle Like Error:", error.message);
    }
  });

  socket.on("sharePost", async ({ postId }) => {
    if (!socket.username || !isDatabaseReady()) return;

    try {
      const post = await Post.findById(postId);
      if (!post) return;

      if (!post.sharedBy.includes(socket.username)) {
        post.sharedBy.push(socket.username);
        post.shares += 1;
        await post.save();
      }

      io.emit("postUpdated", {
        id: String(post._id),
        likes: post.likes,
        shares: post.shares,
        likedBy: post.likedBy
      });
    } catch (error) {
      console.error("Share Post Error:", error.message);
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
    emitPresenceSnapshot(io);
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

mongoose.connection.on("connected", () => {
  mongoReconnectAttempts = 0;
  if (mongoReconnectTimer) {
    clearTimeout(mongoReconnectTimer);
    mongoReconnectTimer = null;
  }
  console.log("MongoDB status: connected");
  ensureConnectionIndexes();
});

mongoose.connection.on("disconnected", () => {
  console.log("MongoDB status: disconnected");
  scheduleMongoReconnect("disconnected");
});

connectMongoDB();

server.listen(PORT, () => {
  console.log("Server running on port " + PORT + " 🚀");
});
