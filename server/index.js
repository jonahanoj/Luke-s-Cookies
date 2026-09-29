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
  setUserAvatar,
  setUserColor,
  getAvatarOwner,
  createGroup,
  addGroupMember,
  listMemberProfiles,
  sweepOrphanFiles,
  uploadDirUsage,
  setBio,
  setThemeColors,
  setThemeBackground,
  setBlocked,
  blockedIdsBy,
  blockerIdsOf,
  listBlockedUsers,
  setMuted,
  mutedConversationIds,
  listPinnedForUser,
  savePushSubscription,
  removePushSubscription,
} from "./db.js";
import { guessMime } from "./mime.js";
import { processAvatar, processBackground } from "./image.js";
import { initPush, pushPublicKey, sendPush } from "./push.js";

const PORT = Number(process.env.PORT) || 3000;
const isProd = Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production"
);
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (isProd ? null : "dev-only-secret-change-me");
const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;
const MAX_PIN_BYTES = 500 * 1024 * 1024;
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024;
const MAX_BIO_CHARS = 300;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

if (!SESSION_SECRET) {
  console.error("Set SESSION_SECRET in Railway variables before starting.");
  process.exit(1);
}

const USERNAME_RE = /^[a-zA-Z0-9_]{2,24}$/;

function avatarUrl(avatarId) {
  return avatarId ? `/api/avatars/${avatarId}` : null;
}

