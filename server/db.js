import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { startOfCurrentPeriod } from "./calendar.js";

export { nextWipeAt, getWipeInfo, WIPE_TIMEZONE } from "./calendar.js";

export const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const FILE_PATH = path.join(DATA_DIR, "store.json");

let pool = null;
let fileStore = null;

function emptyStore() {
  return {
    users: [],
    conversations: [],
    messages: [],
    blocks: [],
    mutes: [],
    push_subs: [],
    kv: {},
    tasks: [],
    emoji_packs: [],
    emojis: [],
    pack_subs: [],
    reactions: [],
    poll_votes: [],
    message_views: [],
    star_gifts: [],
    conversation_reads: [],
    crumb_state: {},
  };
}

function migrateFileStore() {
  for (const user of fileStore.users) {
    if (!user.avatar_id) user.avatar_id = null;
    if (!user.name_color) user.name_color = "#6e8070";
    if (typeof user.bio !== "string") user.bio = "";
    if (!user.theme_primary) user.theme_primary = null;
    if (!user.theme_secondary) user.theme_secondary = null;
    if (!user.theme_bg_id) user.theme_bg_id = null;
  }
  if (!Array.isArray(fileStore.blocks)) fileStore.blocks = [];
  if (!Array.isArray(fileStore.mutes)) fileStore.mutes = [];
  if (!Array.isArray(fileStore.push_subs)) fileStore.push_subs = [];
  if (!fileStore.kv || typeof fileStore.kv !== "object") fileStore.kv = {};
  if (!Array.isArray(fileStore.tasks)) fileStore.tasks = [];
  if (!Array.isArray(fileStore.emoji_packs)) fileStore.emoji_packs = [];
  if (!Array.isArray(fileStore.emojis)) fileStore.emojis = [];
  if (!Array.isArray(fileStore.pack_subs)) fileStore.pack_subs = [];
  if (!Array.isArray(fileStore.reactions)) fileStore.reactions = [];
  for (const key of ["poll_votes", "message_views", "star_gifts", "conversation_reads"]) {
    if (!Array.isArray(fileStore[key])) fileStore[key] = [];
  }
  if (!fileStore.crumb_state || typeof fileStore.crumb_state !== "object") fileStore.crumb_state = {};
  for (const conversation of fileStore.conversations) {
    if (conversation.created_by === undefined) conversation.created_by = null;
    if (conversation.avatar_id === undefined) conversation.avatar_id = null;
  }
  for (const message of fileStore.messages) {
    if (message.fx === undefined) message.fx = null;
    for (const file of message.attachments || []) {
      if (!file.role) file.role = "file";
    }
  }
  for (const conversation of fileStore.conversations) {
    if (!conversation.type) conversation.type = "dm";
    if (!conversation.title) conversation.title = null;
    if (!Array.isArray(conversation.members)) {
      conversation.members = [conversation.user_low, conversation.user_high].filter(
        Boolean
      );
    }
  }
}

function loadFileStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify(emptyStore(), null, 2));
  }
  fileStore = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  for (const message of fileStore.messages) {
    if (!Array.isArray(message.attachments)) message.attachments = [];
    if (typeof message.pinned !== "boolean") message.pinned = false;
  }
  migrateFileStore();
}

function saveFileStore() {
  const tmp = `${FILE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fileStore, null, 2));
  fs.renameSync(tmp, FILE_PATH);
}

async function pgQuery(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

function previewText(message) {
  if (message.deleted) return "Deleted message";
  if (message.body) return message.body;
  const file = (message.attachments || []).find((item) => (item.role || "file") === "file");
  if (file?.name) return file.name;
  if (message.fx) return "Sent an effect";
  return null;
}

function mapPgMessage(row) {
  const attachments = Array.isArray(row.attachments)
    ? row.attachments
    : typeof row.attachments === "string"
      ? JSON.parse(row.attachments)
      : [];
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    body: row.body,
    created_at: row.created_at,
    pinned: Boolean(row.pinned),
    attachments,
    avatar_id: row.avatar_id || null,
    sender_username: row.sender_username || null,
    name_color: row.name_color || "#6e8070",
    fx: parseFx(row.fx),
    edited_at: row.edited_at || null,
    deleted: Boolean(row.deleted),
    forwarded: Boolean(row.forwarded),
    reactions: jsonList(row.reactions),
    votes: jsonList(row.votes),
    views: jsonList(row.views),
    stars: jsonList(row.stars),
    crumb_state: row.crumb_state ? parseFx(row.crumb_state) : null,
    reply_to: row.reply_to || null,
    origin_sender_id: row.origin_sender_id || null,
    scheduled_for: row.scheduled_for || null,
  };
}

function fileReactions(messageId) {
  return fileStore.reactions
    .filter((r) => r.message_id === messageId)
    .map((r) => ({
      k: r.rkey,
      u: r.user_id,
      n: fileStore.users.find((user) => user.id === r.user_id)?.username || null,
    }));
}

function parseFx(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function initDb() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_low TEXT NOT NULL,
        user_high TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_low, user_high)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        body TEXT NOT NULL,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size BIGINT NOT NULL
      );
    `);
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id TEXT
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS name_color TEXT NOT NULL DEFAULT '#6e8070'
    `);
    await pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'dm'
    `);
    await pool.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      )
    `);
    await pool.query(`
      INSERT INTO conversation_members (conversation_id, user_id)
      SELECT id, user_low FROM conversations
      WHERE user_low IS NOT NULL AND user_low <> ''
      ON CONFLICT DO NOTHING
    `);
    await pool.query(`
      INSERT INTO conversation_members (conversation_id, user_id)
      SELECT id, user_high FROM conversations
      WHERE user_high IS NOT NULL AND user_high <> ''
      ON CONFLICT DO NOTHING
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_primary TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_secondary TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_bg_id TEXT;
      CREATE TABLE IF NOT EXISTS blocks (
        blocker_id TEXT NOT NULL,
        blocked_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (blocker_id, blocked_id)
      );
      CREATE TABLE IF NOT EXISTS mutes (
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        keys TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_message ON attachments (message_id);
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_id TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS fx TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE attachments ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'file';
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'check',
        done BOOLEAN NOT NULL DEFAULT FALSE,
        percent INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks (conversation_id);
      CREATE TABLE IF NOT EXISTS emoji_packs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS emojis (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        name TEXT NOT NULL,
        file_id TEXT NOT NULL,
        mime TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS emojis_pack ON emojis (pack_id);
      CREATE TABLE IF NOT EXISTS emoji_pack_users (
        user_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, pack_id)
      );
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        rkey TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id, rkey)
      );
      CREATE INDEX IF NOT EXISTS reactions_message ON reactions (message_id);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin_sender_id TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS poll_votes (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        option INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, option)
      );
      CREATE TABLE IF NOT EXISTS message_views (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS star_gifts (
        message_id TEXT NOT NULL,
        giver_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        stars INTEGER NOT NULL,
        day TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, giver_id)
      );
      CREATE INDEX IF NOT EXISTS star_gifts_receiver ON star_gifts (receiver_id);
      CREATE INDEX IF NOT EXISTS star_gifts_giver_day ON star_gifts (giver_id, day);
      CREATE TABLE IF NOT EXISTS conversation_reads (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        read_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS crumb_state (
        message_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS messages_conv_created
        ON messages (conversation_id, created_at)
    `);
    console.log("Using PostgreSQL (survives restarts and deploys)");
    return;
  }

  loadFileStore();
  console.log(`Using file store at ${FILE_PATH}`);
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATABASE_URL) {
    console.warn(
      "Railway is running without DATABASE_URL. Add a PostgreSQL database so accounts and messages survive deploys."
    );
  }
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.warn(
      "Railway has no volume mounted. Add a volume so uploaded files survive deploys."
    );
  }
}

export async function closeDb() {
  if (fileStore) saveFileStore();
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function pairIds(a, b) {
  return a < b ? [a, b] : [b, a];
}

export async function createUser(username, passwordHash) {
  const id = randomUUID();
  const usernameLower = username.toLowerCase();
  if (pool) {
    try {
      await pgQuery(
        `INSERT INTO users (id, username, username_lower, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [id, username, usernameLower, passwordHash]
      );
    } catch (err) {
      if (err.code === "23505") {
        const conflict = new Error("Username taken");
        conflict.status = 409;
        throw conflict;
      }
      throw err;
    }
  } else {
    if (fileStore.users.some((user) => user.username_lower === usernameLower)) {
      const conflict = new Error("Username taken");
      conflict.status = 409;
      throw conflict;
    }
    fileStore.users.push({
      id,
      username,
      username_lower: usernameLower,
      password_hash: passwordHash,
      avatar_id: null,
      name_color: "#6e8070",
      bio: "",
      theme_primary: null,
      theme_secondary: null,
      theme_bg_id: null,
      created_at: new Date().toISOString(),
    });
    saveFileStore();
  }
  return { id, username };
}

