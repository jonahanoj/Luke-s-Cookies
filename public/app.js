const $ = (id) => document.getElementById(id);

const authEl = $("auth");
const appEl = $("app");
const tabLogin = $("tab-login");
const tabRegister = $("tab-register");
const authForm = $("auth-form");
const authSubmit = $("auth-submit");
const authError = $("auth-error");
const meName = $("me-name");
const meAvatar = $("me-avatar");
const userSearch = $("user-search");
const searchResults = $("search-results");
const conversationList = $("conversation-list");
const pinnedList = $("pinned-list");
const emptyChat = $("empty-chat");
const thread = $("thread");
const threadName = $("thread-name");
const threadAvatar = $("thread-avatar");
const messagesEl = $("messages");
const compose = $("compose");
const composeInput = $("compose-input");
const composeError = $("compose-error");
const fileInput = $("file-input");
const filePreview = $("file-preview");
const wipeBanner = $("wipe-banner");
const usernameDialog = $("username-dialog");
const usernameForm = $("username-form");
const newUsername = $("new-username");
const usernameError = $("username-error");
const bioInput = $("bio-input");
const bioCount = $("bio-count");
const groupDialog = $("group-dialog");
const groupError = $("group-error");
const addMemberBtn = $("btn-add-member");
const muteBtn = $("btn-mute");
const pfpPreview = $("pfp-preview");
const chatSearch = $("chat-search");
const filterAll = $("filter-all");
const filterPinned = $("filter-pinned");
const filterStatus = $("filter-status");
const blockedNote = $("blocked-note");
const blockedText = $("blocked-text");
const profileDialog = $("profile-dialog");
const settingsDialog = $("settings-dialog");
const lightbox = $("lightbox");
const lightboxStage = $("lightbox-stage");

const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;
const MAX_PIN_BYTES = 500 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]}])/gi;

let mode = "login";
let me = null;
let conversations = [];
let activeId = null;
let activeChat = null;
let activeMessages = new Map();
let socket = null;
let searchTimer = null;
let pendingFiles = [];
let nextWipeAt = null;
let wipeLabel = "";
let filterMode = "all";
let filterQuery = "";
let sideTab = "chats";
let pendingOpen = new URLSearchParams(location.search).get("c");
let swRegistration = null;

