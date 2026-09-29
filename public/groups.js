// Group chat management (name, picture, people, leaving) and group tasks.
// Loaded after app.js and uses its globals.

const Groups = (() => {
  const dialog = $("groupinfo-dialog");
  const errorEl = $("groupinfo-error");
  const tasksPanel = $("tasks-panel");
  const taskList = $("task-list");
  const taskError = $("task-error");
  const filterTasks = $("filter-tasks");
  let view = "messages";
  let tasks = [];

  // ---------- thread view: messages vs tasks ----------
  function setView(next) {
    view = next;
    const isTasks = next === "tasks";
    filterTasks.classList.toggle("active", isTasks);
    if (isTasks) {
      filterAll.classList.remove("active");
      filterPinned.classList.remove("active");
    }
    tasksPanel.hidden = !isTasks;
    messagesEl.hidden = isTasks;
    chatSearch.hidden = isTasks;
    compose.hidden = isTasks || Boolean(activeChat?.blocked);
    if (isTasks) {
      filterStatus.hidden = true;
      loadTasks();
    } else {
      updateFilterStatus();
    }
  }

  filterTasks.addEventListener("click", () => setView("tasks"));
  filterAll.addEventListener("click", () => view === "tasks" && setView("messages"));
  filterPinned.addEventListener("click", () => view === "tasks" && setView("messages"));

  // Called by app.js whenever a chat is opened or its header repainted.
  function onThreadOpened(chat, switching) {
    filterTasks.hidden = !chat?.isGroup;
    if (switching || !chat?.isGroup) {
      if (view === "tasks") setView("messages");
    }
  }

  // ---------- tasks ----------
  async function loadTasks() {
    if (!activeChat?.isGroup) return;
    const id = activeChat.id;
    try {
      const data = await api(`/api/conversations/${id}/tasks`);
      if (activeChat?.id !== id) return;
      tasks = data.tasks;
      renderTasks();
    } catch (err) {
      showError(taskError, err.message);
    }
  }

  function renderTasks() {
    taskList.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "empty-list";
      empty.textContent = "No tasks yet. Tasks never get wiped.";
      taskList.append(empty);
      return;
    }
    const ordered = [...tasks].sort((a, b) => Number(a.done) - Number(b.done));
    for (const task of ordered) {
      const row = document.createElement("div");
      row.className = "task" + (task.done ? " done" : "");

      if (task.kind === "percent") {
        const top = document.createElement("div");
        top.className = "task-top";
        const title = document.createElement("span");
        title.className = "task-title";
        title.textContent = task.title;
        const pct = document.createElement("input");
        pct.type = "number";
        pct.min = "0";
        pct.max = "100";
        pct.value = String(task.percent);
        pct.className = "task-pct";
        pct.setAttribute("aria-label", "Percent complete");
        const sign = document.createElement("span");
        sign.textContent = "%";
        top.append(title, pct, sign);
        const bar = document.createElement("input");
        bar.type = "range";
        bar.min = "0";
        bar.max = "100";
        bar.value = String(task.percent);
        bar.className = "task-bar";
        bar.style.setProperty("--pct", `${task.percent}%`);
        bar.addEventListener("input", () => {
          pct.value = bar.value;
          bar.style.setProperty("--pct", `${bar.value}%`);
        });
        const commit = (value) => updateTask(task, { percent: Number(value) });
        bar.addEventListener("change", () => commit(bar.value));
        pct.addEventListener("change", () => {
          const value = Math.min(100, Math.max(0, Math.round(Number(pct.value) || 0)));
          pct.value = String(value);
          bar.value = String(value);
          commit(value);
        });
        row.append(top, bar);
      } else {
        const label = document.createElement("label");
        label.className = "task-top";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = task.done;
        box.addEventListener("change", () => updateTask(task, { done: box.checked }));
        const title = document.createElement("span");
        title.className = "task-title";
        title.textContent = task.title;
        label.append(box, title);
        row.append(label);
      }

      const meta = document.createElement("div");
      meta.className = "task-meta";
      const who = document.createElement("span");
      who.textContent = `${task.createdBy ? `Added by ${task.createdBy}` : "Task"}${
        task.done ? " · Complete" : ""
      }`;
      const actions = document.createElement("span");
      if (task.kind === "percent" && !task.done) {
        const finish = document.createElement("button");
        finish.type = "button";
        finish.className = "btn ghost small";
        finish.textContent = "Mark complete";
        finish.addEventListener("click", () => updateTask(task, { done: true }));
        actions.append(finish);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn ghost small danger";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        try {
          await api(`/api/tasks/${task.id}`, { method: "DELETE" });
          tasks = tasks.filter((item) => item.id !== task.id);
          renderTasks();
        } catch (err) {
          showError(taskError, err.message);
        }
      });
      actions.append(del);
      meta.append(who, actions);
      row.append(meta);
      taskList.append(row);
    }
  }

  async function updateTask(task, changes) {
    showError(taskError, "");
    try {
      const data = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: changes });
      tasks = tasks.map((item) => (item.id === task.id ? data.task : item));
      renderTasks();
    } catch (err) {
      showError(taskError, err.message);
    }
  }

  $("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeChat?.isGroup) return;
    const title = $("task-title").value.trim();
    if (!title) return;
    showError(taskError, "");
    try {
      const data = await api(`/api/conversations/${activeChat.id}/tasks`, {
        method: "POST",
        body: { title, kind: $("task-kind").value },
      });
      $("task-title").value = "";
      if (!tasks.some((item) => item.id === data.task.id)) tasks.push(data.task);
      renderTasks();
    } catch (err) {
      showError(taskError, err.message);
    }
  });

  function onTasksChanged(conversationId) {
    if (view === "tasks" && activeChat?.id === conversationId) loadTasks();
  }

  // ---------- group info ----------
  let infoFor = null;

  async function openInfo() {
    if (!activeChat?.isGroup) return;
    infoFor = activeChat.id;
    showError(errorEl, "");
    $("groupinfo-add-name").value = "";
    paintInfoHeader();
    await loadMembers();
    if (!dialog.open) dialog.showModal();
  }

  function paintInfoHeader() {
    const chat = conversations.find((item) => item.id === infoFor) || activeChat;
    $("groupinfo-avatar").src = chat.avatarUrl || "/assets/SmallLogo.png";
    $("groupinfo-name").value = chat.title || chat.username || "";
    $("groupinfo-note").textContent = chat.createdBy
      ? `Made by ${chat.createdBy}. Anyone in the group can rename it, change the picture and add people.${
          chat.isCreator ? " Only you can remove people." : ""
        }`
      : "Anyone in the group can rename it, change the picture, and add or remove people.";
  }

  async function loadMembers() {
    const list = $("groupinfo-members");
    let data;
    try {
      data = await api(`/api/conversations/${infoFor}/members`);
    } catch (err) {
      showError(errorEl, err.message);
      return;
    }
    const chat = conversations.find((item) => item.id === infoFor) || activeChat;
    list.replaceChildren();
    for (const member of data.members) {
      const row = document.createElement("div");
      row.className = "member";
      const avatar = document.createElement("img");
      avatar.className = "list-avatar";
      avatar.src = member.avatarUrl || "/assets/SmallLogo.png";
      avatar.alt = "";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "member-name";
      name.textContent = member.isMe ? `${member.username} (you)` : member.username;
      name.style.color = readable(member.nameColor);
      name.addEventListener("click", () => openProfile(member.username));
      row.append(avatar, name);
      if (member.isCreator) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "Creator";
        row.append(tag);
      }
      if (chat?.canRemove && !member.isMe) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn ghost small danger";
        remove.textContent = "Remove";
        remove.addEventListener("click", async () => {
          if (!confirm(`Remove ${member.username} from the group?`)) return;
          try {
            await api(
              `/api/conversations/${infoFor}/members/${encodeURIComponent(member.username)}`,
              { method: "DELETE" }
            );
            await loadMembers();
          } catch (err) {
            showError(errorEl, err.message);
          }
        });
        row.append(remove);
      }
      list.append(row);
    }
  }

  $("thread-title").addEventListener("click", () => {
    if (activeChat?.isGroup) openInfo();
  });
  $("groupinfo-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  $("groupinfo-rename").addEventListener("click", async () => {
    showError(errorEl, "");
    try {
      await api(`/api/conversations/${infoFor}`, {
        method: "PATCH",
        body: { title: $("groupinfo-name").value },
      });
      await refreshConversations();
      paintInfoHeader();
    } catch (err) {
      showError(errorEl, err.message);
    }
  });

  $("groupinfo-avatar-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    showError(errorEl, "");
    const form = new FormData();
    form.append("avatar", file);
    try {
      const data = await api(`/api/conversations/${infoFor}/avatar`, { method: "POST", body: form });
      $("groupinfo-avatar").src = data.avatarUrl;
      await refreshConversations();
    } catch (err) {
      showError(errorEl, err.message);
    }
  });

  async function addPerson() {
    const username = $("groupinfo-add-name").value.trim();
    if (!username) return;
    showError(errorEl, "");
    try {
      await api(`/api/conversations/${infoFor}/members`, { method: "POST", body: { username } });
      $("groupinfo-add-name").value = "";
      await loadMembers();
      refreshConversations();
    } catch (err) {
      showError(errorEl, err.message);
    }
  }

  $("groupinfo-add").addEventListener("click", addPerson);
  $("groupinfo-add-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addPerson();
    }
  });

  $("groupinfo-leave").addEventListener("click", async () => {
    const chat = conversations.find((item) => item.id === infoFor);
    if (!confirm(`Leave ${chat?.title || "this group"}?`)) return;
    try {
      await api(`/api/conversations/${infoFor}/leave`, { method: "POST" });
      dialog.close();
      closeThread();
      await refreshConversations();
    } catch (err) {
      showError(errorEl, err.message);
    }
  });

  function closeThread() {
    activeId = null;
    activeChat = null;
    thread.hidden = true;
    emptyChat.hidden = false;
    appEl.classList.remove("show-chat");
    if (view === "tasks") setView("messages");
    sendPresence();
    renderConversations();
  }

  // Someone renamed/re-pictured the group, added or removed people, or left.
  async function onConversationUpdated(conversationId) {
    await refreshConversations();
    const stillIn = conversations.some((item) => item.id === conversationId);
    if (activeId === conversationId && !stillIn) closeThread();
    if (dialog.open && infoFor === conversationId) {
      if (!stillIn) dialog.close();
      else {
        paintInfoHeader();
        loadMembers();
      }
    }
  }

  return { setView, onThreadOpened, onTasksChanged, onConversationUpdated, openInfo };
})();