// The signed-in user's own view of themselves (includes their theme).
function publicUser(user) {
  return {
    username: user.username,
    avatarUrl: avatarUrl(user.avatar_id),
    nameColor: user.name_color || "#6e8070",
    bio: user.bio || "",
    theme: {
      primary: user.theme_primary || null,
      secondary: user.theme_secondary || null,
      backgroundUrl: user.theme_bg_id ? `/api/backgrounds/${user.theme_bg_id}` : null,
    },
  };
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function publicMember(member) {
  return {
    username: member.username,
    avatarUrl: avatarUrl(member.avatar_id),
    nameColor: member.name_color || "#6e8070",
  };
}

function attachmentSize(message) {
  return (message.attachments || []).reduce(
    (sum, file) => sum + Number(file.size || 0),
    0
  );
}

function publicMessage(message, userId, blocked = null) {
  const mine = message.sender_id === userId;
  if (!mine && blocked?.has(message.sender_id)) {
    return {
      id: message.id,
      mine: false,
      blocked: true,
      username: message.sender_username || null,
      nameColor: message.name_color || "#6e8070",
      avatarUrl: null,
      body: "",
      createdAt: message.created_at,
      pinned: Boolean(message.pinned),
      attachments: [],
      totalSize: 0,
    };
  }
  const attachments = (message.attachments || []).map((file) => {
    const name = file.name;
    const mime = guessMime(name, file.mime);
    return {
      id: file.id,
      name,
      mime,
      size: Number(file.size) || 0,
    };
  });
  return {
    id: message.id,
    mine,
    username: message.sender_username || null,
    nameColor: message.name_color || "#6e8070",
    avatarUrl: avatarUrl(message.avatar_id),
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
  const ids = conversation.member_ids?.length
    ? conversation.member_ids
    : [conversation.user_low, conversation.user_high].filter(Boolean);
  for (const id of ids) {
    io.to(id).emit(event, payloadFor(id));
  }
}

function attachmentSummary(attachments) {
  if (!attachments.length) return "";
  const kinds = attachments.map((file) => {
    const mime = guessMime(file.name, file.mime);
    if (mime === "image/gif") return "a GIF";
    if (mime.startsWith("image/")) return "a photo";
    if (mime.startsWith("video/")) return "a video";
    if (mime.startsWith("audio/")) return "an audio clip";
    return "a file";
  });
  if (attachments.length === 1) return `Sent ${kinds[0]}`;
  return `Sent ${attachments.length} attachments`;
}

// Is this user looking at the app right now? If so they already see the
// message and don't need a push notification.
async function userIsWatching(userId, conversationId) {
  const sockets = await io.in(userId).fetchSockets();
  return sockets.some(
    (socket) => socket.data.visible && socket.data.conversationId === conversationId
  );
}

async function notifyMembers(conversation, message, blockers) {
  const sender = await findUserById(message.sender_id);
  const senderName = sender?.username || "Someone";
  const text = message.body
    ? message.body.length > 140
      ? `${message.body.slice(0, 139)}…`
      : message.body
    : attachmentSummary(message.attachments || []);
  const isGroup = conversation.type === "group";
  for (const userId of conversation.member_ids || []) {
    if (userId === message.sender_id || blockers.has(userId)) continue;
    if ((await mutedConversationIds(userId)).has(conversation.id)) continue;
    if (await userIsWatching(userId, conversation.id)) continue;
    await sendPush(userId, {
      title: isGroup ? `${conversation.title || "Group"}` : senderName,
      body: isGroup ? `${senderName}: ${text}` : text,
      conversationId: conversation.id,
      tag: conversation.id,
    });
  }
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

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: {
    fileSize: MAX_AVATAR_BYTES,
    files: 1,
  },
});

const backgroundUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: {
    fileSize: MAX_BACKGROUND_BYTES,
    files: 1,
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
    res.status(201).json({ user: publicUser({ ...user, name_color: "#6e8070" }) });
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

app.post("/api/bio", requireUser, async (req, res) => {
  const bio = String(req.body.bio ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (bio.length > MAX_BIO_CHARS) {
    res.status(400).json({ error: `About me can be up to ${MAX_BIO_CHARS} characters.` });
    return;
  }
  const user = await setBio(req.user.id, bio);
  res.json({ user: publicUser(user) });
});

app.post("/api/theme", requireUser, async (req, res) => {
  const primary = String(req.body.primary || "").toLowerCase();
  const secondary = String(req.body.secondary || "").toLowerCase();
  if (!COLOR_RE.test(primary) || !COLOR_RE.test(secondary)) {
    res.status(400).json({ error: "Pick valid theme colors." });
    return;
  }
  const user = await setThemeColors(req.user.id, primary, secondary);
  res.json({ user: publicUser(user) });
});

function deleteUpload(id) {
  if (!id) return;
  try {
    fs.unlinkSync(attachmentPath(id));
  } catch {
    // already gone
  }
}

app.post(
  "/api/theme/background",
  requireUser,
  (req, res, next) => backgroundUpload.single("background")(req, res, next),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Choose an image." });
      return;
    }
    try {
      const id = req.file.filename;
      await processBackground(
        req.file.path,
        attachmentPath(id),
        req.file.originalname,
        req.file.mimetype
      );
      const previous = req.user.theme_bg_id;
      const user = await setThemeBackground(req.user.id, id);
      if (previous && previous !== id) deleteUpload(previous);
      res.json({ user: publicUser(user) });
    } catch (err) {
      removeFiles([req.file]);
      res.status(err.status || 500).json({ error: err.message || "Could not save background." });
    }
  }
);

app.delete("/api/theme/background", requireUser, async (req, res) => {
  const previous = req.user.theme_bg_id;
  const user = await setThemeBackground(req.user.id, null);
  deleteUpload(previous);
  res.json({ user: publicUser(user) });
});

app.get("/api/backgrounds/:id", requireUser, async (req, res) => {
  if (req.user.theme_bg_id !== req.params.id) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  const stored = attachmentPath(req.params.id);
  if (!fs.existsSync(stored)) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(stored);
});

app.get("/api/users/:username/profile", requireUser, async (req, res) => {
  const user = await findUserByUsername(String(req.params.username || ""));
  if (!user) {
    res.status(404).json({ error: "No account with that username." });
    return;
  }
  const blocked = await blockedIdsBy(req.user.id);
  res.json({
    profile: {
      username: user.username,
      avatarUrl: avatarUrl(user.avatar_id),
      nameColor: user.name_color || "#6e8070",
      bio: user.bio || "",
      isMe: user.id === req.user.id,
      blocked: blocked.has(user.id),
    },
  });
});

app.post("/api/users/:username/block", requireUser, async (req, res) => {
  const user = await findUserByUsername(String(req.params.username || ""));
  if (!user || user.id === req.user.id) {
    res.status(404).json({ error: "No account with that username." });
    return;
  }
  const blocked = Boolean(req.body.blocked);
  await setBlocked(req.user.id, user.id, blocked);
  res.json({ blocked });
});

app.get("/api/blocked", requireUser, async (req, res) => {
  const users = await listBlockedUsers(req.user.id);
  res.json({ users: users.map(publicMember) });
});

app.post("/api/conversations/:id/mute", requireUser, async (req, res) => {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation) {
    res.status(404).json({ error: "Chat not found." });
    return;
  }
  const muted = Boolean(req.body.muted);
  await setMuted(req.user.id, conversation.id, muted);
  res.json({ muted });
});

