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
  renameGroup,
  setGroupAvatar,
  setGroupCreator,
  removeGroupMember,
  deleteConversation,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  listEmojiPacks,
  getEmojiPack,
  createEmojiPack,
  renameEmojiPack,
  deleteEmojiPack,
  addEmoji,
  getEmoji,
  emojiFileKnown,
  renameEmoji,
  deleteEmoji,
  copyEmojiPack,
  editMessage,
  deleteMessageContent,
  packSubscriberIds,
  isSubscribed,
  subscribePack,
  unsubscribePack,
  migrateCopiedPacks,
  toggleReaction,
  countUserReactions,
  setPollVote,
  addView,
  starsGivenOn,
  starsReceived,
  hasStarred,
  giveStars,
  setRead,
  listReads,
  setCrumbState,
  dueScheduledMessages,
  markDelivered,
  hardDeleteMessage,
  vanishMessage,
} from "./db.js";
import { sanitizeFx, spansToText, fxAssetIds } from "./fx.js";
import { makeGifLoop } from "./gifloop.js";
import { guessMime } from "./mime.js";
import { processAvatar, processBackground, processEmoji } from "./image.js";
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

// [{k, u, n}] -> [{key, count, mine, names}] in first-used order.
function groupReactions(list, userId) {
  const groups = new Map();
  for (const r of list || []) {
    if (!groups.has(r.k)) groups.set(r.k, { key: r.k, count: 0, mine: false, names: [] });
    const g = groups.get(r.k);
    g.count += 1;
    if (r.u === userId) g.mine = true;
    if (r.n) g.names.push(r.n);
  }
  return [...groups.values()];
}

function publicMessage(message, userId, blocked = null) {
  const mine = message.sender_id === userId;
  if (message.deleted) {
    // Nobody sees who deleted it.
    return {
      id: message.id,
      deleted: true,
      mine: false,
      username: null,
      avatarUrl: null,
      body: "",
      createdAt: message.created_at,
      pinned: false,
      attachments: [],
      fx: null,
      totalSize: 0,
    };
  }
  // Self-destructed (for everyone), or already seen by this viewer.
  const gone = message.fx?.gone || (message.fx?.boom && !mine && (message.views || []).includes(userId));
  if (gone) {
    return {
      id: message.id,
      gone: true,
      mine,
      username: message.sender_username || null,
      nameColor: message.name_color || "#6e8070",
      avatarUrl: avatarUrl(message.avatar_id),
      body: "",
      createdAt: message.created_at,
      pinned: false,
      attachments: [],
      fx: null,
      totalSize: 0,
      reactions: [],
    };
  }
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
  const all = (message.attachments || []).map((file) => {
    const name = file.name;
    const mime = guessMime(name, file.mime);
    return {
      id: file.id,
      name,
      mime,
      size: Number(file.size) || 0,
      role: file.role === "fx" ? "fx" : "file",
    };
  });
  const attachments = all
    .filter((file) => file.role === "file")
    .map(({ role, ...file }) => file);
  const fxMime = Object.fromEntries(
    all.filter((file) => file.role === "fx").map((file) => [file.id, file.mime])
  );
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
    fx: message.fx || null,
    fxMime,
    edited: Boolean(message.edited_at),
    forwarded: Boolean(message.forwarded),
    canStar: (message.origin_sender_id || message.sender_id) !== userId,
    reactions: groupReactions(message.reactions, userId),
    totalSize: all.reduce((sum, file) => sum + file.size, 0),
    reply: message.reply || null,
    scheduledFor: message.scheduled_for || null,
    poll: publicPoll(message, userId),
    stars: publicStars(message, userId),
    boomSeen: message.fx?.boom ? (message.views || []).length : undefined,
    crumbState: message.fx?.crumb
      ? message.crumb_state || globalThis.CrumbsEngine.initialState(message.fx.crumb, Date.parse(message.created_at))
      : undefined,
    serverNow: message.fx?.crumb ? Date.now() : undefined,
  };
}

function publicPoll(message, userId) {
  const poll = message.fx?.poll;
  if (!poll) return undefined;
  const votes = message.votes || [];
  return {
    q: poll.q,
    multi: poll.multi,
    anon: poll.anon,
    total: new Set(votes.map((v) => v.u)).size,
    options: poll.options.map((text, index) => {
      const here = votes.filter((v) => v.o === index);
      return {
        text,
        count: here.length,
        mine: here.some((v) => v.u === userId),
        voters: poll.anon ? [] : here.map((v) => v.n).filter(Boolean),
      };
    }),
  };
}

function publicStars(message, userId) {
  const list = message.stars || [];
  if (!list.length) return { total: 0, mine: 0, givers: [] };
  return {
    total: list.reduce((sum, g) => sum + g.s, 0),
    mine: list.find((g) => g.u === userId)?.s || 0,
    givers: list.map((g) => ({ name: g.n, stars: g.s })),
  };
}

// Short preview of the message being replied to.
function replySnippet(message) {
  if (!message) return { gone: true, snippet: "Message is gone" };
  if (message.deleted) return { id: message.id, gone: true, snippet: "Deleted message" };
  if (message.fx?.gone || message.fx?.boom) return { id: message.id, username: message.sender_username, snippet: "💣 Self-destructing message" };
  let snippet = message.body || "";
  if (!snippet) {
    const files = (message.attachments || []).filter((f) => f.role !== "fx");
    if (message.fx?.poll) snippet = `📊 ${message.fx.poll.q}`;
    else if (message.fx?.crumb) snippet = "🍪 Crumb";
    else if (files.length) snippet = files.length === 1 ? files[0].name : `${files.length} files`;
    else if (message.fx?.effect) snippet = "✨ Effect";
    else snippet = "Message";
  }
  return {
    id: message.id,
    username: message.sender_username || null,
    snippet: snippet.length > 120 ? `${snippet.slice(0, 119)}…` : snippet,
  };
}

