const authEl = document.getElementById("auth");
const appEl = document.getElementById("app");
const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");
const authForm = document.getElementById("auth-form");
const authSubmit = document.getElementById("auth-submit");
const authError = document.getElementById("auth-error");
const meName = document.getElementById("me-name");
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

const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024;
const MAX_PIN_BYTES = 500 * 1024 * 1024;

let mode = "login";
let me = null;
let conversations = [];
let activeId = null;
let socket = null;
let searchTimer = null;
let pendingFiles = [];
let nextWipeAt = null;
let wipeLabel = "";

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

function pendingTotal() {
  return pendingFiles.reduce((sum, file) => sum + file.size, 0);
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
  meName.textContent = me.username;
  connectSocket();
  refreshConversations();
  loadWipe();
}

function showAuth() {
  authEl.hidden = false;
  appEl.hidden = true;
  me = null;
  activeId = null;
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

function renderConversations() {
  conversationList.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "No chats yet. Search a username to start one.";
    conversationList.append(empty);
    return;
  }
  for (const item of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation" + (item.id === activeId ? " active" : "");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.username;
    const preview = document.createElement("span");
    preview.className = "preview";
    preview.textContent = item.lastMessage || "No messages yet";
    button.append(name, preview);
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
    if (current) threadName.textContent = current.username;
  }
}

function renderAttachments(message) {
  if (!message.attachments?.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "attach-list";
  for (const file of message.attachments) {
    const url = `/api/attachments/${file.id}`;
    const mime = String(file.mime || "");
    if (mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = file.name;
      wrap.append(img);
    } else if (mime.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.preload = "metadata";
      wrap.append(video);
    } else if (mime.startsWith("audio/")) {
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
  const bubble = document.createElement("div");
  bubble.className =
    "bubble " +
    (message.mine ? "mine" : "theirs") +
    (message.pinned ? " pinned" : "");
  bubble.dataset.id = message.id;

  const top = document.createElement("div");
  top.className = "bubble-top";
  const pinLabel = document.createElement("span");
  pinLabel.textContent = message.pinned ? "Pinned" : "";
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
  top.append(pinLabel, pinBtn);

  if (message.body) {
    const text = document.createElement("div");
    text.textContent = message.body;
    bubble.append(top, text);
  } else {
    bubble.append(top);
  }
  const files = renderAttachments(message);
  if (files) bubble.append(files);
  const time = document.createElement("time");
  time.textContent = formatTime(message.createdAt);
  bubble.append(time);

  if (existing) existing.replaceWith(bubble);
  else messagesEl.append(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function openConversation(item) {
  activeId = item.id;
  appEl.classList.add("show-chat");
  emptyChat.hidden = true;
  thread.hidden = false;
  threadName.textContent = item.username;
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

document.getElementById("btn-username").addEventListener("click", () => {
  showError(usernameError, "");
  newUsername.value = me.username;
  usernameDialog.showModal();
});

document.getElementById("username-save").addEventListener("click", async () => {
  showError(usernameError, "");
  try {
    const data = await api("/api/username", {
      method: "POST",
      body: { username: newUsername.value },
    });
    me = data.user;
    meName.textContent = me.username;
    usernameDialog.close();
  } catch (err) {
    showError(usernameError, err.message);
  }
});

usernameForm.addEventListener("submit", () => {
  usernameDialog.close();
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