// ---------- helpers ----------
function showError(el, message) {
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function setMode(next) {
  mode = next;
  tabLogin.classList.toggle("active", next === "login");
  tabRegister.classList.toggle("active", next === "register");
  authSubmit.textContent = next === "login" ? "Log in" : "Create account";
  $("auth-password").autocomplete = next === "login" ? "current-password" : "new-password";
}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isForm && options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
    body: options.body ? (isForm ? options.body : JSON.stringify(options.body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCountdown(target) {
  const ms = Math.max(0, new Date(target).getTime() - Date.now());
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fileKind(file) {
  const mime = String(file.mime || "");
  const name = String(file.name || "");
  if (mime.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXT.test(name)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXT.test(name)) return "audio";
  return "file";
}

// Name colors are picked by each person; nudge them so they stay readable
// on whatever theme the viewer has.
function readable(color) {
  if (!color) return "";
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--cream-solid").trim() || "#ffffff";
  const ink = styles.getPropertyValue("--ink").trim() || "#000000";
  return Theme.ensureContrast(color, bg, ink, 3.2);
}

// Text with clickable links (and optional search highlighting). Never HTML.
function renderRichText(el, text, query = "") {
  el.replaceChildren();
  const q = query.trim().toLowerCase();
  const addText = (chunk, parent) => {
    if (!q) {
      parent.append(chunk);
      return;
    }
    const lower = chunk.toLowerCase();
    let at = 0;
    for (;;) {
      const hit = lower.indexOf(q, at);
      if (hit === -1) break;
      parent.append(chunk.slice(at, hit));
      const mark = document.createElement("mark");
      mark.textContent = chunk.slice(hit, hit + q.length);
      parent.append(mark);
      at = hit + q.length;
    }
    parent.append(chunk.slice(at));
  };
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    addText(text.slice(last, match.index), el);
    const raw = match[0];
    const href = raw.toLowerCase().startsWith("www.") ? `https://${raw}` : raw;
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    addText(raw, a);
    el.append(a);
    last = match.index + raw.length;
  }
  addText(text.slice(last), el);
}

function chatName(item) {
  return item.isGroup ? item.title || item.username : item.username;
}

// ---------- me / theme ----------
function paintMe() {
  meName.textContent = me.username;
  meName.style.color = readable(me.nameColor);
  meAvatar.src = me.avatarUrl || "/assets/SmallLogo.png";
}

function applyMyTheme() {
  Theme.apply(me?.theme || {});
}

// ---------- notifications (web push) ----------
function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true
  );
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    return swRegistration;
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = swRegistration || (await navigator.serviceWorker.ready);
  return reg.pushManager.getSubscription();
}

async function enableNotifications() {
  if (!pushSupported()) {
    throw new Error(
      isIos() && !isStandalone()
        ? "On iPhone/iPad, tap Share → Add to Home Screen, open the app from there, then turn this on."
        : "This browser doesn't support notifications."
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked. Allow them for this site in your browser settings.");
  }
  const reg = swRegistration || (await navigator.serviceWorker.ready);
  const { publicKey } = await api("/api/push/key");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
}

async function disableNotifications() {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(
    () => {}
  );
  await sub.unsubscribe().catch(() => {});
}

// Keep the server's copy of this device's subscription tied to whoever is logged in.
async function syncSubscription() {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    const sub = await currentSubscription();
    if (sub) {
      await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    }
  } catch {
    // not fatal
  }
}

async function refreshNotifyUi() {
  const toggle = $("notify-toggle");
  const status = $("notify-status");
  if (!pushSupported()) {
    toggle.checked = false;
    toggle.disabled = !(isIos() && !isStandalone());
    status.textContent =
      isIos() && !isStandalone()
        ? "On iPhone/iPad: tap Share → Add to Home Screen, then open Luke's Cookies from your home screen to turn this on."
        : "This browser doesn't support notifications.";
    return;
  }
  toggle.disabled = false;
  const sub = await currentSubscription().catch(() => null);
  toggle.checked = Boolean(sub) && Notification.permission === "granted";
  if (Notification.permission === "denied") {
    status.textContent = "Blocked in your browser settings for this site.";
  } else if (toggle.checked) {
    status.textContent = "On. You'll get a notification when you're not looking at that chat. Muted chats stay quiet.";
  } else {
    status.textContent = "Off on this device.";
  }
}

// Tell the server whether we're looking at the app, so it skips pushes for
// the chat that's already open on screen.
function sendPresence() {
  if (!socket) return;
  socket.emit("presence", {
    visible: document.visibilityState === "visible" && document.hasFocus(),
    conversationId: activeId,
  });
}

// ---------- socket ----------
function connectSocket() {
  if (socket) socket.close();
  socket = io();
  socket.on("connect", sendPresence);
  socket.on("message", (payload) => {
    refreshConversations();
    if (payload.pinned || sideTab === "pinned") refreshPinned();
    if (payload.conversationId !== activeId) return;
    Extras.clearTyping(payload.username);
    upsertMessage(payload, true);
    if ((payload.fx?.effect || payload.fx?.roulette) && !payload.mine && document.visibilityState === "visible") {
      Fx.autoplay([payload]);
    }
    Extras.markRead();
  });
  socket.on("typing", (payload) => Extras.onTyping(payload));
  socket.on("read", (payload) => Extras.onRead(payload));
  socket.on("crumb", (payload) => Crumbs.onRemoteState(payload));
  socket.on("stars-received", (payload) => Extras.onStarsReceived(payload));
  socket.on("message-removed", (payload) => {
    if (payload.conversationId !== activeId) return;
    messagesEl.querySelector(`[data-id="${payload.id}"]`)?.remove();
    activeMessages.delete(payload.id);
  });
  socket.on("conversation-updated", (payload) => Groups.onConversationUpdated(payload.conversationId));
  socket.on("tasks-changed", (payload) => Groups.onTasksChanged(payload.conversationId));
  socket.on("emojis-changed", () => Fx.onEmojisChanged());
  socket.on("message-updated", (payload) => {
    refreshPinned();
    if (payload.conversationId !== activeId) return;
    upsertMessage(payload, true);
  });
  socket.on("username-changed", () => refreshConversations());
  socket.on("profile-changed", async () => {
    await refreshConversations();
    if (activeChat) loadMessages(activeChat.id);
  });
  socket.on("wiped", async () => {
    await refreshConversations();
    refreshPinned();
    loadWipe();
    if (activeChat) loadMessages(activeChat.id);
  });
}

function showApp() {
  authEl.hidden = true;
  appEl.hidden = false;
  applyMyTheme();
  paintMe();
  connectSocket();
  refreshConversations().then(() => {
    if (pendingOpen) {
      const target = conversations.find((item) => item.id === pendingOpen);
      pendingOpen = null;
      history.replaceState(null, "", "/");
      if (target) openConversation(target);
    }
  });
  loadWipe();
  syncSubscription();
  Fx.Emoji.load();
}

function showAuth() {
  authEl.hidden = false;
  appEl.hidden = true;
  me = null;
  activeId = null;
  activeChat = null;
  pendingFiles = [];
  renderPendingFiles();
  Theme.applyCached();
  if (socket) {
    socket.close();
    socket = null;
  }
}

// ---------- sidebar ----------
function setSideTab(tab) {
  sideTab = tab;
  $("side-tab-chats").classList.toggle("active", tab === "chats");
  $("side-tab-pinned").classList.toggle("active", tab === "pinned");
  $("chats-pane").hidden = tab !== "chats";
  $("pinned-pane").hidden = tab !== "pinned";
  if (tab === "pinned") refreshPinned();
}

function renderConversations() {
  conversationList.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "No chats yet. Search a username or make a group.";
    conversationList.append(empty);
    return;
  }
  for (const item of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation" + (item.id === activeId ? " active" : "");
    const avatar = document.createElement("img");
    avatar.className = "list-avatar";
    avatar.src = item.avatarUrl || "/assets/SmallLogo.png";
    avatar.alt = "";
    const copy = document.createElement("div");
    copy.className = "copy";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = chatName(item);
    if (item.muted) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Muted";
      name.append(tag);
    }
    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = item.blocked ? "Blocked" : item.lastMessage || "No messages yet";
    copy.append(name, preview);
    button.append(avatar, copy);
    button.addEventListener("click", () => openConversation(item));
    conversationList.append(button);
  }
}

async function refreshConversations() {
  const data = await api("/api/conversations");
  conversations = data.conversations;
  renderConversations();
  if (activeId) {
    const current = conversations.find((item) => item.id === activeId);
    if (current) {
      activeChat = current;
      paintThreadHeader();
    }
  }
}

async function refreshPinned() {
  if (sideTab !== "pinned") return;
  let data;
  try {
    data = await api("/api/pinned");
  } catch {
    return;
  }
  pinnedList.replaceChildren();
  if (!data.pinned.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "Nothing pinned yet. Pin a message to keep it past the wipe.";
    pinnedList.append(empty);
    return;
  }
  for (const item of data.pinned) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pinned-item";
    const meta = document.createElement("div");
    meta.className = "meta";
    const where = document.createElement("strong");
    where.textContent = item.chatName;
    const when = document.createElement("span");
    when.textContent = formatTime(item.createdAt);
    meta.append(where, when);
    const snippet = document.createElement("div");
    snippet.className = "snippet";
    const who = item.mine ? "You" : item.username || "Them";
    const firstImage = item.attachments.find((file) => fileKind(file) === "image");
    const text = item.blocked
      ? "Message from blocked user"
      : item.body ||
        (firstImage
          ? ""
          : item.attachments.map((file) => file.name).join(", ") || "Attachment");
    snippet.textContent = text ? `${who}: ${text}` : `${who}:`;
    button.append(meta, snippet);
    if (firstImage) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = `/api/attachments/${firstImage.id}`;
      img.alt = "";
      img.loading = "lazy";
      button.append(img);
    }
    button.addEventListener("click", async () => {
      const chat = conversations.find((c) => c.id === item.conversationId);
      if (!chat) return;
      await openConversation(chat);
      jumpToMessage(item.id);
    });
    pinnedList.append(button);
  }
}

