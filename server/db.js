import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { startOfCurrentMonth } from "./calendar.js";

export { nextWipeAt, getWipeInfo, WIPE_TIMEZONE } from "./calendar.js";

export const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const FILE_PATH = path.join(DATA_DIR, "store.json");

let pool = null;
let fileStore = null;

function emptyStore() {
  return { users: [], conversations: [], messages: [] };
}

function migrateFileStore() {
  for (const user of fileStore.users) {
    if (!user.avatar_id) user.avatar_id = null;
    if (!user.name_color) user.name_color = "#6e8070";
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
  if (message.body) return message.body;
  if (message.attachments?.[0]?.name) return message.attachments[0].name;
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
  };
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
      `SELECT id, username, password_hash, avatar_id, name_color FROM users WHERE username_lower = $1`,
      [usernameLower]
    );
    return rows[0] || null;
  }
  return (
    fileStore.users.find((user) => user.username_lower === usernameLower) || null
  );
}

export async function findUserById(id) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT id, username, avatar_id, name_color FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  }
  const user = fileStore.users.find((item) => item.id === id);
  return user
    ? {
        id: user.id,
        username: user.username,
        avatar_id: user.avatar_id || null,
        name_color: user.name_color || "#6e8070",
      }
    : null;
}

export async function updateUsername(id, username) {
  const usernameLower = username.toLowerCase();
  if (pool) {
    try {
      const rows = await pgQuery(
        `UPDATE users SET username = $1, username_lower = $2
         WHERE id = $3
         RETURNING id, username, avatar_id, name_color`,
        [username, usernameLower, id]
      );
      return rows[0] || null;
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
  return {
    id: user.id,
    username: user.username,
    avatar_id: user.avatar_id || null,
    name_color: user.name_color || "#6e8070",
  };
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
      `SELECT id, user_low, user_high, type, title FROM conversations WHERE id = $1`,
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
      `SELECT id, name, mime, size FROM attachments WHERE message_id = $1 ORDER BY name`,
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
         (
           SELECT COALESCE(
             NULLIF(m.body, ''),
             (SELECT a.name FROM attachments a WHERE a.message_id = m.id LIMIT 1)
           )
           FROM messages m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC
           LIMIT 1
         ) AS last_message,
         (
           SELECT m.created_at FROM messages m
           WHERE m.conversation_id = c.id
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
          WHERE m.conversation_id = c.id
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
        other_avatar_id: isGroup ? null : other?.avatar_id || null,
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
        .filter((message) => message.conversation_id === item.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const last = messages[messages.length - 1];
      return {
        id: item.id,
        type: isGroup ? "group" : "dm",
        title: isGroup ? item.title || "Group" : other?.username || "Unknown",
        other_username: isGroup ? item.title || "Group" : other?.username || "Unknown",
        other_avatar_id: isGroup ? null : other?.avatar_id || null,
        last_message: last ? previewText(last) : null,
        last_at: last ? last.created_at : item.created_at,
        members,
      };
    })
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}

export async function listMessages(conversationId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT
         m.id,
         m.conversation_id,
         m.sender_id,
         m.body,
         m.pinned,
         m.created_at,
         u.avatar_id,
         u.username AS sender_username,
         u.name_color,
         COALESCE(
           json_agg(
             json_build_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size)
             ORDER BY a.name
           ) FILTER (WHERE a.id IS NOT NULL),
           '[]'
         ) AS attachments
       FROM messages m
       LEFT JOIN attachments a ON a.message_id = m.id
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1
       GROUP BY m.id, u.avatar_id, u.username, u.name_color
       ORDER BY m.created_at ASC`,
      [conversationId]
    );
    return rows.map(mapPgMessage);
  }
  return fileStore.messages
    .filter((message) => message.conversation_id === conversationId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
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
      };
    });
}

export async function addMessage(conversationId, senderId, body, attachments = []) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const files = attachments.map((file) => ({
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: Number(file.size) || 0,
  }));
  if (pool) {
    await pgQuery(
      `INSERT INTO messages (id, conversation_id, sender_id, body, pinned)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [id, conversationId, senderId, body]
    );
    for (const file of files) {
      await pgQuery(
        `INSERT INTO attachments (id, message_id, name, mime, size)
         VALUES ($1, $2, $3, $4, $5)`,
        [file.id, id, file.name, file.mime, file.size]
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
    avatar_id: sender?.avatar_id || null,
    sender_username: sender?.username || null,
    name_color: sender?.name_color || "#6e8070",
  };
  fileStore.messages.push(message);
  saveFileStore();
  return message;
}

export async function getMessage(messageId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.pinned, m.created_at,
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

function removeStoredFile(attachmentId) {
  try {
    fs.unlinkSync(attachmentPath(attachmentId));
  } catch {
    // already gone
  }
}

export async function wipeExpiredMessages() {
  const cutoff = startOfCurrentMonth().toISOString();
  let removed = [];
  if (pool) {
    removed = await pgQuery(
      `SELECT a.id
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.pinned = FALSE AND m.created_at < $1`,
      [cutoff]
    );
    await pgQuery(
      `DELETE FROM attachments
       WHERE message_id IN (
         SELECT id FROM messages WHERE pinned = FALSE AND created_at < $1
       )`,
      [cutoff]
    );
    await pgQuery(
      `DELETE FROM messages WHERE pinned = FALSE AND created_at < $1`,
      [cutoff]
    );
  } else {
    const keep = [];
    for (const message of fileStore.messages) {
      if (!message.pinned && message.created_at < cutoff) {
        for (const file of message.attachments || []) {
          removed.push({ id: file.id });
        }
      } else {
        keep.push(message);
      }
    }
    fileStore.messages = keep;
    saveFileStore();
  }
  for (const file of removed) {
    removeStoredFile(file.id);
  }
  return removed.length;
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
    const rows = await pgQuery(
      `UPDATE users SET avatar_id = $1 WHERE id = $2
       RETURNING id, username, avatar_id, name_color`,
      [avatarId, userId]
    );
    return rows[0] || null;
  }
  const user = fileStore.users.find((item) => item.id === userId);
  if (!user) return null;
  user.avatar_id = avatarId;
  saveFileStore();
  return {
    id: user.id,
    username: user.username,
    avatar_id: user.avatar_id,
    name_color: user.name_color || "#6e8070",
  };
}

export async function setUserColor(userId, color) {
  if (pool) {
    const rows = await pgQuery(
      `UPDATE users SET name_color = $1 WHERE id = $2
       RETURNING id, username, avatar_id, name_color`,
      [color, userId]
    );
    return rows[0] || null;
  }
  const user = fileStore.users.find((item) => item.id === userId);
  if (!user) return null;
  user.name_color = color;
  saveFileStore();
  return {
    id: user.id,
    username: user.username,
    avatar_id: user.avatar_id || null,
    name_color: user.name_color,
  };
}

export async function getAvatarOwner(avatarId) {
  if (pool) {
    const rows = await pgQuery(
      `SELECT id FROM users WHERE avatar_id = $1`,
      [avatarId]
    );
    return rows[0] || null;
  }
  return fileStore.users.find((user) => user.avatar_id === avatarId) || null;
}

export async function createGroup(title, memberIds) {
  const id = randomUUID();
  const unique = [...new Set(memberIds)];
  if (pool) {
    await pgQuery(
      `INSERT INTO conversations (id, user_low, user_high, type, title)
       VALUES ($1, $2, $3, 'group', $4)`,
      [id, "__group__", id, title]
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