async function attachReplies(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const message of messages) {
    if (!message.reply_to) continue;
    const target = byId.get(message.reply_to) || (await getMessage(message.reply_to));
    message.reply = replySnippet(target);
  }
  return messages;
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
    : message.fx?.pack
      ? "Shared an emoji pack"
      : attachmentSummary((message.attachments || []).filter((file) => file.role !== "fx")) ||
        (message.fx?.effect ? "Sent an effect" : "");
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
    files: 25,
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
      stars: await starsReceived(user.id),
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

// ---- custom emojis ----

const EMOJI_NAME_RE = /^[A-Za-z0-9_]{1,32}$/;

function emojiName(value, fallback = "emoji") {
  const cleaned = String(value || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return EMOJI_NAME_RE.test(cleaned) ? cleaned : fallback;
}

function publicPack(pack) {
  return {
    id: pack.id,
    name: pack.name,
    mine: pack.mine !== undefined ? pack.mine : undefined,
    ownerName: pack.owner_name || null,
    emojis: (pack.emojis || []).map((emoji) => ({
      id: emoji.id,
      name: emoji.name,
      fileId: emoji.file_id,
      url: `/api/emoji-files/${emoji.file_id}`,
    })),
  };
}

async function ownPack(req, res) {
  const pack = await getEmojiPack(req.params.id);
  if (!pack) {
    res.status(404).json({ error: "Emoji pack not found." });
    return null;
  }
  if (pack.owner_id !== req.user.id) {
    res.status(403).json({ error: "Only the person who made this pack can edit it." });
    return null;
  }
  return pack;
}

// Everyone using a pack sees the creator's changes right away.
async function notifyPack(packId, ownerId) {
  const ids = new Set([ownerId, ...(await packSubscriberIds(packId))]);
  for (const id of ids) io.to(id).emit("emojis-changed", { packId });
}

const emojiUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 50 },
});

app.get("/api/emojis", requireUser, async (req, res) => {
  const packs = await listEmojiPacks(req.user.id);
  res.json({ packs: packs.map(publicPack) });
});

app.post("/api/emoji-packs", requireUser, async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 40) || "My emojis";
  const pack = await createEmojiPack(req.user.id, name);
  res.status(201).json({ pack: publicPack(pack) });
});

// Anyone signed in can look at a pack (for shared-pack cards).
app.get("/api/emoji-packs/:id", requireUser, async (req, res) => {
  const pack = await getEmojiPack(req.params.id);
  if (!pack) {
    res.status(404).json({ error: "That emoji pack no longer exists." });
    return;
  }
  res.json({
    pack: publicPack(pack),
    mine: pack.owner_id === req.user.id,
    added: await isSubscribed(pack.id, req.user.id),
  });
});

app.patch("/api/emoji-packs/:id", requireUser, async (req, res) => {
  const pack = await ownPack(req, res);
  if (!pack) return;
  const name = String(req.body.name || "").trim().slice(0, 40);
  if (!name) {
    res.status(400).json({ error: "Give the pack a name." });
    return;
  }
  await renameEmojiPack(pack.id, name);
  await notifyPack(pack.id, pack.owner_id);
  res.json({ ok: true });
});

// The creator deletes the pack for everyone; anyone else just removes it
// from their own emojis.
app.delete("/api/emoji-packs/:id", requireUser, async (req, res) => {
  const pack = await getEmojiPack(req.params.id);
  if (!pack) {
    res.status(404).json({ error: "Emoji pack not found." });
    return;
  }
  if (pack.owner_id === req.user.id) {
    const subscribers = await packSubscriberIds(pack.id);
    await deleteEmojiPack(pack.id);
    for (const id of subscribers) io.to(id).emit("emojis-changed", { packId: pack.id });
  } else {
    await unsubscribePack(pack.id, req.user.id);
  }
  res.json({ ok: true });
});

// "Add to my emojis": links the pack (it keeps following the creator's edits).
app.post("/api/emoji-packs/:id/copy", requireUser, async (req, res) => {
  const pack = await getEmojiPack(req.params.id);
  if (!pack) {
    res.status(404).json({ error: "That emoji pack no longer exists." });
    return;
  }
  if (pack.owner_id !== req.user.id) await subscribePack(pack.id, req.user.id);
  res.status(201).json({ pack: publicPack(pack) });
});

app.post(
  "/api/emoji-packs/:id/emojis",
  requireUser,
  emojiUpload.array("emojis", 50),
  async (req, res) => {
    const files = req.files || [];
    const pack = await ownPack(req, res);
    if (!pack) {
      removeFiles(files);
      return;
    }
    if (!files.length) {
      res.status(400).json({ error: "Choose some images or GIFs." });
      return;
    }
    const taken = new Set(pack.emojis.map((emoji) => emoji.name.toLowerCase()));
    const errors = [];
    for (const file of files) {
      try {
        const mime = await processEmoji(
          file.path,
          attachmentPath(file.filename),
          file.originalname,
          file.mimetype
        );
        let name = emojiName(file.originalname);
        let n = 2;
        while (taken.has(name.toLowerCase())) name = `${emojiName(file.originalname).slice(0, 28)}_${n++}`;
        taken.add(name.toLowerCase());
        await addEmoji(pack.id, name, file.filename, mime);
      } catch (err) {
        removeFiles([file]);
        errors.push(err.message);
      }
    }
    const updated = await getEmojiPack(pack.id);
    await notifyPack(pack.id, pack.owner_id);
    res.json({ pack: publicPack(updated), errors });
  }
);

