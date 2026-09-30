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
    totalSize: all.reduce((sum, file) => sum + file.size, 0),
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
  if (!pack || pack.owner_id !== req.user.id) {
    res.status(404).json({ error: "Emoji pack not found." });
    return null;
  }
  return pack;
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
  res.json({ pack: publicPack(pack), mine: pack.owner_id === req.user.id });
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
  res.json({ ok: true });
});

app.delete("/api/emoji-packs/:id", requireUser, async (req, res) => {
  const pack = await ownPack(req, res);
  if (!pack) return;
  await deleteEmojiPack(pack.id);
  res.json({ ok: true });
});

app.post("/api/emoji-packs/:id/copy", requireUser, async (req, res) => {
  const pack = await copyEmojiPack(req.params.id, req.user.id);
  if (!pack) {
    res.status(404).json({ error: "That emoji pack no longer exists." });
    return;
  }
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
    res.json({ pack: publicPack(updated), errors });
  }
);

async function ownEmoji(req, res) {
  const emoji = await getEmoji(req.params.id);
  if (!emoji || emoji.owner_id !== req.user.id) {
    res.status(404).json({ error: "Emoji not found." });
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
  res.json({ ok: true });
});

app.delete("/api/emojis/:id", requireUser, async (req, res) => {
  const emoji = await ownEmoji(req, res);
  if (!emoji) return;
  await deleteEmoji(emoji.id);
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
  const messages = await listMessages(conversation.id);
  const blocked = await blockedIdsBy(req.user.id);
  res.json({
    messages: messages.map((message) => publicMessage(message, req.user.id, blocked)),
  });
});

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
    if (req.body.fx) {
      try {
        fx = sanitizeFx(
          JSON.parse(String(req.body.fx)),
          fxFiles.map((file) => file.filename)
        );
      } catch {
        fx = null;
      }
    }
    // Drop fx uploads the effect doesn't actually use.
    const usedFx = fxAssetIds(fx);
    const keptFx = fxFiles.filter((file) => usedFx.has(file.filename));
    removeFiles(fxFiles.filter((file) => !usedFx.has(file.filename)));
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
    ];
    for (const file of attachments) {
      if (file.mime === "image/gif") makeGifLoop(attachmentPath(file.id));
    }
    const message = await addMessage(
      conversation.id,
      req.user.id,
      body,
      attachments,
      fx
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