export async function findUserByUsername(username) {
  const usernameLower = username.toLowerCase();
  if (pool) {
    const rows = await pgQuery(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username_lower = $1`,
      [usernameLower]
    );
    return rows[0] ? { ...shapeUser(rows[0]), password_hash: rows[0].password_hash } : null;
  }
  const user = fileStore.users.find((item) => item.username_lower === usernameLower);
  return user ? { ...shapeUser(user), password_hash: user.password_hash } : null;
}

const USER_COLUMNS =
  "id, username, avatar_id, name_color, bio, theme_primary, theme_secondary, theme_bg_id";

function shapeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatar_id: user.avatar_id || null,
    name_color: user.name_color || "#6e8070",
    bio: user.bio || "",
    theme_primary: user.theme_primary || null,
    theme_secondary: user.theme_secondary || null,
    theme_bg_id: user.theme_bg_id || null,
  };
}

export async function findUserById(id) {
  if (pool) {
    const rows = await pgQuery(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return shapeUser(rows[0]);
  }
  return shapeUser(fileStore.users.find((item) => item.id === id));
}

export async function updateUsername(id, username) {
  const usernameLower = username.toLowerCase();
  if (pool) {
    try {
      await pgQuery(
        `UPDATE users SET username = $1, username_lower = $2 WHERE id = $3`,
        [username, usernameLower, id]
      );
      return findUserById(id);
    } catch (err) {
      if (err.code === "23505") {
        const conflict = new Error("Username taken");
        conflict.status = 409;
        throw conflict;
      }
      throw err;
    }
  }
  if (
    fileStore.users.some(
      (user) => user.username_lower === usernameLower && user.id !== id
    )
  ) {
    const conflict = new Error("Username taken");
    conflict.status = 409;
    throw conflict;
  }
  const user = fileStore.users.find((item) => item.id === id);
  if (!user) return null;
  user.username = username;
  user.username_lower = usernameLower;
  saveFileStore();
  return shapeUser(user);
}

export async function searchUsers(query, excludeId) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  if (pool) {
    return pgQuery(
      `SELECT id, username, avatar_id, name_color FROM users
       WHERE username_lower LIKE $1 AND id <> $2
       ORDER BY username
       LIMIT 12`,
      [`%${needle}%`, excludeId]
    );
  }
  return fileStore.users
    .filter(
      (user) =>
        user.id !== excludeId && user.username_lower.includes(needle)
    )
    .slice(0, 12)
    .map((user) => ({
      id: user.id,
      username: user.username,
      avatar_id: user.avatar_id || null,
      name_color: user.name_color || "#6e8070",
    }));
}

export async function getOrCreateConversation(userId, otherUserId) {
  const [userLow, userHigh] = pairIds(userId, otherUserId);
  if (pool) {
    const existing = await pgQuery(
      `SELECT id FROM conversations WHERE user_low = $1 AND user_high = $2`,
      [userLow, userHigh]
    );
    if (existing[0]) return existing[0];
    const id = randomUUID();
    await pgQuery(
      `INSERT INTO conversations (id, user_low, user_high, type) VALUES ($1, $2, $3, 'dm')`,
      [id, userLow, userHigh]
    );
    await pgQuery(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
      [id, userLow, userHigh]
    );
    return { id };
  }
  let conversation = fileStore.conversations.find(
    (item) => item.user_low === userLow && item.user_high === userHigh
  );
  if (!conversation) {
    conversation = {
      id: randomUUID(),
      user_low: userLow,
      user_high: userHigh,
      type: "dm",
      title: null,
      members: [userLow, userHigh],
      created_at: new Date().toISOString(),
    };
    fileStore.conversations.push(conversation);
    saveFileStore();
  }
  return { id: conversation.id };
}

export async function userInConversation(conversationId, userId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT id, user_low, user_high, type, title, created_by, avatar_id
       FROM conversations WHERE id = $1`,
      [conversationId]
    );
    const conversation = rows[0];
    if (!conversation) return null;
    const members = await pgQuery(
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
      [conversationId]
    );
    const memberIds = members.map((row) => row.user_id);
    const inPair =
      conversation.user_low === userId || conversation.user_high === userId;
    if (!inPair && !memberIds.includes(userId)) return null;
    return {
      ...conversation,
      type: conversation.type || "dm",
      member_ids: memberIds.length
        ? memberIds
        : [conversation.user_low, conversation.user_high].filter(Boolean),
    };
  }
  const conversation = fileStore.conversations.find(
    (item) => item.id === conversationId
  );
  if (!conversation) return null;
  const memberIds = conversation.members || [
    conversation.user_low,
    conversation.user_high,
  ];
  if (!memberIds.includes(userId)) return null;
  return {
    ...conversation,
    type: conversation.type || "dm",
    member_ids: memberIds,
  };
}

async function attachmentsFor(messageId) {
  if (pool) {
    return pgQuery(
      `SELECT id, name, mime, size, role FROM attachments WHERE message_id = $1 ORDER BY name`,
      [messageId]
    );
  }
  const message = fileStore.messages.find((item) => item.id === messageId);
  return message?.attachments || [];
}