async function ownEmoji(req, res) {
  const emoji = await getEmoji(req.params.id);
  if (!emoji) {
    res.status(404).json({ error: "Emoji not found." });
    return null;
  }
  if (emoji.owner_id !== req.user.id) {
    res.status(403).json({ error: "Only the person who made this pack can edit it." });
    return null;
  }
  return emoji;
}

app.patch("/api/emojis/:id", requireUser, async (req, res) => {
  const emoji = await ownEmoji(req, res);
  if (!emoji) return;
  const name = String(req.body.name || "").trim();
  if (!EMOJI_NAME_RE.test(name)) {
    res.status(400).json({ error: "Emoji names can use letters, numbers and _ (max 32)." });
    return;
  }
  await renameEmoji(emoji.id, name);
  await notifyPack(emoji.pack_id, emoji.owner_id);
  res.json({ ok: true });
});

app.delete("/api/emojis/:id", requireUser, async (req, res) => {
  const emoji = await ownEmoji(req, res);
  if (!emoji) return;
  await deleteEmoji(emoji.id);
  await notifyPack(emoji.pack_id, emoji.owner_id);
  res.json({ ok: true });
});

app.get("/api/emoji-files/:id", requireUser, async (req, res) => {
  const known = await emojiFileKnown(req.params.id);
  const stored = attachmentPath(req.params.id);
  if (!known || !fs.existsSync(stored)) {
    res.status(404).json({ error: "Emoji not found." });
    return;
  }
  res.setHeader("Content-Type", known.mime || "image/png");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(stored);
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
      isCreator: item.type === "group" && item.created_by === req.user.id,
      createdBy:
        (item.members || []).find((member) => member.id === item.created_by)?.username || null,
      canRemove:
        item.type === "group" && (!item.created_by || item.created_by === req.user.id),
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
    const group = await createGroup(title, memberIds, req.user.id);
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

// ---- group management ----

async function requireGroup(req, res) {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation || conversation.type !== "group") {
    res.status(404).json({ error: "Group not found." });
    return null;
  }
  return conversation;
}

function emitGroupChanged(conversation, extraIds = []) {
  const ids = new Set([...(conversation.member_ids || []), ...extraIds]);
  for (const id of ids) io.to(id).emit("conversation-updated", { conversationId: conversation.id });
}

app.get("/api/conversations/:id/members", requireUser, async (req, res) => {
  const conversation = await requireGroup(req, res);
  if (!conversation) return;
  const members = await listMemberProfiles(conversation.id);
  res.json({
    createdBy: conversation.created_by || null,
    members: members.map((member) => ({
      ...publicMember(member),
      isCreator: member.id === conversation.created_by,
      isMe: member.id === req.user.id,
    })),
  });
});

app.patch("/api/conversations/:id", requireUser, async (req, res) => {
  const conversation = await requireGroup(req, res);
  if (!conversation) return;
  const title = String(req.body.title || "").trim().slice(0, 40);
  if (!title) {
    res.status(400).json({ error: "Give the group a name." });
    return;
  }
  await renameGroup(conversation.id, title);
  emitGroupChanged(conversation);
  res.json({ ok: true, title });
});

app.post(
  "/api/conversations/:id/avatar",
  requireUser,
  avatarUpload.single("avatar"),
  async (req, res) => {
    const conversation = await requireGroup(req, res);
    if (!conversation) {
      if (req.file) removeFiles([req.file]);
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "Choose an image or gif." });
      return;
    }
    try {
      const id = req.file.filename;
      await processAvatar(req.file.path, attachmentPath(id), req.file.originalname, req.file.mimetype);
      const previous = conversation.avatar_id;
      await setGroupAvatar(conversation.id, id);
      if (previous && previous !== id) deleteUpload(previous);
      emitGroupChanged(conversation);
      res.json({ avatarUrl: avatarUrl(id) });
    } catch (err) {
      removeFiles([req.file]);
      res.status(err.status || 500).json({ error: err.message || "Could not save picture." });
    }
  }
);

app.delete("/api/conversations/:id/members/:username", requireUser, async (req, res) => {
  const conversation = await requireGroup(req, res);
  if (!conversation) return;
  if (conversation.created_by && conversation.created_by !== req.user.id) {
    res.status(403).json({ error: "Only the person who made the group can remove people." });
    return;
  }
  const other = await findUserByUsername(String(req.params.username || ""));
  if (!other || !conversation.member_ids.includes(other.id)) {
    res.status(404).json({ error: "That person isn't in this group." });
    return;
  }
  if (other.id === req.user.id) {
    res.status(400).json({ error: "Use Leave group to leave." });
    return;
  }
  await removeGroupMember(conversation.id, other.id);
  emitGroupChanged(conversation, [other.id]);
  res.json({ ok: true });
});

app.post("/api/conversations/:id/leave", requireUser, async (req, res) => {
  const conversation = await requireGroup(req, res);
  if (!conversation) return;
  await removeGroupMember(conversation.id, req.user.id);
  const remaining = conversation.member_ids.filter((id) => id !== req.user.id);
  if (!remaining.length) {
    await deleteConversation(conversation.id);
  } else if (conversation.created_by === req.user.id) {
    // Hand the group to whoever is left so someone can still manage it.
    await setGroupCreator(conversation.id, remaining[0]);
  }
  emitGroupChanged(conversation);
  res.json({ ok: true });
});

// ---- tasks ----