app.get("/api/pinned", requireUser, async (req, res) => {
  const blocked = await blockedIdsBy(req.user.id);
  const rows = await listPinnedForUser(req.user.id);
  res.json({
    pinned: rows.map(({ conversation, message }) => ({
      conversationId: conversation.id,
      chatName: conversation.title,
      isGroup: conversation.type === "group",
      ...publicMessage(message, req.user.id, blocked),
    })),
  });
});

app.get("/api/push/key", requireUser, (_req, res) => {
  res.json({ publicKey: pushPublicKey() });
});

app.post("/api/push/subscribe", requireUser, async (req, res) => {
  const sub = req.body.subscription;
  if (
    !sub ||
    typeof sub.endpoint !== "string" ||
    !/^https:\/\//.test(sub.endpoint) ||
    !sub.keys?.p256dh ||
    !sub.keys?.auth
  ) {
    res.status(400).json({ error: "Bad subscription." });
    return;
  }
  await savePushSubscription(req.user.id, {
    endpoint: sub.endpoint,
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
  });
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", requireUser, async (req, res) => {
  const endpoint = String(req.body.endpoint || "");
  if (endpoint) await removePushSubscription(endpoint);
  res.json({ ok: true });
});

app.post("/api/username", requireUser, async (req, res) => {
  try {
    const username = parseUsername(req.body.username);
    const user = await updateUsername(req.user.id, username);
    io.emit("username-changed", { username: user.username });
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not change username." });
  }
});

app.post("/api/color", requireUser, async (req, res) => {
  const color = String(req.body.color || "");
  if (!COLOR_RE.test(color)) {
    res.status(400).json({ error: "Pick a valid color." });
    return;
  }
  const user = await setUserColor(req.user.id, color.toLowerCase());
  io.emit("profile-changed", { username: user.username, nameColor: user.name_color });
  res.json({ user: publicUser(user) });
});

app.post("/api/avatar", requireUser, avatarUpload.single("avatar"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Choose an image or gif." });
    return;
  }
  try {
    const id = req.file.filename;
    const stored = attachmentPath(id);
    await processAvatar(req.file.path, stored, req.file.originalname, req.file.mimetype);
    if (req.user.avatar_id && req.user.avatar_id !== id) {
      try {
        fs.unlinkSync(attachmentPath(req.user.avatar_id));
      } catch {
        // already gone
      }
    }
    const user = await setUserAvatar(req.user.id, id);
    io.emit("profile-changed", { username: user.username, avatarUrl: avatarUrl(id) });
    res.json({ user: publicUser(user) });
  } catch (err) {
    removeFiles([req.file]);
    res.status(err.status || 500).json({ error: err.message || "Could not save picture." });
  }
});