// ---------- thread ----------
function paintThreadHeader() {
  if (!activeChat) return;
  threadName.textContent = chatName(activeChat);
  threadAvatar.src = activeChat.avatarUrl || "/assets/SmallLogo.png";
  addMemberBtn.hidden = !activeChat.isGroup;
  muteBtn.textContent = activeChat.muted ? "Unmute" : "Mute";
  muteBtn.title = activeChat.muted
    ? "You won't get notifications from this chat"
    : "Stop notifications from this chat";
  const blocked = Boolean(activeChat.blocked);
  blockedNote.hidden = !blocked;
  compose.hidden = blocked || !$("tasks-panel").hidden;
  if (blocked) blockedText.textContent = `You blocked ${activeChat.username}.`;
  $("filter-tasks").hidden = !activeChat.isGroup;
  $("thread-title").title = activeChat.isGroup ? "Group settings" : "View profile";
}

function makeAvatar(name, url, color, username) {
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.className = "avatar";
  wrap.title = `View ${name}'s profile`;
  if (color) wrap.style.background = color;
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    wrap.append(img);
  } else {
    wrap.textContent = (name[0] || "?").toUpperCase();
  }
  if (username) wrap.addEventListener("click", () => openProfile(username));
  return wrap;
}

function renderAttachments(message) {
  if (!message.attachments?.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "attach-list";
  for (const file of message.attachments) {
    const url = `/api/attachments/${file.id}`;
    const kind = fileKind(file);
    if (kind === "image") {
      const img = document.createElement("img");
      img.className = "media";
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.title = file.name;
      img.addEventListener("load", keepBottomIfNeeded);
      img.addEventListener("click", () => openLightbox(url, file.name));
      wrap.append(img);
    } else if (kind === "video") {
      const video = document.createElement("video");
      video.className = "media";
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.addEventListener("loadedmetadata", keepBottomIfNeeded);
      wrap.append(video);
    } else if (kind === "audio") {
      wrap.append(Extras.audioPlayer(url, file.name));
    } else {
      const card = document.createElement("a");
      card.className = "file-card";
      card.href = url;
      card.target = "_blank";
      card.rel = "noreferrer";
      card.download = file.name;
      const ext = document.createElement("span");
      ext.className = "file-ext";
      const dot = file.name.lastIndexOf(".");
      ext.textContent = dot > 0 ? file.name.slice(dot + 1, dot + 5) : "file";
      const info = document.createElement("span");
      info.className = "file-info";
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = file.name;
      const size = document.createElement("span");
      size.className = "file-size";
      size.textContent = formatSize(file.size);
      info.append(name, size);
      card.append(ext, info);
      wrap.append(card);
    }
  }
  return wrap;
}

let stickToBottom = true;
messagesEl.addEventListener("scroll", () => {
  stickToBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
});

function keepBottomIfNeeded() {
  if (stickToBottom && !isFiltering()) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function upsertMessage(message, replace = false) {
  const existing = messagesEl.querySelector(`[data-id="${message.id}"]`);
  if (existing && !replace) return;
  activeMessages.set(message.id, message);

  if (message.deleted) {
    const row = document.createElement("div");
    row.className = "row deleted-row";
    row.dataset.id = message.id;
    const note = document.createElement("div");
    note.className = "deleted-note";
    note.textContent = "Deleted message";
    row.append(note);
    if (existing) existing.replaceWith(row);
    else messagesEl.append(row);
    applyFilterToRow(row, message);
    Extras.afterRender();
    return;
  }

  const whoName = message.mine ? "You" : message.username || activeChat?.username || "Them";
  const profileName = message.mine ? me?.username : message.username;
  const row = document.createElement("div");
  row.className = "row " + (message.mine ? "mine" : "theirs") + (message.scheduledFor ? " scheduled" : "");
  row.dataset.id = message.id;

  const avatarUrl = message.mine ? me?.avatarUrl : message.avatarUrl;
  const avatar = makeAvatar(profileName || whoName, avatarUrl, message.nameColor, profileName);

  const bubble = document.createElement("div");
  bubble.className =
    "bubble " +
    (message.mine ? "mine" : "theirs") +
    (message.pinned ? " pinned" : "") +
    (message.blocked ? " blocked" : "") +
    (message.gone ? " gone" : "");

  const top = document.createElement("div");
  top.className = "bubble-top";
  const who = document.createElement("button");
  who.type = "button";
  who.className = "who";
  who.textContent = message.pinned ? `${whoName} · Pinned` : whoName;
  who.style.color = readable(message.mine ? me?.nameColor || message.nameColor : message.nameColor);
  if (profileName) who.addEventListener("click", () => openProfile(profileName));
  top.append(who);

  const actions = document.createElement("span");
  actions.className = "bubble-actions";
  const addAction = (label, onClick, className = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `pin-btn ${className}`.trim();
    b.textContent = label;
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(event);
    });
    actions.append(b);
    return b;
  };

  if (message.fx?.effect && !message.blocked && !message.gone) {
    addAction("▶ Effect", () => Fx.playMessage(message), "fx-replay");
  }
  if (!message.blocked && !message.gone && !message.scheduledFor) {
    addAction("React", (event) => openReactionPicker(event.currentTarget, message), "react-btn");
    addAction("Reply", () => Extras.startReply(message));
  }
  if (!message.blocked) {
    addAction("⋯", (event) => Extras.openMessageMenu(event.currentTarget, message), "more-btn");
  }
  top.append(actions);
  bubble.append(top);

  if (message.gone) {
    const text = document.createElement("div");
    text.className = "gone-note";
    text.textContent = "💨 Self-destructed";
    bubble.append(text);
  } else {
    if (message.reply && !message.blocked) bubble.append(Extras.renderReply(message.reply));

    if (message.forwarded && !message.blocked) {
      const tag = document.createElement("div");
      tag.className = "forwarded-tag";
      tag.textContent = "↪ Forwarded";
      bubble.append(tag);
    }

    const content = document.createElement("div");
    content.className = "bubble-content";
    if (message.blocked) {
      const text = document.createElement("div");
      text.textContent = "Message from someone you blocked";
      content.append(text);
    } else if (message.fx?.spans) {
      const text = document.createElement("div");
      text.className = "body-text";
      Fx.renderSpans(text, message.fx.spans, filterQuery);
      content.append(text);
    } else if (message.body && !message.fx?.roulette && !message.fx?.poll && !message.fx?.crumb) {
      const text = document.createElement("div");
      text.className = "body-text";
      renderRichText(text, message.body, filterQuery);
      content.append(text);
    }
    if (message.fx?.pack && !message.blocked) content.append(Fx.renderPackCard(message.fx.pack));
    if (!message.blocked) Extras.renderExtras(message, content);
    const files = renderAttachments(message);
    if (files) content.append(files);
    bubble.append(content);
    if (!message.blocked) Extras.decorateBoom(message, bubble, content);
    if (!message.blocked && message.reactions?.length) bubble.append(renderReactions(message));
  }

  const time = document.createElement("time");
  time.textContent = message.scheduledFor
    ? `⏰ Sends ${formatTime(message.scheduledFor)}`
    : formatTime(message.createdAt) + (message.edited ? " · edited" : "");
  if (message.stars?.total) {
    const star = document.createElement("span");
    star.className = "star-badge";
    star.textContent = ` ★ ${message.stars.total}`;
    star.title = message.stars.givers.map((g) => `${g.name}: ${g.stars}★`).join(", ");
    time.append(star);
  }
  bubble.append(time);

  // While filtering, clicking a result jumps to it in the full chat.
  bubble.addEventListener("click", (event) => {
    if (!isFiltering()) return;
    if (event.target.closest("a, button, video, audio, img")) return;
    jumpToMessage(message.id);
  });

  row.append(avatar, bubble);
  if (existing) existing.replaceWith(row);
  else messagesEl.append(row);
  applyFilterToRow(row, message);
  Extras.afterRender();
  if (isFiltering()) updateFilterStatus();
  else if (!replace || stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMessages(conversationId) {
  const data = await api(`/api/conversations/${conversationId}/messages`);
  if (conversationId !== activeId) return;
  messagesEl.replaceChildren();
  activeMessages = new Map();
  stickToBottom = true;
  Extras.setReads(data.reads || []);
  for (const message of data.messages) upsertMessage(message);
  applyFilter();
  messagesEl.scrollTop = messagesEl.scrollHeight;
  Fx.autoplay(data.messages);
  Extras.markRead();
}

async function openConversation(item) {
  const switching = activeId !== item.id;
  activeId = item.id;
  activeChat = item;
  appEl.classList.add("show-chat");
  emptyChat.hidden = true;
  thread.hidden = false;
  showError(composeError, "");
  if (switching) {
    Fx.stop();
    Extras.resetForChat();
    filterMode = "all";
    filterQuery = "";
    chatSearch.value = "";
    filterAll.classList.add("active");
    filterPinned.classList.remove("active");
  }
  paintThreadHeader();
  Groups.onThreadOpened(item, switching);
  renderConversations();
  sendPresence();
  await loadMessages(item.id);
  if (!matchMedia("(max-width: 720px)").matches) composeInput.focus();
}

async function startConversation(username) {
  const data = await api("/api/conversations", { method: "POST", body: { username } });
  userSearch.value = "";
  searchResults.hidden = true;
  setSideTab("chats");
  await refreshConversations();
  const item = conversations.find((entry) => entry.id === data.id) || {
    id: data.id,
    username: data.username,
    isGroup: false,
    lastMessage: null,
  };
  openConversation(item);
}

// ---------- search + pinned filter inside a chat ----------
function isFiltering() {
  return filterMode === "pinned" || filterQuery.trim().length > 0;
}

function messageMatches(message) {
  if (filterMode === "pinned" && !message.pinned) return false;
  const q = filterQuery.trim().toLowerCase();
  if (!q) return true;
  if (message.blocked) return false;
  const haystack = [message.body || "", ...(message.attachments || []).map((f) => f.name)]
    .join("\n")
    .toLowerCase();
  return haystack.includes(q);
}

function applyFilterToRow(row, message) {
  row.hidden = !messageMatches(message);
}

function updateFilterStatus() {
  if (!isFiltering()) {
    filterStatus.hidden = true;
    return;
  }
  const count = [...activeMessages.values()].filter(messageMatches).length;
  const what = filterMode === "pinned" ? "pinned message" : "message";
  const plural = count === 1 ? what : `${what}s`;
  filterStatus.hidden = false;
  filterStatus.textContent = count
    ? `${count} ${plural}${filterQuery.trim() ? ` matching “${filterQuery.trim()}”` : ""}. Tap one to jump to it.`
    : filterQuery.trim()
      ? `No ${what}s match “${filterQuery.trim()}”.`
      : "No pinned messages in this chat.";
}

function applyFilter() {
  for (const row of messagesEl.querySelectorAll(".row")) {
    const message = activeMessages.get(row.dataset.id);
    if (!message) continue;
    applyFilterToRow(row, message);
    const body = row.querySelector(".body-text");
    if (body && message.fx?.spans) Fx.renderSpans(body, message.fx.spans, filterQuery);
    else if (body && message.body) renderRichText(body, message.body, filterQuery);
  }
  updateFilterStatus();
  if (!isFiltering()) messagesEl.scrollTop = messagesEl.scrollHeight;
  else messagesEl.scrollTop = 0;
}

function clearFilter() {
  filterMode = "all";
  filterQuery = "";
  chatSearch.value = "";
  filterAll.classList.add("active");
  filterPinned.classList.remove("active");
  applyFilter();
}

function jumpToMessage(id) {
  if (isFiltering()) clearFilter();
  const row = messagesEl.querySelector(`[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
}

filterAll.addEventListener("click", () => {
  filterMode = "all";
  filterAll.classList.add("active");
  filterPinned.classList.remove("active");
  applyFilter();
});

filterPinned.addEventListener("click", () => {
  filterMode = "pinned";
  filterPinned.classList.add("active");
  filterAll.classList.remove("active");
  applyFilter();
});

let filterTimer = null;
chatSearch.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterQuery = chatSearch.value;
    applyFilter();
  }, 120);
});

chatSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearFilter();
});

// ---------- lightbox ----------
function openLightbox(url, name) {
  lightboxStage.classList.remove("zoomed");
  lightboxStage.replaceChildren();
  const img = document.createElement("img");
  img.src = url;
  img.alt = name || "";
  img.addEventListener("click", (event) => {
    event.stopPropagation();
    lightboxStage.classList.toggle("zoomed");
  });
  lightboxStage.append(img);
  $("lightbox-open").href = url;
  $("lightbox-download").href = url;
  $("lightbox-download").download = name || "image";
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxStage.replaceChildren();
}

$("lightbox-close").addEventListener("click", closeLightbox);
lightboxStage.addEventListener("click", (event) => {
  if (event.target === lightboxStage) closeLightbox();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !lightbox.hidden) closeLightbox();
});

// ---------- profiles ----------
let viewingProfile = null;

async function openProfile(username) {
  if (!username) return;
  showError($("profile-error"), "");
  let data;
  try {
    data = await api(`/api/users/${encodeURIComponent(username)}/profile`);
  } catch (err) {
    showError(composeError, err.message);
    return;
  }
  const profile = data.profile;
  viewingProfile = profile;
  const avatar = $("profile-avatar");
  avatar.src = profile.avatarUrl || "/assets/SmallLogo.png";
  const name = $("profile-name");
  name.textContent = profile.username;
  name.style.color = readable(profile.nameColor);
  $("profile-stars").textContent = `★ ${profile.stars || 0} star${profile.stars === 1 ? "" : "s"} received`;
  const bio = $("profile-bio");
  if (profile.bio) {
    bio.classList.remove("empty");
    renderRichText(bio, profile.bio);
  } else {
    bio.classList.add("empty");
    bio.textContent = profile.isMe ? "You haven't written anything yet." : "Nothing here yet.";
  }
  $("profile-edit").hidden = !profile.isMe;
  $("profile-message").hidden = profile.isMe;
  $("profile-block").hidden = profile.isMe;
  $("profile-block").textContent = profile.blocked ? "Unblock" : "Block";
  if (!profileDialog.open) profileDialog.showModal();
}

async function setBlock(username, blocked) {
  await api(`/api/users/${encodeURIComponent(username)}/block`, {
    method: "POST",
    body: { blocked },
  });
  await refreshConversations();
  if (activeChat) {
    paintThreadHeader();
    loadMessages(activeChat.id);
  }
}

$("profile-avatar").addEventListener("click", () => {
  if (viewingProfile?.avatarUrl) openLightbox(viewingProfile.avatarUrl, viewingProfile.username);
});
$("profile-close").addEventListener("click", () => profileDialog.close());
profileDialog.addEventListener("click", (event) => {
  if (event.target === profileDialog) profileDialog.close();
});
$("profile-message").addEventListener("click", async () => {
  if (!viewingProfile) return;
  profileDialog.close();
  try {
    await startConversation(viewingProfile.username);
  } catch (err) {
    showError(composeError, err.message);
  }
});
$("profile-block").addEventListener("click", async () => {
  if (!viewingProfile) return;
  const next = !viewingProfile.blocked;
  if (next && !confirm(`Block ${viewingProfile.username}? They won't be able to message you and you won't see their messages.`)) {
    return;
  }
  try {
    await setBlock(viewingProfile.username, next);
    viewingProfile.blocked = next;
    $("profile-block").textContent = next ? "Unblock" : "Block";
  } catch (err) {
    showError($("profile-error"), err.message);
  }
});
$("profile-edit").addEventListener("click", () => {
  profileDialog.close();
  openEditProfile();
});

$("thread-title").addEventListener("click", () => {
  if (!activeChat) return;
  if (!activeChat.isGroup) openProfile(activeChat.username);
});

$("blocked-unblock").addEventListener("click", async () => {
  if (!activeChat || activeChat.isGroup) return;
  try {
    await setBlock(activeChat.username, false);
  } catch (err) {
    showError(composeError, err.message);
  }
});

muteBtn.addEventListener("click", async () => {
  if (!activeChat) return;
  try {
    const data = await api(`/api/conversations/${activeChat.id}/mute`, {
      method: "POST",
      body: { muted: !activeChat.muted },
    });
    activeChat.muted = data.muted;
    paintThreadHeader();
    refreshConversations();
  } catch (err) {
    showError(composeError, err.message);
  }
});

// ---------- edit own profile ----------
let namePicker = null;

function updateBioCount() {
  bioCount.textContent = `${bioInput.value.length} / 300`;
}

function openEditProfile() {
  showError(usernameError, "");
  newUsername.value = me.username;
  bioInput.value = me.bio || "";
  updateBioCount();
  pfpPreview.src = me.avatarUrl || "/assets/SmallLogo.png";
  namePicker = Theme.createPicker($("name-picker"), me.nameColor || "#6e8070");
  usernameDialog.showModal();
}

bioInput.addEventListener("input", updateBioCount);

$("pfp-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  showError(usernameError, "");
  const form = new FormData();
  form.append("avatar", file);
  try {
    const data = await api("/api/avatar", { method: "POST", body: form });
    me = data.user;
    paintMe();
    pfpPreview.src = me.avatarUrl || pfpPreview.src;
  } catch (err) {
    showError(usernameError, err.message);
  }
  event.target.value = "";
});

$("username-save").addEventListener("click", async () => {
  showError(usernameError, "");
  try {
    if (newUsername.value.trim() !== me.username) {
      const nameData = await api("/api/username", {
        method: "POST",
        body: { username: newUsername.value },
      });
      me = nameData.user;
    }
    const colorData = await api("/api/color", {
      method: "POST",
      body: { color: namePicker.get() },
    });
    me = colorData.user;
    const bioData = await api("/api/bio", { method: "POST", body: { bio: bioInput.value } });
    me = bioData.user;
    paintMe();
    usernameDialog.close();
  } catch (err) {
    showError(usernameError, err.message);
  }
});

usernameForm.addEventListener("submit", () => usernameDialog.close());

// ---------- settings ----------
let primaryPicker = null;
let secondaryPicker = null;
let draftTheme = null;

function previewDraft() {
  Theme.apply(draftTheme, { cache: false });
}

function paintBgControls() {
  const thumb = $("bg-thumb");
  const url = draftTheme.backgroundUrl;
  thumb.style.backgroundImage = url ? `url("${url}")` : "";
  thumb.textContent = url ? "" : "No image";
  $("bg-remove").hidden = !url;
  $("bg-colors").hidden = !url;
}

async function renderBlockedList() {
  const list = $("blocked-list");
  list.replaceChildren();
  let data;
  try {
    data = await api("/api/blocked");
  } catch {
    return;
  }
  if (!data.users.length) {
    const p = document.createElement("p");
    p.textContent = "You haven't blocked anyone.";
    list.append(p);
    return;
  }
  for (const user of data.users) {
    const row = document.createElement("div");
    row.className = "blocked-row";
    const name = document.createElement("span");
    name.textContent = user.username;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost small";
    btn.textContent = "Unblock";
    btn.addEventListener("click", async () => {
      await setBlock(user.username, false);
      renderBlockedList();
    });
    row.append(name, btn);
    list.append(row);
  }
}

function openSettings() {
  showError($("theme-error"), "");
  draftTheme = {
    primary: me.theme?.primary || Theme.DEFAULT_PRIMARY,
    secondary: me.theme?.secondary || Theme.DEFAULT_SECONDARY,
    backgroundUrl: me.theme?.backgroundUrl || null,
  };
  primaryPicker = Theme.createPicker($("primary-picker"), draftTheme.primary, (hex) => {
    draftTheme.primary = hex;
    previewDraft();
  });
  secondaryPicker = Theme.createPicker($("secondary-picker"), draftTheme.secondary, (hex) => {
    draftTheme.secondary = hex;
    previewDraft();
  });
  paintBgControls();
  refreshNotifyUi();
  renderBlockedList();
  settingsDialog.showModal();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function useColorsFrom(src) {
  const img = await loadImage(src);
  const colors = Theme.colorsFromImage(img);
  draftTheme.primary = colors.primary;
  draftTheme.secondary = colors.secondary;
  primaryPicker.set(colors.primary);
  secondaryPicker.set(colors.secondary);
  previewDraft();
}

$("bg-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  showError($("theme-error"), "");
  const localUrl = URL.createObjectURL(file);
  try {
    await useColorsFrom(localUrl);
    const form = new FormData();
    form.append("background", file);
    const data = await api("/api/theme/background", { method: "POST", body: form });
    me = { ...me, theme: { ...me.theme, backgroundUrl: data.user.theme.backgroundUrl } };
    draftTheme.backgroundUrl = data.user.theme.backgroundUrl;
    paintBgControls();
    previewDraft();
  } catch (err) {
    showError($("theme-error"), err.message || "Could not use that image.");
  } finally {
    URL.revokeObjectURL(localUrl);
  }
});

$("bg-colors").addEventListener("click", async () => {
  if (!draftTheme.backgroundUrl) return;
  try {
    await useColorsFrom(draftTheme.backgroundUrl);
  } catch {
    showError($("theme-error"), "Could not read the image colors.");
  }
});

$("bg-remove").addEventListener("click", async () => {
  try {
    const data = await api("/api/theme/background", { method: "DELETE" });
    me = { ...me, theme: { ...me.theme, backgroundUrl: data.user.theme.backgroundUrl } };
    draftTheme.backgroundUrl = null;
    paintBgControls();
    previewDraft();
  } catch (err) {
    showError($("theme-error"), err.message);
  }
});

$("theme-reset").addEventListener("click", () => {
  draftTheme.primary = Theme.DEFAULT_PRIMARY;
  draftTheme.secondary = Theme.DEFAULT_SECONDARY;
  primaryPicker.set(draftTheme.primary);
  secondaryPicker.set(draftTheme.secondary);
  previewDraft();
});

$("notify-toggle").addEventListener("change", async (event) => {
  const status = $("notify-status");
  const on = event.target.checked;
  event.target.disabled = true;
  try {
    if (on) await enableNotifications();
    else await disableNotifications();
  } catch (err) {
    status.textContent = err.message;
    event.target.disabled = false;
    event.target.checked = false;
    return;
  }
  await refreshNotifyUi();
});

$("settings-save").addEventListener("click", async () => {
  showError($("theme-error"), "");
  try {
    const data = await api("/api/theme", {
      method: "POST",
      body: { primary: draftTheme.primary, secondary: draftTheme.secondary },
    });
    me = data.user;
    applyMyTheme();
    paintMe();
    settingsDialog.close();
    if (activeChat) loadMessages(activeChat.id);
  } catch (err) {
    showError($("theme-error"), err.message);
  }
});

function cancelSettings() {
  applyMyTheme();
  if (settingsDialog.open) settingsDialog.close();
}

$("settings-cancel").addEventListener("click", cancelSettings);
settingsDialog.addEventListener("cancel", () => applyMyTheme());

// ---------- wipe banner ----------
function updateWipeBanner() {
  if (!nextWipeAt) return;
  const dateText = wipeLabel || new Date(nextWipeAt).toLocaleDateString();
  wipeBanner.textContent = `Unpinned messages and files wipe every 2 weeks. Next: ${dateText} (${formatCountdown(
    nextWipeAt
  )}). Pin to keep (max 500 MB).`;
}

async function loadWipe() {
  const data = await api("/api/wipe");
  nextWipeAt = data.nextWipeAt;
  wipeLabel = data.label || "";
  updateWipeBanner();
}

// ---------- auth + misc wiring ----------
tabLogin.addEventListener("click", () => setMode("login"));
tabRegister.addEventListener("click", () => setMode("register"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(authError, "");
  authSubmit.disabled = true;
  const previous = authSubmit.textContent;
  authSubmit.textContent = mode === "login" ? "Signing in…" : "Creating account…";
  try {
    const path = mode === "login" ? "/api/login" : "/api/register";
    const data = await api(path, {
      method: "POST",
      body: {
        username: $("auth-username").value,
        password: $("auth-password").value,
      },
    });
    me = data.user;
    showApp();
  } catch (err) {
    showError(authError, err.message);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = previous;
  }
});

$("btn-logout").addEventListener("click", async () => {
  await disableNotifications().catch(() => {});
  await api("/api/logout", { method: "POST" });
  showAuth();
});

$("btn-username").addEventListener("click", openEditProfile);
$("me-button").addEventListener("click", () => openProfile(me.username));
$("btn-settings").addEventListener("click", openSettings);
$("side-tab-chats").addEventListener("click", () => setSideTab("chats"));
$("side-tab-pinned").addEventListener("click", () => setSideTab("pinned"));

$("btn-group").addEventListener("click", () => {
  showError(groupError, "");
  $("group-title").value = "";
  $("group-people").value = "";
  groupDialog.showModal();
});

$("group-save").addEventListener("click", async () => {
  showError(groupError, "");
  const title = $("group-title").value;
  const usernames = $("group-people")
    .value.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  try {
    const data = await api("/api/groups", { method: "POST", body: { title, usernames } });
    groupDialog.close();
    await refreshConversations();
    const item = conversations.find((entry) => entry.id === data.id);
    if (item) openConversation(item);
  } catch (err) {
    showError(groupError, err.message);
  }
});

$("group-form").addEventListener("submit", () => groupDialog.close());

addMemberBtn.addEventListener("click", async () => {
  if (!activeId || !activeChat?.isGroup) return;
  if (typeof Groups !== "undefined") {
    Groups.openInfo();
    return;
  }
  const username = window.prompt("Username to add");
  if (!username) return;
  try {
    await api(`/api/conversations/${activeId}/members`, { method: "POST", body: { username } });
    await refreshConversations();
  } catch (err) {
    showError(composeError, err.message);
  }
});

$("back-btn").addEventListener("click", () => {
  appEl.classList.remove("show-chat");
  activeId = null;
  activeChat = null;
  renderConversations();
  sendPresence();
});

userSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = userSearch.value.trim();
  if (!q) {
    searchResults.hidden = true;
    searchResults.replaceChildren();
    return;
  }
  searchTimer = setTimeout(async () => {
    const data = await api(`/api/users?q=${encodeURIComponent(q)}`);
    searchResults.replaceChildren();
    if (!data.users.length) {
      const empty = document.createElement("div");
      empty.className = "search-item";
      empty.textContent = "No users found";
      searchResults.append(empty);
      searchResults.hidden = false;
      return;
    }
    for (const user of data.users) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-item";
      button.textContent = user.username;
      button.style.color = readable(user.nameColor);
      button.addEventListener("click", () => startConversation(user.username));
      searchResults.append(button);
    }
    searchResults.hidden = false;
  }, 150);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-wrap")) searchResults.hidden = true;
});

function renderPendingFiles() {
  filePreview.replaceChildren();
  if (!pendingFiles.length) {
    filePreview.hidden = true;
    return;
  }
  filePreview.hidden = false;
  pendingFiles.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "file-chip";
    chip.textContent = `${file.name} (${formatSize(file.size)}) `;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.addEventListener("click", () => {
      pendingFiles.splice(index, 1);
      renderPendingFiles();
    });
    chip.append(remove);
    filePreview.append(chip);
  });
}

fileInput.addEventListener("change", () => {
  showError(composeError, "");
  const next = [...pendingFiles, ...Array.from(fileInput.files || [])];
  const total = next.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_MESSAGE_BYTES) {
    showError(composeError, "Uploads can be up to 1 GB per message.");
    fileInput.value = "";
    return;
  }
  pendingFiles = next;
  fileInput.value = "";
  renderPendingFiles();
});

compose.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeId) return;
  const body = composeInput.value.trim();
  if (!body && pendingFiles.length === 0) return;
  showError(composeError, "");
  const form = new FormData();
  form.append("body", body);
  const emojiFx = Fx.textToFx(body);
  if (emojiFx) form.append("fx", JSON.stringify(emojiFx));
  Extras.applySendOptions(form);
  for (const file of pendingFiles) form.append("files", file);
  composeInput.value = "";
  const sentFiles = pendingFiles;
  pendingFiles = [];
  renderPendingFiles();
  try {
    const message = await api(`/api/conversations/${activeId}/messages`, {
      method: "POST",
      body: form,
    });
    Extras.clearSendOptions();
    if (isFiltering()) clearFilter();
    stickToBottom = true;
    upsertMessage(message);
    refreshConversations();
  } catch (err) {
    composeInput.value = composeInput.value || body;
    if (!pendingFiles.length) {
      pendingFiles = sentFiles;
      renderPendingFiles();
    }
    showError(composeError, err.message);
  }
});

$("emoji-btn").addEventListener("click", (event) => {
  const picker = $("emoji-picker");
  if (!picker.hidden) {
    Fx.closePicker();
    return;
  }
  Fx.openPicker(event.currentTarget, (emoji) => {
    const token = `:${emoji.name}:`;
    const start = composeInput.selectionStart ?? composeInput.value.length;
    const end = composeInput.selectionEnd ?? start;
    const before = composeInput.value.slice(0, start);
    const pad = before && !before.endsWith(" ") ? " " : "";
    composeInput.value = `${before}${pad}${token} ${composeInput.value.slice(end)}`;
    const caret = before.length + pad.length + token.length + 1;
    composeInput.setSelectionRange(caret, caret);
  });
});

$("fx-btn").addEventListener("click", () => Fx.openEditor(composeInput.value.trim()));
$("settings-emojis").addEventListener("click", () => {
  cancelSettings();
  Fx.openManager();
});

setInterval(updateWipeBanner, 30000);
document.addEventListener("visibilitychange", sendPresence);
window.addEventListener("focus", sendPresence);
window.addEventListener("blur", sendPresence);

// A notification was tapped while the app was already open.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "open-chat") return;
    const chat = conversations.find((c) => c.id === event.data.conversationId);
    if (chat) openConversation(chat);
    else pendingOpen = event.data.conversationId;
  });
}

// If a profile picture's file is missing on the server, show the default
// logo instead of a broken image.
document.addEventListener(
  "error",
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.src.includes("/api/avatars/")) return;
    img.src = "/assets/SmallLogo.png";
  },
  true
);

registerServiceWorker();

(async function boot() {
  try {
    const data = await api("/api/me");
    if (data.user) {
      me = data.user;
      showApp();
      return;
    }
  } catch {
    // fall through
  }
  showAuth();
})();

// ---------- forwarding ----------
let forwarding = null;
const forwardPicked = new Set();

function renderForwardList() {
  const list = $("forward-list");
  const q = $("forward-search").value.trim().toLowerCase();
  list.replaceChildren();
  const chats = conversations.filter(
    (item) => !item.blocked && (!q || chatName(item).toLowerCase().includes(q))
  );
  if (!chats.length) {
    const empty = document.createElement("p");
    empty.textContent = "No chats found.";
    list.append(empty);
  }
  for (const item of chats) {
    const row = document.createElement("label");
    row.className = "forward-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = forwardPicked.has(item.id);
    box.addEventListener("change", () => {
      if (box.checked) forwardPicked.add(item.id);
      else forwardPicked.delete(item.id);
      paintForwardButton();
    });
    const avatar = document.createElement("img");
    avatar.className = "list-avatar";
    avatar.src = item.avatarUrl || "/assets/SmallLogo.png";
    avatar.alt = "";
    const name = document.createElement("span");
    name.textContent = chatName(item) + (item.id === activeId ? " (this chat)" : "");
    row.append(box, avatar, name);
    list.append(row);
  }
}

function paintForwardButton() {
  const button = $("forward-send");
  button.disabled = forwardPicked.size === 0;
  button.textContent = forwardPicked.size > 1 ? `Forward to ${forwardPicked.size}` : "Forward";
}

function openForward(message) {
  forwarding = message;
  forwardPicked.clear();
  $("forward-search").value = "";
  showError($("forward-error"), "");
  renderForwardList();
  paintForwardButton();
  $("forward-dialog").showModal();
}

$("forward-search").addEventListener("input", renderForwardList);

$("forward-send").addEventListener("click", async () => {
  if (!forwarding || !forwardPicked.size) return;
  const button = $("forward-send");
  button.disabled = true;
  button.textContent = "Forwarding…";
  try {
    const data = await api(`/api/messages/${forwarding.id}/forward`, {
      method: "POST",
      body: { conversationIds: [...forwardPicked] },
    });
    if (data.skipped?.length && !data.sent.length) {
      showError($("forward-error"), "Couldn't forward to those chats.");
      paintForwardButton();
      return;
    }
    $("forward-dialog").close();
    refreshConversations();
  } catch (err) {
    showError($("forward-error"), err.message);
    paintForwardButton();
  }
});

// ---------- reactions ----------
function reactionKey(pick) {
  return pick.unicode ? `u:${pick.unicode}` : `c:${pick.fileId}:${pick.name}`;
}

async function sendReaction(message, key) {
  try {
    const updated = await api(`/api/messages/${message.id}/react`, { method: "POST", body: { key } });
    upsertMessage(updated, true);
  } catch (err) {
    showError(composeError, err.message);
  }
}

function openReactionPicker(anchor, message) {
  const picker = $("emoji-picker");
  if (!picker.hidden) {
    Fx.closePicker();
    return;
  }
  Fx.openPicker(
    anchor,
    (pick) => {
      Fx.closePicker();
      sendReaction(message, reactionKey(pick));
    },
    { quick: true }
  );
}

function renderReactions(message) {
  const row = document.createElement("div");
  row.className = "reactions";
  for (const r of message.reactions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction" + (r.mine ? " mine" : "");
    chip.title = r.names.join(", ");
    if (r.key.startsWith("u:")) {
      const face = document.createElement("span");
      face.className = "reaction-face";
      face.textContent = r.key.slice(2);
      chip.append(face);
    } else {
      const [, fileId, name] = r.key.split(":");
      chip.append(Fx.emojiImg(fileId, name));
    }
    const count = document.createElement("span");
    count.textContent = String(r.count);
    chip.append(count);
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      sendReaction(message, r.key);
    });
    row.append(chip);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "reaction react-add";
  add.textContent = "+";
  add.title = "Add a reaction";
  add.addEventListener("click", (event) => {
    event.stopPropagation();
    openReactionPicker(event.currentTarget, message);
  });
  row.append(add);
  return row;
}