function publicTask(task, usernames) {
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    done: task.done,
    percent: task.percent,
    createdBy: usernames.get(task.created_by) || null,
    createdAt: task.created_at,
  };
}

async function memberNames(conversationId) {
  const members = await listMemberProfiles(conversationId);
  return new Map(members.map((member) => [member.id, member.username]));
}

async function emitTasks(conversation) {
  emitToConversation(conversation, "tasks-changed", () => ({ conversationId: conversation.id }));
}

app.get("/api/conversations/:id/tasks", requireUser, async (req, res) => {
  const conversation = await requireGroup(req, res);
  if (!conversation) return;
  const names = await memberNames(conversation.id);
  const tasks = await listTasks(conversation.id);
  res.json({ tasks: tasks.map((task) => publicTask(task, names)) });
});

app.post("/api/conversations/:id/tasks", requireUser, async (req, res) => {
  const conversation = await requireGroup(req, res);
  if (!conversation) return;
  const title = String(req.body.title || "").trim().slice(0, 200);
  const kind = req.body.kind === "percent" ? "percent" : "check";
  if (!title) {
    res.status(400).json({ error: "Give the task a name." });
    return;
  }
  const task = await createTask(conversation.id, title, kind, req.user.id);
  await emitTasks(conversation);
  res.status(201).json({ task: publicTask(task, await memberNames(conversation.id)) });
});

async function taskForUser(req, res) {
  const task = await getTask(req.params.id);
  const conversation = task ? await userInConversation(task.conversation_id, req.user.id) : null;
  if (!task || !conversation) {
    res.status(404).json({ error: "Task not found." });
    return {};
  }
  return { task, conversation };
}

app.patch("/api/tasks/:id", requireUser, async (req, res) => {
  const { task, conversation } = await taskForUser(req, res);
  if (!task) return;
  const changes = {};
  if (typeof req.body.title === "string" && req.body.title.trim()) {
    changes.title = req.body.title.trim().slice(0, 200);
  }
  if (req.body.percent !== undefined && task.kind === "percent") {
    const percent = Math.round(Math.min(100, Math.max(0, Number(req.body.percent) || 0)));
    changes.percent = percent;
    changes.done = percent >= 100;
  }
  if (typeof req.body.done === "boolean") {
    changes.done = req.body.done;
    if (task.kind === "percent") changes.percent = req.body.done ? 100 : Math.min(task.percent, 99);
  }
  const updated = await updateTask(task.id, changes);
  await emitTasks(conversation);
  res.json({ task: publicTask(updated, await memberNames(conversation.id)) });
});

app.delete("/api/tasks/:id", requireUser, async (req, res) => {
  const { task, conversation } = await taskForUser(req, res);
  if (!task) return;
  await deleteTask(task.id);
  await emitTasks(conversation);
  res.json({ ok: true });
});

app.get("/api/conversations/:id/messages", requireUser, async (req, res) => {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation) {
    res.status(404).json({ error: "Chat not found." });
    return;
  }
  const messages = await attachReplies(await listMessages(conversation.id, req.user.id));
  const blocked = await blockedIdsBy(req.user.id);
  const reads = (await listReads(conversation.id))
    .filter((r) => r.user_id !== req.user.id)
    .map((r) => ({ username: r.username, avatarUrl: avatarUrl(r.avatar_id), at: r.read_at }));
  res.json({
    messages: messages.map((message) => publicMessage(message, req.user.id, blocked)),
    reads,
  });
});

// Sends a new message out to everyone in the chat (live + notifications).
async function deliverMessage(conversation, message) {
  const blockers = await blockerIdsOf(message.sender_id);
  emitToConversation(conversation, "message", (userId) => ({
    conversationId: conversation.id,
    ...publicMessage(message, userId, blockers.has(userId) ? new Set([message.sender_id]) : null),
  }));
  notifyMembers(conversation, message, blockers).catch((err) =>
    console.warn("Notify failed:", err.message)
  );
}