app.get("/api/users", requireUser, async (req, res) => {
  const q = String(req.query.q || "");
  const users = await searchUsers(q, req.user.id);
  res.json({
    users: users.map((user) => ({
      username: user.username,
      avatarUrl: avatarUrl(user.avatar_id),
      nameColor: user.name_color || "#6e8070",
    })),
  });
});

app.get("/api/conversations", requireUser, async (req, res) => {
  const conversations = await listConversations(req.user.id);
  const muted = await mutedConversationIds(req.user.id);
  const blocked = await blockedIdsBy(req.user.id);
  res.json({
    conversations: conversations.map((item) => ({
      id: item.id,
      isGroup: item.type === "group",
      muted: muted.has(item.id),
      blocked:
        item.type !== "group" &&
        (item.members || []).some(
          (member) => member.id !== req.user.id && blocked.has(member.id)
        ),
      username: item.other_username,
      title: item.title,
      avatarUrl: avatarUrl(item.other_avatar_id),
      lastMessage: item.last_message,
      lastAt: item.last_at,
      members: (item.members || [])
        .filter((member) => member.id !== req.user.id)
        .map(publicMember),
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
    res.json({ id: conversation.id, username: other.username, isGroup: false });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not start chat." });
  }
});

app.post("/api/groups", requireUser, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim().slice(0, 40);
    const names = Array.isArray(req.body.usernames) ? req.body.usernames : [];
    if (!title) {
      res.status(400).json({ error: "Give the group a name." });
      return;
    }
    const memberIds = [req.user.id];
    for (const raw of names) {
      const other = await findUserByUsername(String(raw || "").trim());
      if (!other) {
        res.status(404).json({ error: `No account named ${raw}.` });
        return;
      }
      if (other.id !== req.user.id) memberIds.push(other.id);
    }
    if (memberIds.length < 2) {
      res.status(400).json({ error: "Add at least one other person." });
      return;
    }
    const group = await createGroup(title, memberIds);
    const conversation = await userInConversation(group.id, req.user.id);
    emitToConversation(conversation, "username-changed", () => ({}));
    res.status(201).json({ id: group.id, username: title, isGroup: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not make group." });
  }
});

app.post("/api/conversations/:id/members", requireUser, async (req, res) => {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation || conversation.type !== "group") {
    res.status(404).json({ error: "Group not found." });
    return;
  }
  const other = await findUserByUsername(String(req.body.username || "").trim());
  if (!other) {
    res.status(404).json({ error: "No account with that username." });
    return;
  }
  await addGroupMember(conversation.id, other.id);
  const members = await listMemberProfiles(conversation.id);
  io.to(other.id).emit("username-changed", {});
  emitToConversation(
    { ...conversation, member_ids: members.map((member) => member.id) },
    "username-changed",
    () => ({})
  );
  res.json({ members: members.map(publicMember) });
});

app.get("/api/conversations/:id/messages", requireUser, async (req, res) => {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation) {
    res.status(404).json({ error: "Chat not found." });
    return;
  }
  const messages = await listMessages(conversation.id);
  const blocked = await blockedIdsBy(req.user.id);
  res.json({
    messages: messages.map((message) => publicMessage(message, req.user.id, blocked)),
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
    if (conversation.type !== "group") {
      const otherId = conversation.member_ids.find((id) => id !== req.user.id);
      const iBlocked = (await blockedIdsBy(req.user.id)).has(otherId);
      const theyBlocked = (await blockerIdsOf(req.user.id)).has(otherId);
      if (iBlocked || theyBlocked) {
        removeFiles(files);
        res.status(403).json({
          error: iBlocked
            ? "You blocked this person. Unblock them to send messages."
            : "You can't message this person.",
        });
        return;
      }
    }
    const attachments = files.map((file) => {
      const name = path.basename(file.originalname || "file").slice(0, 180);
      return {
        id: file.filename,
        name,
        mime: guessMime(name, file.mimetype),
        size: file.size,
      };
    });
    const message = await addMessage(
      conversation.id,
      req.user.id,
      body,
      attachments
    );
    const blockers = await blockerIdsOf(req.user.id);
    emitToConversation(conversation, "message", (userId) => ({
      conversationId: conversation.id,
      ...publicMessage(message, userId, blockers.has(userId) ? new Set([req.user.id]) : null),
    }));
    res.status(201).json(publicMessage(message, req.user.id));
    notifyMembers(conversation, message, blockers).catch((err) =>
      console.warn("Notify failed:", err.message)
    );
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
  const blockers = await blockerIdsOf(updated.sender_id);
  emitToConversation(conversation, "message-updated", (userId) => ({
    conversationId: conversation.id,
    ...publicMessage(updated, userId, blockers.has(userId) ? new Set([updated.sender_id]) : null),
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
  const blockers = await blockerIdsOf(updated.sender_id);
  emitToConversation(conversation, "message-updated", (userId) => ({
    conversationId: conversation.id,
    ...publicMessage(updated, userId, blockers.has(userId) ? new Set([updated.sender_id]) : null),
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
  const mime = guessMime(file.name, file.mime);
  res.setHeader("Content-Type", mime);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(file.name || "file")}"`
  );
  res.sendFile(stored);
});

app.get("/api/avatars/:id", requireUser, async (req, res) => {
  const owner = await getAvatarOwner(req.params.id);
  if (!owner) {
    res.status(404).json({ error: "Picture not found." });
    return;
  }
  const stored = attachmentPath(req.params.id);
  if (!fs.existsSync(stored)) {
    res.status(404).json({ error: "Picture not found." });
    return;
  }
  const header = Buffer.alloc(12);
  const handle = fs.openSync(stored, "r");
  fs.readSync(handle, header, 0, 12, 0);
  fs.closeSync(handle);
  let mime = "image/png";
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) mime = "image/gif";
  else if (header[0] === 0xff && header[1] === 0xd8) mime = "image/jpeg";
  else if (header.toString("ascii", 0, 4) === "RIFF") mime = "image/webp";
  res.setHeader("Content-Type", mime);
  res.sendFile(stored);
});

app.use((err, req, res, _next) => {
  removeFiles(req.files);
  if (req.file) removeFiles([req.file]);
  if (err && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "That file is too big." });
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
  socket.data.visible = false;
  socket.data.conversationId = null;
  socket.on("presence", (state) => {
    socket.data.visible = Boolean(state?.visible);
    socket.data.conversationId =
      typeof state?.conversationId === "string" ? state.conversationId : null;
  });
});

async function runWipe() {
  try {
    const wiped = await wipeExpiredMessages();
    const swept = await sweepOrphanFiles();
    if (wiped.messages || wiped.files || swept.files) {
      const usage = uploadDirUsage();
      console.log(
        `Wipe: removed ${wiped.messages} messages, ${wiped.files} attachments ` +
          `(${formatBytes(wiped.bytes)}), ${swept.files} leftover files ` +
          `(${formatBytes(swept.bytes)}). Uploads now ${usage.files} files, ` +
          `${formatBytes(usage.bytes)}.`
      );
    }
    if (wiped.messages) io.emit("wiped");
  } catch (err) {
    console.error("Wipe failed:", err);
  }
}

await initDb();
await initPush();
await runWipe();
setInterval(runWipe, 15 * 60 * 1000);

server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 31 * 60 * 1000;
server.timeout = 30 * 60 * 1000;

server.listen(PORT, "0.0.0.0", () => {
  const wipe = getWipeInfo();
  console.log(`Luke's Cookies listening on ${PORT}`);
  const usage = uploadDirUsage();
  console.log(`Next wipe: ${wipe.label} (${wipe.timezone}), every 14 days`);
  console.log(`Uploads on disk: ${usage.files} files, ${formatBytes(usage.bytes)}`);
});

async function shutdown() {
  server.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
