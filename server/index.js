import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import multer from "multer";
import { Server } from "socket.io";
import {
  initDb,
  createUser,
  findUserByUsername,
  findUserById,
  updateUsername,
  searchUsers,
  getOrCreateConversation,
  userInConversation,
  listConversations,
  listMessages,
  addMessage,
  getMessage,
  setPinned,
  getAttachment,
  attachmentPath,
  wipeExpiredMessages,
  getWipeInfo,
  closeDb,
  UPLOAD_DIR,
} from "./db.js";

const PORT = Number(process.env.PORT) || 3000;
const isProd = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (isProd ? null : "dev-only-secret-change-me");
const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;
const MAX_PIN_BYTES = 500 * 1024 * 1024;

if (!SESSION_SECRET) {
  console.error("Set SESSION_SECRET in Railway variables before starting.");
  process.exit(1);
}

const USERNAME_RE = /^[a-zA-Z0-9_]{2,24}$/;

function publicUser(user) {
  return { username: user.username };
}

function attachmentSize(message) {
  return (message.attachments || []).reduce(
    (sum, file) => sum + Number(file.size || 0),
    0
  );
}

function publicMessage(message, userId) {
  const attachments = (message.attachments || []).map((file) => ({
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: Number(file.size) || 0,
  }));
  return {
    id: message.id,
    mine: message.sender_id === userId,
    body: message.body,
    createdAt: message.created_at,
    pinned: Boolean(message.pinned),
    attachments,
    totalSize: attachments.reduce((sum, file) => sum + file.size, 0),
  };
}

function signToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function readToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.uid || data.exp < Date.now()) return null;
    return data.uid;
  } catch {
    return null;
  }
}

function setAuthCookie(res, userId) {
  res.cookie("token", signToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: "/",
  });
}

function parseUsername(value) {
  const username = String(value || "").trim();
  if (!USERNAME_RE.test(username)) {
    const err = new Error(
      "Username must be 2-24 letters, numbers, or underscores."
    );
    err.status = 400;
    throw err;
  }
  return username;
}

function parsePassword(value) {
  const password = String(value || "");
  if (password.length < 4 || password.length > 72) {
    const err = new Error("Password must be 4-72 characters.");
    err.status = 400;
    throw err;
  }
  return password;
}

async function requireUser(req, res, next) {
  const userId = readToken(req.cookies.token);
  if (!userId) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  const user = await findUserById(userId);
  if (!user) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  req.user = user;
  next();
}

function emitToConversation(conversation, event, payloadFor) {
  io.to(conversation.user_low).emit(event, payloadFor(conversation.user_low));
  io.to(conversation.user_high).emit(event, payloadFor(conversation.user_high));
}

function removeFiles(files) {
  for (const file of files || []) {
    try {
      fs.unlinkSync(file.path || attachmentPath(file.filename || file.id));
    } catch {
      // already gone
    }
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: {
    fileSize: MAX_MESSAGE_BYTES,
    files: 12,
  },
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use(express.static(path.join(process.cwd(), "public")));
app.get("/favicon.ico", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "assets", "SmallLogo.png"));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/wipe", (_req, res) => {
  res.json(getWipeInfo());
});

app.get("/api/me", async (req, res) => {
  const userId = readToken(req.cookies.token);
  if (!userId) {
    res.json({ user: null });
    return;
  }
  const user = await findUserById(userId);
  res.json({ user: user ? publicUser(user) : null });
});

app.post("/api/register", async (req, res) => {
  try {
    const username = parseUsername(req.body.username);
    const password = parsePassword(req.body.password);
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(username, passwordHash);
    setAuthCookie(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const user = await findUserByUsername(username);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: "Wrong username or password." });
      return;
    }
    setAuthCookie(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not sign in." });
  }
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("token", { path: "/" });
  res.json({ ok: true });
});

app.post("/api/username", requireUser, async (req, res) => {
  try {
    const username = parseUsername(req.body.username);
    const user = await updateUsername(req.user.id, username);
    io.emit("username-changed", {
      conversationHint: true,
      username: user.username,
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not change username." });
  }
});

app.get("/api/users", requireUser, async (req, res) => {
  const q = String(req.query.q || "");
  const users = await searchUsers(q, req.user.id);
  res.json({ users: users.map((user) => ({ username: user.username })) });
});

app.get("/api/conversations", requireUser, async (req, res) => {
  const conversations = await listConversations(req.user.id);
  res.json({
    conversations: conversations.map((item) => ({
      id: item.id,
      username: item.other_username,
      lastMessage: item.last_message,
      lastAt: item.last_at,
    })),
  });
});

app.post("/api/conversations", requireUser, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const other = await findUserByUsername(username);
    if (!other) {
      res.status(404).json({ error: "No account with that username." });
      return;
    }
    if (other.id === req.user.id) {
      res.status(400).json({ error: "You cannot message yourself." });
      return;
    }
    const conversation = await getOrCreateConversation(req.user.id, other.id);
    res.json({ id: conversation.id, username: other.username });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not start chat." });
  }
});