app.post(
  "/api/conversations/:id/messages",
  requireUser,
  upload.fields([
    { name: "files", maxCount: 12 },
    { name: "fxfiles", maxCount: 13 },
  ]),
  async (req, res) => {
    const plainFiles = req.files?.files || [];
    const fxFiles = req.files?.fxfiles || [];
    const files = [...plainFiles, ...fxFiles];
    let fx = null;
    const extraFx = []; // server-made fx assets (e.g. a copy of your theme background)
    if (req.body.fx) {
      try {
        const raw = JSON.parse(String(req.body.fx));
        const assetIds = fxFiles.map((file) => file.filename);
        if (raw?.theme && raw.theme.bg === "mine") {
          delete raw.theme.bg;
          const copy = req.user.theme_bg_id ? duplicateUpload(req.user.theme_bg_id) : null;
          if (copy) {
            const size = fs.statSync(attachmentPath(copy)).size;
            extraFx.push({ id: copy, name: "theme-background.webp", mime: "image/webp", size, role: "fx" });
            assetIds.push(copy);
            raw.theme.bg = assetIds.length - 1;
          }
        }
        delete raw?.roulette;
        fx = sanitizeFx(raw, assetIds);
      } catch {
        fx = null;
      }
    }
    // Drop fx uploads the effect doesn't actually use.
    const usedFx = fxAssetIds(fx);
    const keptFx = fxFiles.filter((file) => usedFx.has(file.filename));
    removeFiles(fxFiles.filter((file) => !usedFx.has(file.filename)));
    for (const extra of extraFx.filter((file) => !usedFx.has(file.id))) deleteUpload(extra.id);
    // Replying and scheduling.
    let replyTo = null;
    if (req.body.replyTo) {
      const target = await getMessage(String(req.body.replyTo));
      if (target && target.conversation_id === req.params.id) replyTo = target.id;
    }
    let scheduledFor = null;
    if (req.body.scheduledFor) {
      const when = new Date(String(req.body.scheduledFor));
      if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 30 * 1000) {
        removeFiles([...plainFiles, ...keptFx]);
        res.status(400).json({ error: "Pick a time at least a minute from now." });
        return;
      }
      if (when.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
        removeFiles([...plainFiles, ...keptFx]);
        res.status(400).json({ error: "You can schedule up to a year ahead." });
        return;
      }
      scheduledFor = when.toISOString();
    }
    let body = String(req.body.body || "").trim();
    if (fx?.spans) body = spansToText(fx.spans).trim();
    if (body.length > 2000) body = body.slice(0, 2000);
    if (!body && plainFiles.length === 0 && !fx) {
      removeFiles(files);
      res.status(400).json({ error: "Message cannot be empty." });
      return;
    }
    const total = [...plainFiles, ...keptFx].reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_MESSAGE_BYTES) {
      removeFiles([...plainFiles, ...keptFx]);
      res.status(400).json({ error: "Uploads can be up to 1 GB per message." });
      return;
    }
    const conversation = await userInConversation(req.params.id, req.user.id);
    if (!conversation) {
      removeFiles([...plainFiles, ...keptFx]);
      res.status(404).json({ error: "Chat not found." });
      return;
    }
    if (conversation.type !== "group") {
      const otherId = conversation.member_ids.find((id) => id !== req.user.id);
      const iBlocked = (await blockedIdsBy(req.user.id)).has(otherId);
      const theyBlocked = (await blockerIdsOf(req.user.id)).has(otherId);
      if (iBlocked || theyBlocked) {
        removeFiles([...plainFiles, ...keptFx]);
        res.status(403).json({
          error: iBlocked
            ? "You blocked this person. Unblock them to send messages."
            : "You can't message this person.",
        });
        return;
      }
    }
    const toAttachment = (role) => (file) => {
      const name = path.basename(file.originalname || "file").slice(0, 180);
      return {
        id: file.filename,
        name,
        mime: guessMime(name, file.mimetype),
        size: file.size,
        role,
      };
    };
    const attachments = [
      ...plainFiles.map(toAttachment("file")),
      ...keptFx.map(toAttachment("fx")),
      ...extraFx.filter((file) => usedFx.has(file.id)),
    ];
    for (const file of attachments) {
      if (file.mime === "image/gif") makeGifLoop(attachmentPath(file.id));
    }
    const message = await addMessage(conversation.id, req.user.id, body, attachments, fx, false, {
      replyTo,
      scheduledFor,
    });
    if (fx?.crumb) {
      message.crumb_state = globalThis.CrumbsEngine.initialState(fx.crumb);
      await setCrumbState(message.id, message.crumb_state);
    }
    await attachReplies([message]);
    if (scheduledFor) {
      // Only the sender sees it until it's delivered.
      res.status(201).json(publicMessage(message, req.user.id));
      return;
    }
    await deliverMessage(conversation, message);
    res.status(201).json(publicMessage(message, req.user.id));
  }
);

async function ownMessage(req, res) {
  const message = await getMessage(req.params.id);
  const conversation = message
    ? await userInConversation(message.conversation_id, req.user.id)
    : null;
  if (!message || !conversation) {
    res.status(404).json({ error: "Message not found." });
    return {};
  }
  if (message.sender_id !== req.user.id) {
    res.status(403).json({ error: "You can only change your own messages." });
    return {};
  }
  if (message.deleted) {
    res.status(400).json({ error: "That message was deleted." });
    return {};
  }
  return { message, conversation };
}

async function emitMessageUpdated(conversation, updated) {
  await attachReplies([updated]);
  if (updated.scheduled_for) {
    io.to(updated.sender_id).emit("message-updated", {
      conversationId: conversation.id,
      ...publicMessage(updated, updated.sender_id),
    });
    return;
  }
  const blockers = await blockerIdsOf(updated.sender_id);
  emitToConversation(conversation, "message-updated", (userId) => ({
    conversationId: conversation.id,
    ...publicMessage(updated, userId, blockers.has(userId) ? new Set([updated.sender_id]) : null),
  }));
}

app.patch(
  "/api/messages/:id",
  requireUser,
  upload.fields([{ name: "fxfiles", maxCount: 13 }]),
  async (req, res) => {
    const fxFiles = req.files?.fxfiles || [];
    const { message, conversation } = await ownMessage(req, res);
    if (!message) {
      removeFiles(fxFiles);
      return;
    }
    if (message.forwarded && message.fx?.crumb) {
      removeFiles(fxFiles);
      res.status(400).json({ error: "Forwarded crumbs can't be edited." });
      return;
    }
    if (message.fx?.poll || message.fx?.roulette || message.fx?.theme || message.fx?.pack) {
      removeFiles(fxFiles);
      res.status(400).json({ error: "This kind of message can't be edited." });
      return;
    }
    const existing = new Set(
      (message.attachments || []).filter((file) => file.role === "fx").map((file) => file.id)
    );
    let fx = null;
    if (req.body.fx) {
      try {
        fx = sanitizeFx(
          JSON.parse(String(req.body.fx)),
          fxFiles.map((file) => file.filename),
          existing
        );
      } catch {
        fx = null;
      }
    }
    const used = fxAssetIds(fx);
    const keptNew = fxFiles.filter((file) => used.has(file.filename));
    removeFiles(fxFiles.filter((file) => !used.has(file.filename)));
    let body = String(req.body.body || "").trim();
    if (fx?.spans) body = spansToText(fx.spans).trim();
    body = body.slice(0, 2000);
    const hasFiles = (message.attachments || []).some((file) => file.role !== "fx");
    if (!body && !fx && !hasFiles) {
      removeFiles(keptNew);
      res.status(400).json({ error: "A message can't be empty. Delete it instead." });
      return;
    }
    const newFiles = keptNew.map((file) => {
      const name = path.basename(file.originalname || "file").slice(0, 180);
      return { id: file.filename, name, mime: guessMime(name, file.mimetype), size: file.size };
    });
    for (const file of newFiles) {
      if (file.mime === "image/gif") makeGifLoop(attachmentPath(file.id));
    }
    const keep = new Set([...used].filter((id) => existing.has(id)));
    if (message.fx?.crumb && !fx?.crumb) {
      removeFiles(keptNew);
      res.status(400).json({ error: "A crumb needs at least one thing on it." });
      return;
    }
    const updated = await editMessage(message.id, body, fx, newFiles, keep);
    if (fx?.crumb) {
      // Edited crumbs start over with the new version.
      const fresh = globalThis.CrumbsEngine.initialState(fx.crumb);
      fresh.seq = (message.crumb_state?.seq || 0) + 1;
      await setCrumbState(message.id, fresh);
      updated.crumb_state = fresh;
    }
    await emitMessageUpdated(conversation, updated);
    res.json(publicMessage(updated, req.user.id));
  }
);