export async function listConversations(userId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT
         c.id,
         c.type,
         c.title,
         c.user_low,
         c.user_high,
         c.created_by,
         c.avatar_id,
         (
           SELECT COALESCE(
             CASE WHEN m.deleted THEN 'Deleted message' END,
             NULLIF(m.body, ''),
             (SELECT a.name FROM attachments a WHERE a.message_id = m.id AND a.role = 'file' LIMIT 1),
             CASE WHEN m.fx IS NOT NULL THEN 'Sent an effect' END
           )
           FROM messages m
           WHERE m.conversation_id = c.id AND m.scheduled_for IS NULL
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_message,
         (
           SELECT m.created_at FROM messages m
           WHERE m.conversation_id = c.id AND m.scheduled_for IS NULL
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_at
       FROM conversations c
       WHERE EXISTS (
         SELECT 1 FROM conversation_members cm
         WHERE cm.conversation_id = c.id AND cm.user_id = $1
       )
       OR c.user_low = $1 OR c.user_high = $1
       ORDER BY COALESCE(
         (SELECT m.created_at FROM messages m
          WHERE m.conversation_id = c.id AND m.scheduled_for IS NULL
          ORDER BY m.created_at DESC LIMIT 1),
         c.created_at
       ) DESC`,
      [userId]
    );
    const result = [];
    for (const row of rows) {
      const members = await listMemberProfiles(row.id);
      const isGroup = (row.type || "dm") === "group";
      const other = members.find((member) => member.id !== userId);
      result.push({
        id: row.id,
        type: isGroup ? "group" : "dm",
        title: isGroup ? row.title || "Group" : other?.username || "Unknown",
        other_username: isGroup ? row.title || "Group" : other?.username || "Unknown",
        other_avatar_id: isGroup ? row.avatar_id || null : other?.avatar_id || null,
        created_by: row.created_by || null,
        last_message: row.last_message,
        last_at: row.last_at,
        members,
      });
    }
    return result;
  }

  const usersById = new Map(fileStore.users.map((user) => [user.id, user]));
  return fileStore.conversations
    .filter((item) => {
      const members = item.members || [item.user_low, item.user_high];
      return members.includes(userId);
    })
    .map((item) => {
      const memberIds = item.members || [item.user_low, item.user_high];
      const members = memberIds.map((id) => {
        const user = usersById.get(id);
        return {
          id,
          username: user?.username || "Unknown",
          avatar_id: user?.avatar_id || null,
          name_color: user?.name_color || "#6e8070",
        };
      });
      const isGroup = item.type === "group";
      const other = members.find((member) => member.id !== userId);
      const messages = fileStore.messages
        .filter((message) => message.conversation_id === item.id && !message.scheduled_for)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const last = messages[messages.length - 1];
      return {
        id: item.id,
        type: isGroup ? "group" : "dm",
        title: isGroup ? item.title || "Group" : other?.username || "Unknown",
        other_username: isGroup ? item.title || "Group" : other?.username || "Unknown",
        other_avatar_id: isGroup ? item.avatar_id || null : other?.avatar_id || null,
        created_by: item.created_by || null,
        last_message: last ? previewText(last) : null,
        last_at: last ? last.created_at : item.created_at,
        members,
      };
    })
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}

// Extra per-message data (reactions, poll votes, views, stars, crumb state).
const EXTRA_COLS = `
  m.reply_to,
  m.origin_sender_id,
  m.scheduled_for,
  (SELECT COALESCE(json_agg(json_build_object('k', r.rkey, 'u', r.user_id, 'n', ru.username) ORDER BY r.created_at), '[]')
     FROM reactions r LEFT JOIN users ru ON ru.id = r.user_id WHERE r.message_id = m.id) AS reactions,
  (SELECT COALESCE(json_agg(json_build_object('o', v.option, 'u', v.user_id, 'n', vu.username)), '[]')
     FROM poll_votes v LEFT JOIN users vu ON vu.id = v.user_id WHERE v.message_id = m.id) AS votes,
  (SELECT COALESCE(json_agg(w.user_id), '[]') FROM message_views w WHERE w.message_id = m.id) AS views,
  (SELECT COALESCE(json_agg(json_build_object('u', g.giver_id, 'n', gu.username, 's', g.stars)), '[]')
     FROM star_gifts g LEFT JOIN users gu ON gu.id = g.giver_id WHERE g.message_id = m.id) AS stars,
  (SELECT cs.state FROM crumb_state cs WHERE cs.message_id = m.id) AS crumb_state`;

function jsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

function fileExtras(message) {
  const name = (id) => fileStore.users.find((user) => user.id === id)?.username || null;
  return {
    reply_to: message.reply_to || null,
    origin_sender_id: message.origin_sender_id || null,
    scheduled_for: message.scheduled_for || null,
    reactions: fileReactions(message.id),
    votes: fileStore.poll_votes
      .filter((v) => v.message_id === message.id)
      .map((v) => ({ o: v.option, u: v.user_id, n: name(v.user_id) })),
    views: fileStore.message_views.filter((v) => v.message_id === message.id).map((v) => v.user_id),
    stars: fileStore.star_gifts
      .filter((g) => g.message_id === message.id)
      .map((g) => ({ u: g.giver_id, n: name(g.giver_id), s: g.stars })),
    crumb_state: fileStore.crumb_state[message.id] || null,
  };
}

export async function listMessages(conversationId, viewerId = null) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT
         m.id,
         m.conversation_id,
         m.sender_id,
         m.body,
         m.pinned,
         m.created_at,
         m.fx,
         m.edited_at,
         m.deleted,
         m.forwarded,
         ${EXTRA_COLS},
         u.avatar_id,
         u.username AS sender_username,
         u.name_color,
         COALESCE(
           json_agg(
             json_build_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size, 'role', a.role)
             ORDER BY a.name
           ) FILTER (WHERE a.id IS NOT NULL),
           '[]'
         ) AS attachments
       FROM messages m
       LEFT JOIN attachments a ON a.message_id = m.id
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1
         AND (m.scheduled_for IS NULL OR m.sender_id = $2)
       GROUP BY m.id, u.avatar_id, u.username, u.name_color
       ORDER BY COALESCE(m.scheduled_for, m.created_at) ASC`,
      [conversationId, viewerId || ""]
    );
    return rows.map(mapPgMessage);
  }
  return fileStore.messages
    .filter(
      (message) =>
        message.conversation_id === conversationId &&
        (!message.scheduled_for || message.sender_id === viewerId)
    )
    .sort((a, b) =>
      String(a.scheduled_for || a.created_at).localeCompare(String(b.scheduled_for || b.created_at))
    )
    .map((message) => {
      const sender = fileStore.users.find((user) => user.id === message.sender_id);
      return {
        id: message.id,
        conversation_id: message.conversation_id,
        sender_id: message.sender_id,
        body: message.body,
        created_at: message.created_at,
        pinned: Boolean(message.pinned),
        attachments: message.attachments || [],
        avatar_id: sender?.avatar_id || null,
        sender_username: sender?.username || null,
        name_color: sender?.name_color || "#6e8070",
        fx: message.fx || null,
        edited_at: message.edited_at || null,
        deleted: Boolean(message.deleted),
        forwarded: Boolean(message.forwarded),
        ...fileExtras(message),
      };
    });
}