app.get("/api/conversations/:id/messages", requireUser, async (req, res) => {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation) {
    res.status(404).json({ error: "Chat not found." });
    return;
  }
  const messages = await listMessages(conversation.id);
  res.json({
    messages: messages.map((message) => publicMessage(message, req.user.id)),
  });
});

app.post(
  "/api/conversations/:id/messages",
  requireUser,
  upload.array("files", 12),
  async (req, res) => {
    const files = req.files || [];
    const body = String(req.body.body || "").trim();
    if (body.length > 2000) {
      removeFiles(files);
      res.status(400).json({ error: "Message is too long." });
      return;
    }
    if (!body && files.length === 0) {
      res.status(400).json({ error: "Message cannot be empty." });
      return;
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_MESSAGE_BYTES) {
      removeFiles(files);
      res.status(400).json({ error: "Uploads can be up to 1 GB per message." });
      return;
    }
    const conversation = await userInConversation(req.params.id, req.user.id);
    if (!conversation) {
      removeFiles(files);
      res.status(404).json({ error: "Chat not found." });
      return;
    }
    const attachments = files.map((file) => ({
      id: file.filename,
      name: path.basename(file.originalname || "file").slice(0, 180),
      mime: file.mimetype || "application/octet-stream",
      size: file.size,
    }));
    const message = await addMessage(
      conversation.id,
      req.user.id,
      body,
      attachments
    );
    emitToConversation(conversation, "message", (userId) => ({
      conversationId: conversation.id,
      ...publicMessage(message, userId),
    }));
    res.status(201).json(publicMessage(message, req.user.id));
  }
);

app.post("/api/messages/:id/pin", requireUser, async (req, res) => {
  const message = await getMessage(req.params.id);
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const conversation = await userInConversation(
    message.conversation_id,
    req.user.id
  );
  if (!conversation) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (attachmentSize(message) > MAX_PIN_BYTES) {
    res.status(400).json({
      error: "You can't pin a message larger than 500 MB.",
    });
    return;
  }
  const updated = await setPinned(message.id, true);
  emitToConversation(conversation, "message-updated", (userId) => ({
    conversationId: conversation.id,
    ...publicMessage(updated, userId),
  }));
  res.json(publicMessage(updated, req.user.id));
});

app.post("/api/messages/:id/unpin", requireUser, async (req, res) => {
  const message = await getMessage(req.params.id);
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const conversation = await userInConversation(
    message.conversation_id,
    req.user.id
  );
  if (!conversation) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const updated = await setPinned(message.id, false);
  emitToConversation(conversation, "message-updated", (userId) => ({
    conversationId: conversation.id,
    ...publicMessage(updated, userId),
  }));
  res.json(publicMessage(updated, req.user.id));
});

app.get("/api/attachments/:id", requireUser, async (req, res) => {
  const file = await getAttachment(req.params.id);
  if (!file) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  const conversation = await userInConversation(file.conversation_id, req.user.id);
  if (!conversation) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  const stored = attachmentPath(file.id);
  if (!fs.existsSync(stored)) {
    res.status(404).json({ error: "File not found." });
    return;
  }
  res.setHeader("Content-Type", file.mime || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(file.name || "file")}"`
  );
  res.sendFile(stored);
});

app.use((err, _req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "Uploads can be up to 1 GB per message." });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : "";
  const userId = readToken(token);
  if (!userId) {
    next(new Error("Not signed in."));
    return;
  }
  socket.userId = userId;
  next();
});

io.on("connection", (socket) => {
  socket.join(socket.userId);
});

async function runWipe() {
  const removed = await wipeExpiredMessages();
  if (removed > 0) {
    io.emit("wiped");
  }
}

await initDb();
await runWipe();
setInterval(runWipe, 60 * 60 * 1000);

server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 31 * 60 * 1000;
server.timeout = 30 * 60 * 1000;

server.listen(PORT, "0.0.0.0", () => {
  const wipe = getWipeInfo();
  console.log(`Luke's Cookies listening on ${PORT}`);
  console.log(`Next calendar wipe: ${wipe.label} (${wipe.timezone})`);
});

async function shutdown() {
  server.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