app.delete("/api/messages/:id", requireUser, async (req, res) => {
  const { message, conversation } = await ownMessage(req, res);
  if (!message) return;
  if (message.scheduled_for) {
    // Cancelling a scheduled message: nobody else ever saw it.
    await hardDeleteMessage(message.id);
    io.to(req.user.id).emit("message-removed", { conversationId: conversation.id, id: message.id });
    res.json({ id: message.id, removed: true });
    return;
  }
  const updated = await deleteMessageContent(message.id);
  await emitMessageUpdated(conversation, updated);
  emitToConversation(conversation, "username-changed", () => ({}));
  res.json(publicMessage(updated, req.user.id));
});

// Copies a message (text, styles, effects, files) into other chats. The copy
// is marked "Forwarded" and doesn't say who wrote the original.
function duplicateUpload(id) {
  const newId = crypto.randomUUID();
  const from = attachmentPath(id);
  const to = attachmentPath(newId);
  try {
    fs.linkSync(from, to); // instant, no extra disk space
  } catch {
    try {
      fs.copyFileSync(from, to);
    } catch {
      return null;
    }
  }
  return newId;
}

app.post("/api/messages/:id/forward", requireUser, async (req, res) => {
  const message = await getMessage(req.params.id);
  const source = message ? await userInConversation(message.conversation_id, req.user.id) : null;
  if (!message || !source || message.deleted) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if ((await blockedIdsBy(req.user.id)).has(message.sender_id)) {
    res.status(403).json({ error: "You can't forward that message." });
    return;
  }
  const ids = Array.isArray(req.body.conversationIds)
    ? [...new Set(req.body.conversationIds.map(String))].slice(0, 50)
    : [];
  if (!ids.length) {
    res.status(400).json({ error: "Pick at least one chat." });
    return;
  }
  const myBlocks = await blockedIdsBy(req.user.id);
  const blockers = await blockerIdsOf(req.user.id);
  const sent = [];
  const skipped = [];
  for (const id of ids) {
    const conversation = await userInConversation(id, req.user.id);
    if (!conversation) {
      skipped.push(id);
      continue;
    }
    if (conversation.type !== "group") {
      const otherId = conversation.member_ids.find((m) => m !== req.user.id);
      if (myBlocks.has(otherId) || blockers.has(otherId)) {
        skipped.push(id);
        continue;
      }
    }
    // Give the copy its own files so deleting/wiping one never breaks the other.
    const idMap = new Map();
    const attachments = [];
    for (const file of message.attachments || []) {
      const newId = duplicateUpload(file.id);
      if (!newId) continue;
      idMap.set(file.id, newId);
      attachments.push({ ...file, id: newId, role: file.role === "fx" ? "fx" : "file" });
    }
    // Point the copy's effect/crumb/theme at the copied files.
    let fxText = message.fx ? JSON.stringify(message.fx) : null;
    for (const [oldId, newId] of idMap) if (fxText) fxText = fxText.split(oldId).join(newId);
    let fx = fxText ? JSON.parse(fxText) : null;
    if (fx) {
      delete fx.gone;
      delete fx.roulette;
    }
    if (fx && !Object.keys(fx).length) fx = null;
    const copy = await addMessage(conversation.id, req.user.id, message.body || "", attachments, fx, true, {
      originSenderId: message.origin_sender_id || message.sender_id,
    });
    if (fx?.crumb) {
      copy.crumb_state = globalThis.CrumbsEngine.initialState(fx.crumb);
      await setCrumbState(copy.id, copy.crumb_state);
    }
    const copyBlockers = await blockerIdsOf(req.user.id);
    emitToConversation(conversation, "message", (userId) => ({
      conversationId: conversation.id,
      ...publicMessage(copy, userId, copyBlockers.has(userId) ? new Set([req.user.id]) : null),
    }));
    notifyMembers(conversation, copy, copyBlockers).catch(() => {});
    sent.push(conversation.id);
  }
  res.json({ sent, skipped });
});

// Reaction keys: "u:<emoji>" for normal emoji, "c:<fileId>:<name>" for custom ones.
const REACT_UNICODE = /^u:[^\s<>"'`\\]{1,16}$/u;
const REACT_CUSTOM = /^c:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Za-z0-9_]{1,32}$/i;