export async function addMessage(
  conversationId,
  senderId,
  body,
  attachments = [],
  fx = null,
  forwarded = false,
  options = {}
) {
  const replyTo = options.replyTo || null;
  const originSenderId = options.originSenderId || null;
  const scheduledFor = options.scheduledFor || null;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const files = attachments.map((file) => ({
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: Number(file.size) || 0,
    role: file.role === "fx" ? "fx" : "file",
  }));
  if (pool) {
    await pgQuery(
      `INSERT INTO messages (id, conversation_id, sender_id, body, pinned, fx, forwarded, reply_to, scheduled_for, origin_sender_id)
       VALUES ($1, $2, $3, $4, FALSE, $5, $6, $7, $8, $9)`,
      [
        id,
        conversationId,
        senderId,
        body,
        fx ? JSON.stringify(fx) : null,
        Boolean(forwarded),
        replyTo,
        scheduledFor,
        originSenderId,
      ]
    );
    for (const file of files) {
      await pgQuery(
        `INSERT INTO attachments (id, message_id, name, mime, size, role)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [file.id, id, file.name, file.mime, file.size, file.role]
      );
    }
    const sender = await findUserById(senderId);
    return {
      id,
      conversation_id: conversationId,
      sender_id: senderId,
      body,
      created_at: createdAt,
      pinned: false,
      attachments: files,
      avatar_id: sender?.avatar_id || null,
      sender_username: sender?.username || null,
      name_color: sender?.name_color || "#6e8070",
      fx,
      forwarded: Boolean(forwarded),
      reply_to: replyTo,
      origin_sender_id: originSenderId,
      scheduled_for: scheduledFor,
      reactions: [],
      votes: [],
      views: [],
      stars: [],
      crumb_state: null,
    };
  }
  const sender = fileStore.users.find((user) => user.id === senderId);
  const message = {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    body,
    created_at: createdAt,
    pinned: false,
    attachments: files,
    fx,
    forwarded: Boolean(forwarded),
    reply_to: replyTo,
    origin_sender_id: originSenderId,
    scheduled_for: scheduledFor,
  };
  fileStore.messages.push(message);
  saveFileStore();
  return {
    ...message,
    avatar_id: sender?.avatar_id || null,
    sender_username: sender?.username || null,
    name_color: sender?.name_color || "#6e8070",
    ...fileExtras(message),
  };
}

export async function getMessage(messageId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.pinned, m.created_at, m.fx, m.edited_at, m.deleted, m.forwarded,
              ${EXTRA_COLS},
              u.avatar_id, u.username AS sender_username, u.name_color
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [messageId]
    );
    if (!rows[0]) return null;
    return mapPgMessage({
      ...rows[0],
      attachments: await attachmentsFor(messageId),
    });
  }
  const message = fileStore.messages.find((item) => item.id === messageId);
  if (!message) return null;
  const sender = fileStore.users.find((user) => user.id === message.sender_id);
  return {
    ...message,
    pinned: Boolean(message.pinned),
    attachments: message.attachments || [],
    avatar_id: sender?.avatar_id || null,
    sender_username: sender?.username || null,
    name_color: sender?.name_color || "#6e8070",
    ...fileExtras(message),
  };
}

export async function setPinned(messageId, pinned) {
  if (pool) {
    await pgQuery(`UPDATE messages SET pinned = $1 WHERE id = $2`, [
      pinned,
      messageId,
    ]);
  } else {
    const message = fileStore.messages.find((item) => item.id === messageId);
    if (message) {
      message.pinned = pinned;
      saveFileStore();
    }
  }
  return getMessage(messageId);
}

export async function getAttachment(attachmentId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT a.id, a.name, a.mime, a.size, m.conversation_id
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.id = $1`,
      [attachmentId]
    );
    return rows[0] || null;
  }
  for (const message of fileStore.messages) {
    const file = (message.attachments || []).find((item) => item.id === attachmentId);
    if (file) {
      return {
        ...file,
        conversation_id: message.conversation_id,
      };
    }
  }
  return null;
}

export function attachmentPath(attachmentId) {
  return path.join(UPLOAD_DIR, attachmentId);
}

function removeStoredFileCounted(attachmentId) {
  const file = attachmentPath(attachmentId);
  try {
    const { size } = fs.statSync(file);
    fs.unlinkSync(file);
    return size;
  } catch {
    return 0;
  }
}

// Deletes unpinned messages from before the current 14-day period, along with
// their attachment rows and the files on disk. Conversations, accounts and
// pinned messages are left alone.
export async function wipeExpiredMessages(now = new Date()) {
  const cutoff = startOfCurrentPeriod(now).toISOString();
  let removedFiles = [];
  let removedMessages = 0;
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query(
        `DELETE FROM messages WHERE pinned = FALSE AND scheduled_for IS NULL AND created_at < $1 RETURNING id`,
        [cutoff]
      );
      removedMessages = expired.rowCount;
      // Also catches attachment rows whose message was already gone.
      const files = await client.query(
        `DELETE FROM attachments a
         WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id)
         RETURNING a.id`
      );
      removedFiles = files.rows;
      for (const table of ["reactions", "poll_votes", "message_views", "crumb_state"]) {
        await client.query(
          `DELETE FROM ${table} x WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = x.message_id)`
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } else {
    const keep = [];
    for (const message of fileStore.messages) {
      if (!message.pinned && !message.scheduled_for && message.created_at < cutoff) {
        removedMessages += 1;
        for (const file of message.attachments || []) {
          removedFiles.push({ id: file.id });
        }
      } else {
        keep.push(message);
      }
    }
    if (removedMessages) {
      fileStore.messages = keep;
      const alive = new Set(keep.map((message) => message.id));
      fileStore.reactions = fileStore.reactions.filter((r) => alive.has(r.message_id));
      fileStore.poll_votes = fileStore.poll_votes.filter((r) => alive.has(r.message_id));
      fileStore.message_views = fileStore.message_views.filter((r) => alive.has(r.message_id));
      for (const id of Object.keys(fileStore.crumb_state)) {
        if (!alive.has(id)) delete fileStore.crumb_state[id];
      }
      saveFileStore();
    }
  }
  let bytes = 0;
  for (const file of removedFiles) {
    bytes += removeStoredFileCounted(file.id);
  }
  return { messages: removedMessages, files: removedFiles.length, bytes, cutoff };
}

async function referencedFileIds() {
  const ids = new Set();
  if (pool) {
    for (const row of await pgQuery(`SELECT id FROM attachments`)) ids.add(row.id);
    for (const row of await pgQuery(
      `SELECT avatar_id, theme_bg_id FROM users
       WHERE avatar_id IS NOT NULL OR theme_bg_id IS NOT NULL`
    )) {
      if (row.avatar_id) ids.add(row.avatar_id);
      if (row.theme_bg_id) ids.add(row.theme_bg_id);
    }
    for (const row of await pgQuery(
      `SELECT avatar_id FROM conversations WHERE avatar_id IS NOT NULL`
    )) {
      ids.add(row.avatar_id);
    }
    for (const row of await pgQuery(`SELECT DISTINCT file_id FROM emojis`)) {
      ids.add(row.file_id);
    }
    return ids;
  }
  for (const message of fileStore.messages) {
    for (const file of message.attachments || []) ids.add(file.id);
  }
  for (const user of fileStore.users) {
    if (user.avatar_id) ids.add(user.avatar_id);
    if (user.theme_bg_id) ids.add(user.theme_bg_id);
  }
  for (const conversation of fileStore.conversations) {
    if (conversation.avatar_id) ids.add(conversation.avatar_id);
  }
  for (const emoji of fileStore.emojis) ids.add(emoji.file_id);
  return ids;
}

// Deletes anything in the uploads folder that nothing points to any more
// (failed uploads, replaced pictures, leftovers). Files younger than
// minAgeMs are skipped so uploads still in progress are never touched.
export async function sweepOrphanFiles(minAgeMs = 60 * 60 * 1000) {
  const referenced = await referencedFileIds();
  let files = 0;
  let bytes = 0;
  let names = [];
  try {
    names = fs.readdirSync(UPLOAD_DIR);
  } catch {
    return { files, bytes };
  }
  const now = Date.now();
  for (const name of names) {
    if (referenced.has(name)) continue;
    const full = path.join(UPLOAD_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || now - stat.mtimeMs < minAgeMs) continue;
      fs.unlinkSync(full);
      files += 1;
      bytes += stat.size;
    } catch {
      // gone or busy; try again next sweep
    }
  }
  return { files, bytes };
}

export function uploadDirUsage() {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      try {
        const stat = fs.statSync(path.join(UPLOAD_DIR, name));
        if (stat.isFile()) {
          files += 1;
          bytes += stat.size;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // no folder yet
  }
  return { files, bytes };
}

export async function listMemberProfiles(conversationId) {
  if (pool) {
    return pgQuery(
      `SELECT u.id, u.username, u.avatar_id, u.name_color
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = $1
       ORDER BY u.username`,
      [conversationId]
    );
  }
  const conversation = fileStore.conversations.find(
    (item) => item.id === conversationId
  );
  if (!conversation) return [];
  const ids = conversation.members || [
    conversation.user_low,
    conversation.user_high,
  ];
  return ids.map((id) => {
    const user = fileStore.users.find((item) => item.id === id);
    return {
      id,
      username: user?.username || "Unknown",
      avatar_id: user?.avatar_id || null,
      name_color: user?.name_color || "#6e8070",
    };
  });
}

export async function setUserAvatar(userId, avatarId) {
  if (pool) {
    await pgQuery(`UPDATE users SET avatar_id = $1 WHERE id = $2`, [avatarId, userId]);
    return findUserById(userId);
  }
  const user = fileStore.users.find((item) => item.id === userId);
  if (!user) return null;
  user.avatar_id = avatarId;
  saveFileStore();
  return shapeUser(user);
}

export async function setUserColor(userId, color) {
  if (pool) {
    await pgQuery(`UPDATE users SET name_color = $1 WHERE id = $2`, [color, userId]);
    return findUserById(userId);
  }
  const user = fileStore.users.find((item) => item.id === userId);
  if (!user) return null;
  user.name_color = color;
  saveFileStore();
  return shapeUser(user);
}

export async function getAvatarOwner(avatarId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT id FROM users WHERE avatar_id = $1
       UNION ALL
       SELECT id FROM conversations WHERE avatar_id = $1
       LIMIT 1`,
      [avatarId]
    );
    return rows[0] || null;
  }
  return (
    fileStore.users.find((user) => user.avatar_id === avatarId) ||
    fileStore.conversations.find((item) => item.avatar_id === avatarId) ||
    null
  );
}

export async function createGroup(title, memberIds, createdBy = null) {
  const id = randomUUID();
  const unique = [...new Set(memberIds)];
  if (pool) {
    await pgQuery(
      `INSERT INTO conversations (id, user_low, user_high, type, title, created_by)
       VALUES ($1, $2, $3, 'group', $4, $5)`,
      [id, "__group__", id, title, createdBy]
    );
    for (const userId of unique) {
      await pgQuery(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, userId]
      );
    }
  } else {
    fileStore.conversations.push({
      id,
      user_low: "__group__",
      user_high: id,
      type: "group",
      title,
      created_by: createdBy,
      avatar_id: null,
      members: unique,
      created_at: new Date().toISOString(),
    });
    saveFileStore();
  }
  return { id, title, type: "group" };
}

export async function addGroupMember(conversationId, userId) {
  if (pool) {
    await pgQuery(
      `INSERT INTO conversation_members (conversation_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [conversationId, userId]
    );
    return;
  }
  const conversation = fileStore.conversations.find(
    (item) => item.id === conversationId
  );
  if (!conversation) return;
  conversation.members = conversation.members || [];
  if (!conversation.members.includes(userId)) conversation.members.push(userId);
  saveFileStore();
}


export async function setBio(userId, bio) {
  if (pool) {
    await pgQuery(`UPDATE users SET bio = $1 WHERE id = $2`, [bio, userId]);
    return findUserById(userId);
  }
  const user = fileStore.users.find((item) => item.id === userId);
  if (!user) return null;
  user.bio = bio;
  saveFileStore();
  return shapeUser(user);
}

export async function setThemeColors(userId, primary, secondary) {
  if (pool) {
    await pgQuery(
      `UPDATE users SET theme_primary = $1, theme_secondary = $2 WHERE id = $3`,
      [primary, secondary, userId]
    );
    return findUserById(userId);
  }
  const user = fileStore.users.find((item) => item.id === userId);
  if (!user) return null;
  user.theme_primary = primary;
  user.theme_secondary = secondary;
  saveFileStore();
  return shapeUser(user);
}

export async function setThemeBackground(userId, backgroundId) {
  if (pool) {
    await pgQuery(`UPDATE users SET theme_bg_id = $1 WHERE id = $2`, [
      backgroundId,
      userId,
    ]);
    return findUserById(userId);
  }
  const user = fileStore.users.find((item) => item.id === userId);
  if (!user) return null;
  user.theme_bg_id = backgroundId;
  saveFileStore();
  return shapeUser(user);
}

// ---- blocking ----

export async function setBlocked(blockerId, blockedId, blocked) {
  if (pool) {
    if (blocked) {
      await pgQuery(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [blockerId, blockedId]
      );
    } else {
      await pgQuery(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
        blockerId,
        blockedId,
      ]);
    }
    return;
  }
  fileStore.blocks = fileStore.blocks.filter(
    (row) => !(row.blocker_id === blockerId && row.blocked_id === blockedId)
  );
  if (blocked) fileStore.blocks.push({ blocker_id: blockerId, blocked_id: blockedId });
  saveFileStore();
}

