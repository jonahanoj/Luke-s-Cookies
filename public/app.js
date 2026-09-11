const authEl = document.getElementById("auth");
const appEl = document.getElementById("app");
const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");
const authForm = document.getElementById("auth-form");
const authSubmit = document.getElementById("auth-submit");
const authError = document.getElementById("auth-error");
const meName = document.getElementById("me-name");
const meAvatar = document.getElementById("me-avatar");
const userSearch = document.getElementById("user-search");
const searchResults = document.getElementById("search-results");
const conversationList = document.getElementById("conversation-list");
const emptyChat = document.getElementById("empty-chat");
const thread = document.getElementById("thread");
const threadName = document.getElementById("thread-name");
const messagesEl = document.getElementById("messages");
const compose = document.getElementById("compose");
const composeInput = document.getElementById("compose-input");
const composeError = document.getElementById("compose-error");
const fileInput = document.getElementById("file-input");
const filePreview = document.getElementById("file-preview");
const wipeBanner = document.getElementById("wipe-banner");
const usernameDialog = document.getElementById("username-dialog");
const usernameForm = document.getElementById("username-form");
const newUsername = document.getElementById("new-username");
const usernameError = document.getElementById("username-error");
const groupDialog = document.getElementById("group-dialog");
const groupError = document.getElementById("group-error");
const addMemberBtn = document.getElementById("btn-add-member");
const pfpPreview = document.getElementById("pfp-preview");
const svCanvas = document.getElementById("sv-canvas");
const hueSlider = document.getElementById("hue-slider");
const colorPreview = document.getElementById("color-preview");

const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;
const MAX_PIN_BYTES = 500 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a)$/i;

let mode = "login";
let me = null;
let conversations = [];
let activeId = null;
let socket = null;
let searchTimer = null;
let pendingFiles = [];
let nextWipeAt = null;
let wipeLabel = "";
let activeChat = null;
let hsv = { h: 140, s: 0.35, v: 0.55 };

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("theme", dark ? "dark" : "light");
  for (const button of document.querySelectorAll(".theme-toggle")) {
    button.textContent = dark ? "Light" : "Dark";
  }
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) {
    applyTheme(saved);
    return;
  }
  applyTheme(
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
}

function showError(el, message) {
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setMode(next) {
  mode = next;
  tabLogin.classList.toggle("active", next === "login");
  tabRegister.classList.toggle("active", next === "register");
  authSubmit.textContent = next === "login" ? "Log in" : "Create account";
  document.getElementById("auth-password").autocomplete =
    next === "login" ? "current-password" : "new-password";
}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isForm) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
    body: options.body
      ? isForm
        ? options.body
        : JSON.stringify(options.body)
      : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
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

function updateWipeBanner() {
  if (!nextWipeAt) return;
  const dateText = wipeLabel || new Date(nextWipeAt).toLocaleDateString();
  wipeBanner.textContent = `Unpinned messages wipe on ${dateText} · ${formatCountdown(
    nextWipeAt
  )} left. Pin one to keep it (max 500 MB).`;
}

function fileKind(file) {
  const mime = String(file.mime || "");
  const name = String(file.name || "");
  if (mime.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXT.test(name)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXT.test(name)) return "audio";
  return "file";
}

function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hexToHsv(hex) {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max ? d / max : 0;
  return { h, s, v: max };
}

function currentHex() {
  return hsvToHex(hsv.h, hsv.s, hsv.v);
}

function drawSv() {
  const ctx = svCanvas.getContext("2d");
  const { width, height } = svCanvas;
  const hue = hsvToHex(hsv.h, 1, 1);
  ctx.fillStyle = hue;
  ctx.fillRect(0, 0, width, height);
  const white = ctx.createLinearGradient(0, 0, width, 0);
  white.addColorStop(0, "#fff");
  white.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = white;
  ctx.fillRect(0, 0, width, height);
  const black = ctx.createLinearGradient(0, 0, 0, height);
  black.addColorStop(0, "rgba(0,0,0,0)");
  black.addColorStop(1, "#000");
  ctx.fillStyle = black;
  ctx.fillRect(0, 0, width, height);
  colorPreview.style.color = currentHex();
  colorPreview.textContent = me?.username || "Preview";
}

function paintMe() {
  meName.textContent = me.username;
  meName.style.color = me.nameColor || "";
  meAvatar.src = me.avatarUrl || "/assets/SmallLogo.png";
}

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