app.post("/api/messages/:id/react", requireUser, async (req, res) => {
  const key = String(req.body.key || "");
  const message = await getMessage(req.params.id);
  const conversation = message ? await userInConversation(message.conversation_id, req.user.id) : null;
  if (!message || !conversation || message.deleted) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (!REACT_UNICODE.test(key) && !REACT_CUSTOM.test(key)) {
    res.status(400).json({ error: "That reaction isn't valid." });
    return;
  }
  if (key.startsWith("c:") && !(await emojiFileKnown(key.split(":")[1]))) {
    res.status(400).json({ error: "That emoji no longer exists." });
    return;
  }
  const already = (message.reactions || []).some((r) => r.k === key && r.u === req.user.id);
  if (!already && (await countUserReactions(message.id, req.user.id)) >= 20) {
    res.status(400).json({ error: "That's a lot of reactions already." });
    return;
  }
  await toggleReaction(message.id, req.user.id, key);
  const updated = await getMessage(message.id);
  await emitMessageUpdated(conversation, updated);
  res.json(publicMessage(updated, req.user.id));
});

// ---- helpers for message actions ----
async function memberMessage(req, res) {
  const message = await getMessage(req.params.id);
  const conversation = message ? await userInConversation(message.conversation_id, req.user.id) : null;
  if (!message || !conversation || message.deleted || message.fx?.gone) {
    res.status(404).json({ error: "Message not found." });
    return {};
  }
  if (message.scheduled_for && message.sender_id !== req.user.id) {
    res.status(404).json({ error: "Message not found." });
    return {};
  }
  return { message, conversation };
}

// ---- polls ----
app.post("/api/messages/:id/vote", requireUser, async (req, res) => {
  const { message, conversation } = await memberMessage(req, res);
  if (!message) return;
  const poll = message.fx?.poll;
  const option = Number(req.body.option);
  if (!poll || !Number.isInteger(option) || option < 0 || option >= poll.options.length) {
    res.status(400).json({ error: "That's not a poll option." });
    return;
  }
  await setPollVote(message.id, req.user.id, option, poll.multi);
  const updated = await getMessage(message.id);
  await emitMessageUpdated(conversation, updated);
  res.json(publicMessage(updated, req.user.id));
});

// ---- self-destructing messages ----
app.post("/api/messages/:id/viewed", requireUser, async (req, res) => {
  const { message, conversation } = await memberMessage(req, res);
  if (!message) return;
  if (!message.fx?.boom || message.sender_id === req.user.id) {
    res.json({ ok: true });
    return;
  }
  await addView(message.id, req.user.id);
  const updated = await getMessage(message.id);
  const recipients = conversation.member_ids.filter((id) => id !== message.sender_id);
  const seenAll = recipients.every((id) => (updated.views || []).includes(id));
  // Give the viewer time to watch it before the files disappear.
  const finish = async () => {
    if (seenAll) await vanishMessage(message.id);
    const latest = await getMessage(message.id);
    if (latest) await emitMessageUpdated(conversation, latest);
  };
  setTimeout(() => finish().catch(() => {}), (message.fx.boom.secs + 4) * 1000);
  res.json({ ok: true });
});

// ---- stars ----
const STAR_DAILY = 10;
function starDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.WIPE_TIMEZONE || "America/New_York" }).format(date);
}

app.get("/api/stars/me", requireUser, async (req, res) => {
  const used = await starsGivenOn(req.user.id, starDay());
  res.json({ remaining: Math.max(0, STAR_DAILY - used), daily: STAR_DAILY, received: await starsReceived(req.user.id) });
});

app.post("/api/messages/:id/stars", requireUser, async (req, res) => {
  const { message, conversation } = await memberMessage(req, res);
  if (!message) return;
  const stars = Math.round(Number(req.body.stars));
  // Forwarded copies credit whoever wrote the original.
  const receiverId = message.origin_sender_id || message.sender_id;
  if (receiverId === req.user.id) {
    res.status(400).json({ error: "You can't star your own message." });
    return;
  }
  if (!Number.isInteger(stars) || stars < 1 || stars > 10) {
    res.status(400).json({ error: "Pick 1 to 10 stars." });
    return;
  }
  if (await hasStarred(message.id, req.user.id)) {
    res.status(400).json({ error: "You already rated this message." });
    return;
  }
  const day = starDay();
  const remaining = STAR_DAILY - (await starsGivenOn(req.user.id, day));
  if (stars > remaining) {
    res.status(400).json({ error: `You only have ${Math.max(0, remaining)} stars left today.` });
    return;
  }
  await giveStars(message.id, req.user.id, receiverId, stars, day);
  const updated = await getMessage(message.id);
  await emitMessageUpdated(conversation, updated);
  io.to(receiverId).emit("stars-received", { stars, from: req.user.username });
  res.json({ message: publicMessage(updated, req.user.id), remaining: remaining - stars });
});

// ---- themes shared in chat ----
app.post("/api/messages/:id/apply-theme", requireUser, async (req, res) => {
  const { message } = await memberMessage(req, res);
  if (!message) return;
  const theme = message.fx?.theme;
  if (!theme) {
    res.status(400).json({ error: "That message has no theme." });
    return;
  }
  let user = await setThemeColors(req.user.id, theme.p, theme.s);
  if (theme.bg) {
    const copy = duplicateUpload(theme.bg);
    if (copy) {
      const previous = req.user.theme_bg_id;
      user = await setThemeBackground(req.user.id, copy);
      if (previous && previous !== copy) deleteUpload(previous);
    }
  } else if (req.body.clearBackground && req.user.theme_bg_id) {
    const previous = req.user.theme_bg_id;
    user = await setThemeBackground(req.user.id, null);
    deleteUpload(previous);
  }
  res.json({ user: publicUser(user) });
});