// Ids this user has blocked.
export async function blockedIdsBy(userId) {
  if (pool) {
    const rows = await pgQuery(`SELECT blocked_id FROM blocks WHERE blocker_id = $1`, [
      userId,
    ]);
    return new Set(rows.map((row) => row.blocked_id));
  }
  return new Set(
    fileStore.blocks.filter((row) => row.blocker_id === userId).map((row) => row.blocked_id)
  );
}

// Ids of people who have blocked this user.
export async function blockerIdsOf(userId) {
  if (pool) {
    const rows = await pgQuery(`SELECT blocker_id FROM blocks WHERE blocked_id = $1`, [
      userId,
    ]);
    return new Set(rows.map((row) => row.blocker_id));
  }
  return new Set(
    fileStore.blocks.filter((row) => row.blocked_id === userId).map((row) => row.blocker_id)
  );
}

export async function listBlockedUsers(userId) {
  const ids = [...(await blockedIdsBy(userId))];
  const users = [];
  for (const id of ids) {
    const user = await findUserById(id);
    if (user) users.push(user);
  }
  return users.sort((a, b) => a.username.localeCompare(b.username));
}

// ---- muting (per conversation) ----

export async function setMuted(userId, conversationId, muted) {
  if (pool) {
    if (muted) {
      await pgQuery(
        `INSERT INTO mutes (user_id, conversation_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, conversationId]
      );
    } else {
      await pgQuery(`DELETE FROM mutes WHERE user_id = $1 AND conversation_id = $2`, [
        userId,
        conversationId,
      ]);
    }
    return;
  }
  fileStore.mutes = fileStore.mutes.filter(
    (row) => !(row.user_id === userId && row.conversation_id === conversationId)
  );
  if (muted) fileStore.mutes.push({ user_id: userId, conversation_id: conversationId });
  saveFileStore();
}

export async function mutedConversationIds(userId) {
  if (pool) {
    const rows = await pgQuery(`SELECT conversation_id FROM mutes WHERE user_id = $1`, [
      userId,
    ]);
    return new Set(rows.map((row) => row.conversation_id));
  }
  return new Set(
    fileStore.mutes.filter((row) => row.user_id === userId).map((row) => row.conversation_id)
  );
}

// ---- pinned messages across every chat the user is in ----

export async function listPinnedForUser(userId) {
  const conversations = await listConversations(userId);
  const result = [];
  for (const conversation of conversations) {
    const messages = await listMessages(conversation.id);
    for (const message of messages) {
      if (message.pinned) result.push({ conversation, message });
    }
  }
  const time = (value) => new Date(value).getTime();
  result.sort((a, b) => time(b.message.created_at) - time(a.message.created_at));
  return result;
}

// ---- web push subscriptions ----

export async function savePushSubscription(userId, subscription) {
  const endpoint = subscription.endpoint;
  const keys = JSON.stringify(subscription.keys || {});
  if (pool) {
    await pgQuery(
      `INSERT INTO push_subscriptions (endpoint, user_id, keys) VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys`,
      [endpoint, userId, keys]
    );
    return;
  }
  fileStore.push_subs = fileStore.push_subs.filter((row) => row.endpoint !== endpoint);
  fileStore.push_subs.push({ endpoint, user_id: userId, keys });
  saveFileStore();
}

export async function removePushSubscription(endpoint) {
  if (pool) {
    await pgQuery(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    return;
  }
  const before = fileStore.push_subs.length;
  fileStore.push_subs = fileStore.push_subs.filter((row) => row.endpoint !== endpoint);
  if (fileStore.push_subs.length !== before) saveFileStore();
}

export async function pushSubscriptionsFor(userId) {
  const rows = pool
    ? await pgQuery(`SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1`, [
        userId,
      ])
    : fileStore.push_subs.filter((row) => row.user_id === userId);
  return rows.map((row) => ({ endpoint: row.endpoint, keys: JSON.parse(row.keys) }));
}

// ---- small key/value store (VAPID keys etc.) ----

export async function kvGet(key) {
  if (pool) {
    const rows = await pgQuery(`SELECT value FROM app_kv WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  }
  return fileStore.kv[key] ?? null;
}

export async function kvSet(key, value) {
  if (pool) {
    await pgQuery(
      `INSERT INTO app_kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
    return;
  }
  fileStore.kv[key] = value;
  saveFileStore();
}

// ---- group chats ----

export async function renameGroup(conversationId, title) {
  if (pool) {
    await pgQuery(`UPDATE conversations SET title = $1 WHERE id = $2`, [title, conversationId]);
    return;
  }
  const conversation = fileStore.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  conversation.title = title;
  saveFileStore();
}

export async function setGroupAvatar(conversationId, avatarId) {
  if (pool) {
    await pgQuery(`UPDATE conversations SET avatar_id = $1 WHERE id = $2`, [
      avatarId,
      conversationId,
    ]);
    return;
  }
  const conversation = fileStore.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  conversation.avatar_id = avatarId;
  saveFileStore();
}

export async function setGroupCreator(conversationId, userId) {
  if (pool) {
    await pgQuery(`UPDATE conversations SET created_by = $1 WHERE id = $2`, [
      userId,
      conversationId,
    ]);
    return;
  }
  const conversation = fileStore.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  conversation.created_by = userId;
  saveFileStore();
}

export async function removeGroupMember(conversationId, userId) {
  if (pool) {
    await pgQuery(
      `DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    await pgQuery(`DELETE FROM mutes WHERE conversation_id = $1 AND user_id = $2`, [
      conversationId,
      userId,
    ]);
    return;
  }
  const conversation = fileStore.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  conversation.members = (conversation.members || []).filter((id) => id !== userId);
  fileStore.mutes = fileStore.mutes.filter(
    (row) => !(row.user_id === userId && row.conversation_id === conversationId)
  );
  saveFileStore();
}

// Removes a whole conversation with its messages, tasks and files.
export async function deleteConversation(conversationId) {
  const fileIds = [];
  if (pool) {
    const files = await pgQuery(
      `SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.conversation_id = $1`,
      [conversationId]
    );
    fileIds.push(...files.map((row) => row.id));
    const conv = await pgQuery(`SELECT avatar_id FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
    if (conv[0]?.avatar_id) fileIds.push(conv[0].avatar_id);
    await pgQuery(
      `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`,
      [conversationId]
    );
    await pgQuery(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
    await pgQuery(`DELETE FROM tasks WHERE conversation_id = $1`, [conversationId]);
    await pgQuery(`DELETE FROM mutes WHERE conversation_id = $1`, [conversationId]);
    await pgQuery(`DELETE FROM conversation_members WHERE conversation_id = $1`, [
      conversationId,
    ]);
    await pgQuery(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  } else {
    const conversation = fileStore.conversations.find((item) => item.id === conversationId);
    if (conversation?.avatar_id) fileIds.push(conversation.avatar_id);
    for (const message of fileStore.messages) {
      if (message.conversation_id !== conversationId) continue;
      for (const file of message.attachments || []) fileIds.push(file.id);
    }
    fileStore.messages = fileStore.messages.filter(
      (message) => message.conversation_id !== conversationId
    );
    fileStore.tasks = fileStore.tasks.filter((task) => task.conversation_id !== conversationId);
    fileStore.mutes = fileStore.mutes.filter((row) => row.conversation_id !== conversationId);
    fileStore.conversations = fileStore.conversations.filter(
      (item) => item.id !== conversationId
    );
    saveFileStore();
  }
  for (const id of fileIds) {
    try {
      fs.unlinkSync(attachmentPath(id));
    } catch {
      // already gone
    }
  }
}

// ---- tasks (group chats; never wiped) ----

function shapeTask(row) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    title: row.title,
    kind: row.kind === "percent" ? "percent" : "check",
    done: Boolean(row.done),
    percent: Number(row.percent) || 0,
    created_by: row.created_by || null,
    created_at: row.created_at,
  };
}

export async function listTasks(conversationId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT * FROM tasks WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId]
    );
    return rows.map(shapeTask);
  }
  return fileStore.tasks
    .filter((task) => task.conversation_id === conversationId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(shapeTask);
}

export async function getTask(taskId) {
  if (pool) {
    const rows = await pgQuery(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    return rows[0] ? shapeTask(rows[0]) : null;
  }
  const task = fileStore.tasks.find((item) => item.id === taskId);
  return task ? shapeTask(task) : null;
}

export async function createTask(conversationId, title, kind, createdBy) {
  const task = {
    id: randomUUID(),
    conversation_id: conversationId,
    title,
    kind,
    done: false,
    percent: 0,
    created_by: createdBy,
    created_at: new Date().toISOString(),
  };
  if (pool) {
    await pgQuery(
      `INSERT INTO tasks (id, conversation_id, title, kind, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [task.id, conversationId, title, kind, createdBy]
    );
  } else {
    fileStore.tasks.push(task);
    saveFileStore();
  }
  return shapeTask(task);
}

export async function updateTask(taskId, changes) {
  const task = await getTask(taskId);
  if (!task) return null;
  const next = { ...task, ...changes };
  if (pool) {
    await pgQuery(
      `UPDATE tasks SET title = $1, done = $2, percent = $3, updated_at = NOW() WHERE id = $4`,
      [next.title, next.done, next.percent, taskId]
    );
  } else {
    const row = fileStore.tasks.find((item) => item.id === taskId);
    Object.assign(row, { title: next.title, done: next.done, percent: next.percent });
    saveFileStore();
  }
  return getTask(taskId);
}

export async function deleteTask(taskId) {
  if (pool) {
    await pgQuery(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    return;
  }
  fileStore.tasks = fileStore.tasks.filter((item) => item.id !== taskId);
  saveFileStore();
}

// ---- custom emojis ----

// The user's own packs, then packs they added from other people.
export async function listEmojiPacks(ownerId) {
  const owned = pool
    ? await pgQuery(
        `SELECT id, owner_id, name, created_at FROM emoji_packs WHERE owner_id = $1 ORDER BY created_at`,
        [ownerId]
      )
    : fileStore.emoji_packs
        .filter((pack) => pack.owner_id === ownerId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const added = pool
    ? await pgQuery(
        `SELECT p.id, p.owner_id, p.name, p.created_at, u.username AS owner_name
         FROM emoji_pack_users s
         JOIN emoji_packs p ON p.id = s.pack_id
         LEFT JOIN users u ON u.id = p.owner_id
         WHERE s.user_id = $1
         ORDER BY s.created_at`,
        [ownerId]
      )
    : fileStore.pack_subs
        .filter((sub) => sub.user_id === ownerId)
        .map((sub) => {
          const pack = fileStore.emoji_packs.find((item) => item.id === sub.pack_id);
          if (!pack) return null;
          const owner = fileStore.users.find((user) => user.id === pack.owner_id);
          return { ...pack, owner_name: owner?.username || null };
        })
        .filter(Boolean);
  const result = [];
  for (const pack of owned) {
    result.push({ ...pack, mine: true, emojis: await listEmojisInPack(pack.id) });
  }
  for (const pack of added) {
    result.push({ ...pack, mine: false, emojis: await listEmojisInPack(pack.id) });
  }
  return result;
}

export async function packSubscriberIds(packId) {
  if (pool) {
    const rows = await pgQuery(`SELECT user_id FROM emoji_pack_users WHERE pack_id = $1`, [packId]);
    return rows.map((row) => row.user_id);
  }
  return fileStore.pack_subs.filter((sub) => sub.pack_id === packId).map((sub) => sub.user_id);
}

export async function isSubscribed(packId, userId) {
  return (await packSubscriberIds(packId)).includes(userId);
}

export async function subscribePack(packId, userId) {
  if (pool) {
    await pgQuery(
      `INSERT INTO emoji_pack_users (user_id, pack_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, packId]
    );
    return;
  }
  if (!fileStore.pack_subs.some((sub) => sub.user_id === userId && sub.pack_id === packId)) {
    fileStore.pack_subs.push({ user_id: userId, pack_id: packId, created_at: new Date().toISOString() });
    saveFileStore();
  }
}

export async function unsubscribePack(packId, userId) {
  if (pool) {
    await pgQuery(`DELETE FROM emoji_pack_users WHERE user_id = $1 AND pack_id = $2`, [userId, packId]);
    return;
  }
  fileStore.pack_subs = fileStore.pack_subs.filter(
    (sub) => !(sub.user_id === userId && sub.pack_id === packId)
  );
  saveFileStore();
}

// Before packs were shared live, "Add to my emojis" made a copy. Turn those
// copies back into links to the original so they follow the creator's edits.
export async function migrateCopiedPacks() {
  const packs = pool
    ? await pgQuery(`SELECT id, owner_id, name, created_at FROM emoji_packs ORDER BY created_at`)
    : [...fileStore.emoji_packs].sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at))
      );
  const signature = new Map();
  for (const pack of packs) {
    const files = (await listEmojisInPack(pack.id)).map((emoji) => emoji.file_id).sort();
    signature.set(pack.id, files.join(","));
  }
  let moved = 0;
  for (let i = 0; i < packs.length; i += 1) {
    const copy = packs[i];
    const sig = signature.get(copy.id);
    if (!sig) continue;
    const original = packs
      .slice(0, i)
      .find((p) => p.owner_id !== copy.owner_id && p.name === copy.name && signature.get(p.id) === sig);
    if (!original) continue;
    await subscribePack(original.id, copy.owner_id);
    await deleteEmojiPack(copy.id);
    signature.delete(copy.id);
    moved += 1;
  }
  return moved;
}

export async function getEmojiPack(packId) {
  let pack;
  if (pool) {
    const rows = await pgQuery(
      `SELECT id, owner_id, name, created_at FROM emoji_packs WHERE id = $1`,
      [packId]
    );
    pack = rows[0];
  } else {
    pack = fileStore.emoji_packs.find((item) => item.id === packId);
  }
  if (!pack) return null;
  return { ...pack, emojis: await listEmojisInPack(pack.id) };
}

async function listEmojisInPack(packId) {
  if (pool) {
    return pgQuery(
      `SELECT id, pack_id, name, file_id, mime FROM emojis WHERE pack_id = $1 ORDER BY created_at, name`,
      [packId]
    );
  }
  return fileStore.emojis
    .filter((emoji) => emoji.pack_id === packId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export async function createEmojiPack(ownerId, name) {
  const pack = { id: randomUUID(), owner_id: ownerId, name, created_at: new Date().toISOString() };
  if (pool) {
    await pgQuery(`INSERT INTO emoji_packs (id, owner_id, name) VALUES ($1, $2, $3)`, [
      pack.id,
      ownerId,
      name,
    ]);
  } else {
    fileStore.emoji_packs.push(pack);
    saveFileStore();
  }
  return { ...pack, emojis: [] };
}

export async function renameEmojiPack(packId, name) {
  if (pool) {
    await pgQuery(`UPDATE emoji_packs SET name = $1 WHERE id = $2`, [name, packId]);
    return;
  }
  const pack = fileStore.emoji_packs.find((item) => item.id === packId);
  if (pack) {
    pack.name = name;
    saveFileStore();
  }
}

// Emoji image files are only removed by the orphan sweep, once no emoji
// (in any pack, including copies other people made) points at them.
export async function deleteEmojiPack(packId) {
  if (pool) {
    await pgQuery(`DELETE FROM emoji_pack_users WHERE pack_id = $1`, [packId]);
    await pgQuery(`DELETE FROM emojis WHERE pack_id = $1`, [packId]);
    await pgQuery(`DELETE FROM emoji_packs WHERE id = $1`, [packId]);
    return;
  }
  fileStore.emojis = fileStore.emojis.filter((emoji) => emoji.pack_id !== packId);
  fileStore.pack_subs = fileStore.pack_subs.filter((sub) => sub.pack_id !== packId);
  fileStore.emoji_packs = fileStore.emoji_packs.filter((pack) => pack.id !== packId);
  saveFileStore();
}

export async function addEmoji(packId, name, fileId, mime) {
  const emoji = {
    id: randomUUID(),
    pack_id: packId,
    name,
    file_id: fileId,
    mime,
    created_at: new Date().toISOString(),
  };
  if (pool) {
    await pgQuery(
      `INSERT INTO emojis (id, pack_id, name, file_id, mime) VALUES ($1, $2, $3, $4, $5)`,
      [emoji.id, packId, name, fileId, mime]
    );
  } else {
    fileStore.emojis.push(emoji);
    saveFileStore();
  }
  return emoji;
}

export async function getEmoji(emojiId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT e.id, e.pack_id, e.name, e.file_id, e.mime, p.owner_id
       FROM emojis e JOIN emoji_packs p ON p.id = e.pack_id WHERE e.id = $1`,
      [emojiId]
    );
    return rows[0] || null;
  }
  const emoji = fileStore.emojis.find((item) => item.id === emojiId);
  if (!emoji) return null;
  const pack = fileStore.emoji_packs.find((item) => item.id === emoji.pack_id);
  return { ...emoji, owner_id: pack?.owner_id || null };
}

export async function emojiFileKnown(fileId) {
  if (pool) {
    const rows = await pgQuery(`SELECT mime FROM emojis WHERE file_id = $1 LIMIT 1`, [fileId]);
    return rows[0] || null;
  }
  return fileStore.emojis.find((item) => item.file_id === fileId) || null;
}

export async function renameEmoji(emojiId, name) {
  if (pool) {
    await pgQuery(`UPDATE emojis SET name = $1 WHERE id = $2`, [name, emojiId]);
    return;
  }
  const emoji = fileStore.emojis.find((item) => item.id === emojiId);
  if (emoji) {
    emoji.name = name;
    saveFileStore();
  }
}

export async function deleteEmoji(emojiId) {
  if (pool) {
    await pgQuery(`DELETE FROM emojis WHERE id = $1`, [emojiId]);
    return;
  }
  fileStore.emojis = fileStore.emojis.filter((item) => item.id !== emojiId);
  saveFileStore();
}

// Copies someone's pack into this user's packs (the image files are shared).
export async function copyEmojiPack(packId, ownerId) {
  const source = await getEmojiPack(packId);
  if (!source) return null;
  const pack = await createEmojiPack(ownerId, source.name);
  for (const emoji of source.emojis) {
    await addEmoji(pack.id, emoji.name, emoji.file_id, emoji.mime);
  }
  return getEmojiPack(pack.id);
}

// Replaces a message's text/effect. newFiles are freshly uploaded fx assets;
// fx assets the new version no longer uses are deleted.
export async function editMessage(messageId, body, fx, newFiles, keepAssetIds) {
  const editedAt = new Date().toISOString();
  const removed = [];
  if (pool) {
    const old = await pgQuery(
      `SELECT id FROM attachments WHERE message_id = $1 AND role = 'fx'`,
      [messageId]
    );
    for (const row of old) if (!keepAssetIds.has(row.id)) removed.push(row.id);
    if (removed.length) {
      await pgQuery(`DELETE FROM attachments WHERE id = ANY($1::text[])`, [removed]);
    }
    for (const file of newFiles) {
      await pgQuery(
        `INSERT INTO attachments (id, message_id, name, mime, size, role) VALUES ($1, $2, $3, $4, $5, 'fx')`,
        [file.id, messageId, file.name, file.mime, file.size]
      );
    }
    await pgQuery(`UPDATE messages SET body = $1, fx = $2, edited_at = $3 WHERE id = $4`, [
      body,
      fx ? JSON.stringify(fx) : null,
      editedAt,
      messageId,
    ]);
  } else {
    const message = fileStore.messages.find((item) => item.id === messageId);
    if (!message) return null;
    const keep = [];
    for (const file of message.attachments || []) {
      if (file.role === "fx" && !keepAssetIds.has(file.id)) removed.push(file.id);
      else keep.push(file);
    }
    for (const file of newFiles) {
      keep.push({ id: file.id, name: file.name, mime: file.mime, size: file.size, role: "fx" });
    }
    message.attachments = keep;
    message.body = body;
    message.fx = fx;
    message.edited_at = editedAt;
    saveFileStore();
  }
  for (const id of removed) {
    try {
      fs.unlinkSync(attachmentPath(id));
    } catch {
      // already gone
    }
  }
  return getMessage(messageId);
}

// Deletes the content but leaves a "Deleted message" marker in the chat.
export async function deleteMessageContent(messageId) {
  const fileIds = [];
  if (pool) {
    const rows = await pgQuery(`SELECT id FROM attachments WHERE message_id = $1`, [messageId]);
    fileIds.push(...rows.map((row) => row.id));
    await pgQuery(`DELETE FROM attachments WHERE message_id = $1`, [messageId]);
    await pgQuery(
      `UPDATE messages SET body = '', fx = NULL, pinned = FALSE, deleted = TRUE WHERE id = $1`,
      [messageId]
    );
    for (const table of ["reactions", "poll_votes", "message_views", "crumb_state"]) {
      await pgQuery(`DELETE FROM ${table} WHERE message_id = $1`, [messageId]);
    }
  } else {
    const message = fileStore.messages.find((item) => item.id === messageId);
    if (!message) return null;
    fileIds.push(...(message.attachments || []).map((file) => file.id));
    Object.assign(message, { body: "", fx: null, pinned: false, deleted: true, attachments: [] });
    fileStore.reactions = fileStore.reactions.filter((r) => r.message_id !== messageId);
    fileStore.poll_votes = fileStore.poll_votes.filter((r) => r.message_id !== messageId);
    fileStore.message_views = fileStore.message_views.filter((r) => r.message_id !== messageId);
    delete fileStore.crumb_state[messageId];
    saveFileStore();
  }
  for (const id of fileIds) {
    try {
      fs.unlinkSync(attachmentPath(id));
    } catch {
      // already gone
    }
  }
  return getMessage(messageId);
}

// ---- reactions ----

// Adds the reaction if this user hasn't used it on the message, else removes it.
export async function toggleReaction(messageId, userId, rkey) {
  if (pool) {
    const removed = await pgQuery(
      `DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND rkey = $3 RETURNING rkey`,
      [messageId, userId, rkey]
    );
    if (!removed.length) {
      await pgQuery(
        `INSERT INTO reactions (message_id, user_id, rkey) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [messageId, userId, rkey]
      );
    }
    return;
  }
  const at = fileStore.reactions.findIndex(
    (r) => r.message_id === messageId && r.user_id === userId && r.rkey === rkey
  );
  if (at >= 0) fileStore.reactions.splice(at, 1);
  else {
    fileStore.reactions.push({
      message_id: messageId,
      user_id: userId,
      rkey,
      created_at: new Date().toISOString(),
    });
  }
  saveFileStore();
}

export async function countUserReactions(messageId, userId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM reactions WHERE message_id = $1 AND user_id = $2`,
      [messageId, userId]
    );
    return rows[0]?.n || 0;
  }
  return fileStore.reactions.filter((r) => r.message_id === messageId && r.user_id === userId).length;
}

// ---- polls ----

export async function setPollVote(messageId, userId, option, multi) {
  if (pool) {
    const has = await pgQuery(
      `SELECT 1 FROM poll_votes WHERE message_id = $1 AND user_id = $2 AND option = $3`,
      [messageId, userId, option]
    );
    if (has.length) {
      await pgQuery(`DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2 AND option = $3`, [
        messageId,
        userId,
        option,
      ]);
      return;
    }
    if (!multi) {
      await pgQuery(`DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2`, [messageId, userId]);
    }
    await pgQuery(`INSERT INTO poll_votes (message_id, user_id, option) VALUES ($1, $2, $3)`, [
      messageId,
      userId,
      option,
    ]);
    return;
  }
  const mine = (v) => v.message_id === messageId && v.user_id === userId;
  const existing = fileStore.poll_votes.findIndex((v) => mine(v) && v.option === option);
  if (existing >= 0) fileStore.poll_votes.splice(existing, 1);
  else {
    if (!multi) fileStore.poll_votes = fileStore.poll_votes.filter((v) => !mine(v));
    fileStore.poll_votes.push({ message_id: messageId, user_id: userId, option });
  }
  saveFileStore();
}

// ---- self-destructing messages: who has seen them ----

export async function addView(messageId, userId) {
  if (pool) {
    await pgQuery(
      `INSERT INTO message_views (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [messageId, userId]
    );
    return;
  }
  if (!fileStore.message_views.some((v) => v.message_id === messageId && v.user_id === userId)) {
    fileStore.message_views.push({ message_id: messageId, user_id: userId });
    saveFileStore();
  }
}

// ---- stars ----

export async function starsGivenOn(giverId, day) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT COALESCE(SUM(stars), 0)::int AS n FROM star_gifts WHERE giver_id = $1 AND day = $2`,
      [giverId, day]
    );
    return rows[0]?.n || 0;
  }
  return fileStore.star_gifts
    .filter((g) => g.giver_id === giverId && g.day === day)
    .reduce((sum, g) => sum + g.stars, 0);
}

export async function starsReceived(userId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT COALESCE(SUM(stars), 0)::int AS n FROM star_gifts WHERE receiver_id = $1`,
      [userId]
    );
    return rows[0]?.n || 0;
  }
  return fileStore.star_gifts.filter((g) => g.receiver_id === userId).reduce((sum, g) => sum + g.stars, 0);
}

export async function hasStarred(messageId, giverId) {
  if (pool) {
    const rows = await pgQuery(`SELECT 1 FROM star_gifts WHERE message_id = $1 AND giver_id = $2`, [
      messageId,
      giverId,
    ]);
    return rows.length > 0;
  }
  return fileStore.star_gifts.some((g) => g.message_id === messageId && g.giver_id === giverId);
}

export async function giveStars(messageId, giverId, receiverId, stars, day) {
  if (pool) {
    await pgQuery(
      `INSERT INTO star_gifts (message_id, giver_id, receiver_id, stars, day) VALUES ($1, $2, $3, $4, $5)`,
      [messageId, giverId, receiverId, stars, day]
    );
    return;
  }
  fileStore.star_gifts.push({
    message_id: messageId,
    giver_id: giverId,
    receiver_id: receiverId,
    stars,
    day,
    created_at: new Date().toISOString(),
  });
  saveFileStore();
}

// ---- read receipts ----

export async function setRead(conversationId, userId, readAt) {
  if (pool) {
    await pgQuery(
      `INSERT INTO conversation_reads (conversation_id, user_id, read_at) VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, user_id)
       DO UPDATE SET read_at = GREATEST(conversation_reads.read_at, EXCLUDED.read_at)`,
      [conversationId, userId, readAt]
    );
    return;
  }
  const row = fileStore.conversation_reads.find(
    (r) => r.conversation_id === conversationId && r.user_id === userId
  );
  if (row) {
    if (String(readAt) > String(row.read_at)) row.read_at = readAt;
  } else {
    fileStore.conversation_reads.push({ conversation_id: conversationId, user_id: userId, read_at: readAt });
  }
  saveFileStore();
}

export async function listReads(conversationId) {
  if (pool) {
    return pgQuery(
      `SELECT r.user_id, r.read_at, u.username, u.avatar_id
       FROM conversation_reads r JOIN users u ON u.id = r.user_id
       WHERE r.conversation_id = $1`,
      [conversationId]
    );
  }
  return fileStore.conversation_reads
    .filter((r) => r.conversation_id === conversationId)
    .map((r) => {
      const user = fileStore.users.find((item) => item.id === r.user_id);
      return { ...r, username: user?.username || null, avatar_id: user?.avatar_id || null };
    });
}

// ---- crumbs ----

export async function setCrumbState(messageId, state) {
  const json = JSON.stringify(state);
  if (pool) {
    await pgQuery(
      `INSERT INTO crumb_state (message_id, state, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (message_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [messageId, json]
    );
    return;
  }
  fileStore.crumb_state[messageId] = state;
  saveFileStore();
}

// ---- scheduled messages ----

export async function dueScheduledMessages(now = new Date()) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT id FROM messages WHERE scheduled_for IS NOT NULL AND scheduled_for <= $1`,
      [now.toISOString()]
    );
    return rows.map((row) => row.id);
  }
  const iso = now.toISOString();
  return fileStore.messages
    .filter((m) => m.scheduled_for && m.scheduled_for <= iso)
    .map((m) => m.id);
}

export async function markDelivered(messageId) {
  if (pool) {
    await pgQuery(
      `UPDATE messages SET created_at = COALESCE(scheduled_for, NOW()), scheduled_for = NULL WHERE id = $1`,
      [messageId]
    );
    return;
  }
  const message = fileStore.messages.find((m) => m.id === messageId);
  if (!message) return;
  message.created_at = message.scheduled_for || new Date().toISOString();
  message.scheduled_for = null;
  saveFileStore();
}

// Completely removes a message (used for cancelling a scheduled one).
export async function hardDeleteMessage(messageId) {
  const fileIds = [];
  if (pool) {
    const rows = await pgQuery(`SELECT id FROM attachments WHERE message_id = $1`, [messageId]);
    fileIds.push(...rows.map((row) => row.id));
    await pgQuery(`DELETE FROM attachments WHERE message_id = $1`, [messageId]);
    for (const table of ["reactions", "poll_votes", "message_views", "crumb_state"]) {
      await pgQuery(`DELETE FROM ${table} WHERE message_id = $1`, [messageId]);
    }
    await pgQuery(`DELETE FROM messages WHERE id = $1`, [messageId]);
  } else {
    const message = fileStore.messages.find((item) => item.id === messageId);
    if (message) fileIds.push(...(message.attachments || []).map((file) => file.id));
    fileStore.messages = fileStore.messages.filter((item) => item.id !== messageId);
    fileStore.reactions = fileStore.reactions.filter((r) => r.message_id !== messageId);
    fileStore.poll_votes = fileStore.poll_votes.filter((r) => r.message_id !== messageId);
    fileStore.message_views = fileStore.message_views.filter((r) => r.message_id !== messageId);
    delete fileStore.crumb_state[messageId];
    saveFileStore();
  }
  for (const id of fileIds) {
    try {
      fs.unlinkSync(attachmentPath(id));
    } catch {
      // already gone
    }
  }
}

// Self-destructed for everyone: drop the content and files, keep a marker.
export async function vanishMessage(messageId) {
  const fileIds = [];
  const gone = JSON.stringify({ gone: true });
  if (pool) {
    const rows = await pgQuery(`SELECT id FROM attachments WHERE message_id = $1`, [messageId]);
    fileIds.push(...rows.map((row) => row.id));
    await pgQuery(`DELETE FROM attachments WHERE message_id = $1`, [messageId]);
    await pgQuery(`UPDATE messages SET body = '', fx = $2, pinned = FALSE WHERE id = $1`, [messageId, gone]);
    await pgQuery(`DELETE FROM reactions WHERE message_id = $1`, [messageId]);
  } else {
    const message = fileStore.messages.find((item) => item.id === messageId);
    if (!message) return;
    fileIds.push(...(message.attachments || []).map((file) => file.id));
    Object.assign(message, { body: "", fx: { gone: true }, pinned: false, attachments: [] });
    fileStore.reactions = fileStore.reactions.filter((r) => r.message_id !== messageId);
    saveFileStore();
  }
  for (const id of fileIds) {
    try {
      fs.unlinkSync(attachmentPath(id));
    } catch {
      // already gone
    }
  }
}