function connectSocket() {
  if (socket) socket.close();
  socket = io();
  socket.on("message", (payload) => {
    refreshConversations();
    if (payload.conversationId !== activeId) return;
    upsertMessage(payload);
  });
  socket.on("message-updated", (payload) => {
    if (payload.conversationId !== activeId) return;
    upsertMessage(payload, true);
  });
  socket.on("username-changed", async () => {
    await refreshConversations();
  });
  socket.on("profile-changed", async () => {
    await refreshConversations();
    if (activeId) {
      const current = conversations.find((item) => item.id === activeId);
      if (current) openConversation(current);
    }
  });
  socket.on("wiped", async () => {
    await refreshConversations();
    if (activeId) {
      const current = conversations.find((item) => item.id === activeId);
      if (current) openConversation(current);
    }
  });
}

function showApp() {
  authEl.hidden = true;
  appEl.hidden = false;
  document.getElementById("theme-toggle-auth").hidden = true;
  paintMe();
  connectSocket();
  refreshConversations();
  loadWipe();
}

function showAuth() {
  authEl.hidden = false;
  appEl.hidden = true;
  document.getElementById("theme-toggle-auth").hidden = false;
  me = null;
  activeId = null;
  activeChat = null;
  pendingFiles = [];
  renderPendingFiles();
  if (socket) {
    socket.close();
    socket = null;
  }
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

function makeAvatar(name, url, color) {
  const wrap = document.createElement("div");
  wrap.className = "avatar";
  wrap.style.background = color || "";
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    wrap.append(img);
  } else {
    wrap.textContent = (name[0] || "?").toUpperCase();
  }
  return wrap;
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
    name.textContent = item.isGroup ? item.title || item.username : item.username;
    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = item.lastMessage || "No messages yet";
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
      threadName.textContent = current.isGroup
        ? current.title || current.username
        : current.username;
    }
  }
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
      img.src = url;
      img.alt = file.name;
      wrap.append(img);
    } else if (kind === "video") {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.preload = "metadata";
      wrap.append(video);
    } else if (kind === "audio") {
      const audio = document.createElement("audio");
      audio.src = url;
      audio.controls = true;
      audio.preload = "metadata";
      wrap.append(audio);
    }
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${file.name} (${formatSize(file.size)})`;
    wrap.append(link);
  }
  return wrap;
}

function upsertMessage(message, replace = false) {
  const existing = messagesEl.querySelector(`[data-id="${message.id}"]`);
  if (existing && !replace) return;

  const whoName = message.mine
    ? "You"
    : message.username || activeChat?.username || "Them";
  const row = document.createElement("div");
  row.className = "row " + (message.mine ? "mine" : "theirs");
  row.dataset.id = message.id;

  const avatarUrl = message.mine ? me?.avatarUrl : message.avatarUrl;
  const avatar = makeAvatar(whoName, avatarUrl, message.nameColor);

  const bubble = document.createElement("div");
  bubble.className =
    "bubble " +
    (message.mine ? "mine" : "theirs") +
    (message.pinned ? " pinned" : "");

  const top = document.createElement("div");
  top.className = "bubble-top";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = message.pinned ? `${whoName} · Pinned` : whoName;
  who.style.color = message.mine
    ? me?.nameColor || message.nameColor
    : message.nameColor || "";
  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "pin-btn";
  const tooBig = (message.totalSize || 0) > MAX_PIN_BYTES;
  pinBtn.textContent = message.pinned
    ? "Unpin"
    : tooBig
      ? "Too big to pin"
      : "Pin";
  pinBtn.disabled = !message.pinned && tooBig;
  pinBtn.addEventListener("click", async () => {
    try {
      showError(composeError, "");
      const path = message.pinned
        ? `/api/messages/${message.id}/unpin`
        : `/api/messages/${message.id}/pin`;
      const updated = await api(path, { method: "POST" });
      upsertMessage(updated, true);
    } catch (err) {
      showError(composeError, err.message);
    }
  });
  top.append(who, pinBtn);
  bubble.append(top);

  if (message.body) {
    const text = document.createElement("div");
    text.textContent = message.body;
    bubble.append(text);
  }
  const files = renderAttachments(message);
  if (files) bubble.append(files);
  const time = document.createElement("time");
  time.textContent = formatTime(message.createdAt);
  bubble.append(time);

  row.append(avatar, bubble);
  if (existing) existing.replaceWith(row);
  else messagesEl.append(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function openConversation(item) {
  activeId = item.id;
  activeChat = item;
  appEl.classList.add("show-chat");
  emptyChat.hidden = true;
  thread.hidden = false;
  threadName.textContent = item.isGroup ? item.title || item.username : item.username;
  addMemberBtn.hidden = !item.isGroup;
  renderConversations();
  const data = await api(`/api/conversations/${item.id}/messages`);
  messagesEl.replaceChildren();
  for (const message of data.messages) upsertMessage(message);
  composeInput.focus();
}

async function startConversation(username) {
  const data = await api("/api/conversations", {
    method: "POST",
    body: { username },
  });
  userSearch.value = "";
  searchResults.hidden = true;
  await refreshConversations();
  const item = conversations.find((entry) => entry.id === data.id) || {
    id: data.id,
    username: data.username,
    isGroup: false,
    lastMessage: null,
  };
  openConversation(item);
}

async function loadWipe() {
  const data = await api("/api/wipe");
  nextWipeAt = data.nextWipeAt;
  wipeLabel = data.label || "";
  updateWipeBanner();
}

function openProfile() {
  showError(usernameError, "");
  newUsername.value = me.username;
  pfpPreview.src = me.avatarUrl || "/assets/SmallLogo.png";
  hsv = hexToHsv(me.nameColor || "#6e8070");
  hueSlider.value = String(Math.round(hsv.h));
  drawSv();
  usernameDialog.showModal();
}

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
        username: document.getElementById("auth-username").value,
        password: document.getElementById("auth-password").value,
      },
    });
    me = data.user;
    showApp();
  } catch (err) {
    showError(authError, err.message);
    authSubmit.disabled = false;
    authSubmit.textContent = previous;
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showAuth();
});

document.getElementById("btn-username").addEventListener("click", openProfile);

document.getElementById("pfp-input").addEventListener("change", async (event) => {
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

hueSlider.addEventListener("input", () => {
  hsv.h = Number(hueSlider.value);
  drawSv();
});

svCanvas.addEventListener("pointerdown", (event) => {
  const box = svCanvas.getBoundingClientRect();
  const pick = (ev) => {
    const x = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height));
    hsv.s = x;
    hsv.v = 1 - y;
    drawSv();
  };
  pick(event);
  const move = (ev) => pick(ev);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

document.getElementById("username-save").addEventListener("click", async () => {
  showError(usernameError, "");
  try {
    const nameData = await api("/api/username", {
      method: "POST",
      body: { username: newUsername.value },
    });
    const colorData = await api("/api/color", {
      method: "POST",
      body: { color: currentHex() },
    });
    me = { ...nameData.user, ...colorData.user };
    paintMe();
    usernameDialog.close();
  } catch (err) {
    showError(usernameError, err.message);
  }
});

usernameForm.addEventListener("submit", () => {
  usernameDialog.close();
});

document.getElementById("btn-group").addEventListener("click", () => {
  showError(groupError, "");
  document.getElementById("group-title").value = "";
  document.getElementById("group-people").value = "";
  groupDialog.showModal();
});

document.getElementById("group-save").addEventListener("click", async () => {
  showError(groupError, "");
  const title = document.getElementById("group-title").value;
  const usernames = document
    .getElementById("group-people")
    .value.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  try {
    const data = await api("/api/groups", {
      method: "POST",
      body: { title, usernames },
    });
    groupDialog.close();
    await refreshConversations();
    const item = conversations.find((entry) => entry.id === data.id);
    if (item) openConversation(item);
  } catch (err) {
    showError(groupError, err.message);
  }
});

document.getElementById("group-form").addEventListener("submit", () => {
  groupDialog.close();
});

addMemberBtn.addEventListener("click", async () => {
  if (!activeId || !activeChat?.isGroup) return;
  const username = window.prompt("Username to add");
  if (!username) return;
  try {
    await api(`/api/conversations/${activeId}/members`, {
      method: "POST",
      body: { username },
    });
    await refreshConversations();
  } catch (err) {
    showError(composeError, err.message);
  }
});

document.getElementById("back-btn").addEventListener("click", () => {
  appEl.classList.remove("show-chat");
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
      button.style.color = user.nameColor || "";
      button.addEventListener("click", () => startConversation(user.username));
      searchResults.append(button);
    }
    searchResults.hidden = false;
  }, 150);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-wrap")) {
    searchResults.hidden = true;
  }
});

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
  for (const file of pendingFiles) form.append("files", file);
  composeInput.value = "";
  pendingFiles = [];
  renderPendingFiles();
  try {
    const message = await api(`/api/conversations/${activeId}/messages`, {
      method: "POST",
      body: form,
    });
    upsertMessage(message);
    refreshConversations();
  } catch (err) {
    showError(composeError, err.message);
  }
});

setInterval(updateWipeBanner, 30000);

for (const button of document.querySelectorAll(".theme-toggle")) {
  button.addEventListener("click", () => {
    applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
  });
}

initTheme();

(async function boot() {
  try {
    const data = await api("/api/me");
    if (data.user) {
      me = data.user;
      showApp();
    }
  } catch {
    showAuth();
  }
})();