// ---- crumbs (interactive cards) ----
const crumbLocks = new Map();
app.post("/api/messages/:id/crumb", requireUser, async (req, res) => {
  const { message, conversation } = await memberMessage(req, res);
  if (!message) return;
  const def = message.fx?.crumb;
  if (!def) {
    res.status(400).json({ error: "That message isn't a crumb." });
    return;
  }
  const event = req.body.event || {};
  if (!["press", "tick"].includes(event.type)) {
    res.status(400).json({ error: "Unknown action." });
    return;
  }
  // One change at a time per crumb so nobody's press gets lost.
  const previous = crumbLocks.get(message.id) || Promise.resolve();
  const job = previous.then(async () => {
    const latest = await getMessage(message.id);
    const current = latest.crumb_state || globalThis.CrumbsEngine.initialState(def, Date.parse(latest.created_at));
    const result = globalThis.CrumbsEngine.apply(def, current, { type: event.type, el: String(event.el || "") }, Date.now());
    if (result.changed) await setCrumbState(message.id, result.state);
    return result;
  });
  crumbLocks.set(message.id, job.catch(() => {}));
  const result = await job;
  const payload = {
    conversationId: conversation.id,
    messageId: message.id,
    state: result.state,
    fired: result.fired,
    by: req.user.username,
    serverNow: Date.now(),
  };
  if (result.changed) emitToConversation(conversation, "crumb", () => payload);
  res.json(payload);
});

// ---- read receipts ----
app.post("/api/conversations/:id/read", requireUser, async (req, res) => {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation) {
    res.status(404).json({ error: "Chat not found." });
    return;
  }
  const at = new Date(String(req.body.at || ""));
  if (Number.isNaN(at.getTime())) {
    res.status(400).json({ error: "Bad time." });
    return;
  }
  const readAt = new Date(Math.min(at.getTime(), Date.now())).toISOString();
  await setRead(conversation.id, req.user.id, readAt);
  emitToConversation(conversation, "read", () => ({
    conversationId: conversation.id,
    username: req.user.username,
    avatarUrl: avatarUrl(req.user.avatar_id),
    at: readAt,
  }));
  res.json({ ok: true });
});

// ---- group roulette ----
app.post("/api/conversations/:id/roulette", requireUser, async (req, res) => {
  const conversation = await userInConversation(req.params.id, req.user.id);
  if (!conversation || conversation.type !== "group") {
    res.status(404).json({ error: "Group not found." });
    return;
  }
  const members = await listMemberProfiles(conversation.id);
  if (members.length < 2) {
    res.status(400).json({ error: "Need at least two people." });
    return;
  }
  const winner = members[crypto.randomInt(members.length)];
  const fx = {
    roulette: {
      names: members.map((m) => m.username),
      colors: members.map((m) => m.name_color || "#6e8070"),
      winner: winner.username,
    },
  };
  const message = await addMessage(
    conversation.id,
    req.user.id,
    `🎲 Roulette picked ${winner.username}`,
    [],
    fx
  );
  await deliverMessage(conversation, message);
  res.status(201).json(publicMessage(message, req.user.id));
});

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
  if (message.deleted) {
    res.status(400).json({ error: "That message was deleted." });
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
  if (Array.isArray(req.files)) removeFiles(req.files);
  else if (req.files) removeFiles(Object.values(req.files).flat());
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
  // "Someone is typing": only relayed to people in that chat.
  const typingOk = new Map();
  socket.on("typing", async (payload) => {
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : null;
    if (!conversationId) return;
    let entry = typingOk.get(conversationId);
    if (!entry || entry.until < Date.now()) {
      const conversation = await userInConversation(conversationId, socket.userId).catch(() => null);
      const user = conversation ? await findUserById(socket.userId) : null;
      entry = { conversation, username: user?.username, until: Date.now() + 60 * 1000 };
      typingOk.set(conversationId, entry);
    }
    if (!entry.conversation) return;
    for (const id of entry.conversation.member_ids || []) {
      if (id === socket.userId) continue;
      io.to(id).emit("typing", { conversationId, username: entry.username });
    }
  });
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

// Scheduled messages go out when their time comes.
async function deliverScheduled() {
  const due = await dueScheduledMessages();
  for (const id of due) {
    await markDelivered(id);
    const message = await getMessage(id);
    if (!message) continue;
    const conversation = await userInConversation(message.conversation_id, message.sender_id);
    if (!conversation) continue;
    await attachReplies([message]);
    await deliverMessage(conversation, message);
  }
}
setInterval(() => deliverScheduled().catch((err) => console.warn("Scheduled send failed:", err.message)), 10 * 1000);
try {
  const moved = await migrateCopiedPacks();
  if (moved) console.log(`Linked ${moved} copied emoji packs back to their creators.`);
} catch (err) {
  console.warn("Emoji pack migration failed:", err.message);
}
await runWipe();
// Make GIFs that were uploaded before looping was added loop too.
setTimeout(() => {
  try {
    let fixed = 0;
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const full = attachmentPath(name);
      const head = Buffer.alloc(3);
      const fd = fs.openSync(full, "r");
      fs.readSync(fd, head, 0, 3, 0);
      fs.closeSync(fd);
      if (head.toString("ascii") === "GIF" && makeGifLoop(full)) fixed += 1;
    }
    if (fixed) console.log(`Checked ${fixed} GIFs so they loop.`);
  } catch (err) {
    console.warn("GIF loop pass failed:", err.message);
  }
}, 5000);
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
