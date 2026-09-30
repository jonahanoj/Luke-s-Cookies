// Crumbs: build little interactive cards (buttons, timers, counters, images)
// with no code, and play them together in chat. Rules run on the server via
// CrumbsEngine so everyone in the chat sees the same thing.

const Crumbs = (() => {
  const E = window.CrumbsEngine;
  const LABELS = {
    button: "Button",
    text: "Text",
    image: "Image",
    counter: "Counter",
    timer: "Timer display",
    box: "Box",
    grid: "Grid",
  };

  // ---------- drawing a crumb ----------
  function fmtTimer(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // opts: { assetUrl(id), onPress(el), now(), editing, selectedId, onSelect(el, event) }
  // Existing element nodes are reused between redraws, so a click that's in
  // progress while the card updates still counts.
  function draw(card, def, state, opts) {
    card.style.aspectRatio = String(E.ASPECTS[def.aspect] || 1);
    card.style.background = def.bg || "#fff7ec";
    card.classList.add("crumb-card");
    const old = new Map();
    for (const child of [...card.children]) {
      if (child.dataset.el) old.set(child.dataset.el, child);
      else child.remove();
    }
    const byId = new Map(def.elements.map((el) => [el.id, el]));
    card.onclick =
      !opts.editing && opts.onPress
        ? (event) => {
            const node = event.target.closest("[data-el]");
            if (!node || !card.contains(node)) return;
            event.stopPropagation();
            const cell = event.target.closest("[data-cell]");
            opts.onPress(node.dataset.el, node, cell ? Number(cell.dataset.cell) : undefined);
          }
        : null;
    card.onpointerdown = opts.editing
      ? (event) => {
          const node = event.target.closest("[data-el]");
          if (node && card.contains(node) && byId.has(node.dataset.el)) opts.onSelect?.(byId.get(node.dataset.el), event, node);
        }
      : null;
    let index = 0;
    for (const el of def.elements) {
      const visible = state.vis[el.id] !== false;
      if (!visible && !opts.editing) continue;
      const pos = state.pos?.[el.id];
      const tag = el.type === "button" ? "BUTTON" : "DIV";
      let node = old.get(el.id);
      if (node && node.tagName !== tag) node = null;
      if (node) old.delete(el.id);
      else {
        node = document.createElement(tag);
        if (el.type === "button") node.type = "button";
        node.dataset.el = el.id;
      }
      node.className = `crumb-el crumb-${el.type} shape-${el.shape}`;
      if (!visible) node.classList.add("crumb-hidden");
      if (opts.selectedId === el.id) node.classList.add("selected");
      node.style.left = `${pos ? pos.x : el.x}%`;
      node.style.top = `${pos ? pos.y : el.y}%`;
      node.style.width = `${el.w}%`;
      node.style.height = `${el.h}%`;
      node.style.setProperty("--s", el.size);
      node.style.color = el.textColor || "#1b1b1b";
      const fill = state.color?.[el.id] || el.color;
      node.style.background = fill && el.type !== "image" ? fill : "";
      const text = state.text?.[el.id] ?? el.text;
      node.querySelector(".crumb-resize")?.remove();
      node.classList.toggle("crumb-off", Boolean(state.off?.[el.id]));
      if (el.type === "grid") {
        // A board of cells. Each cell shows its value (X, O, 🔴, …).
        const list = state.grid?.[el.id] || el.cells || Array(el.cols * el.rows).fill("");
        node.style.setProperty("--cols", el.cols);
        node.style.setProperty("--rows", el.rows);
        node.style.background = el.lines || "#3b2a1a";
        const total = el.cols * el.rows;
        if (node.children.length !== total || node.querySelector(":scope > :not(.crumb-cell)")) {
          node.replaceChildren();
          for (let i = 0; i < total; i += 1) {
            const cell = document.createElement(opts.editing ? "div" : "button");
            if (!opts.editing) cell.type = "button";
            cell.className = "crumb-cell";
            cell.dataset.cell = String(i);
            node.append(cell);
          }
        }
        [...node.children].forEach((cell, i) => {
          const v = list[i] || "";
          if (cell.textContent !== v) cell.textContent = v;
          cell.style.background = el.color || "#ffe2b8";
          cell.classList.toggle("filled", Boolean(v));
        });
        if (opts.editing && opts.selectedId === el.id) {
          const handle = document.createElement("span");
          handle.className = "crumb-resize";
          handle.dataset.resize = "1";
          node.append(handle);
        }
        if (card.children[index] !== node) card.insertBefore(node, card.children[index] || null);
        index += 1;
        continue;
      }
      if (el.type === "image") {
        const src = opts.assetUrl(state.img?.[el.id] || el.asset);
        let img = node.querySelector("img");
        if (!img || node.childNodes.length !== 1) {
          node.replaceChildren();
          img = document.createElement("img");
          img.alt = "";
          img.draggable = false;
          node.append(img);
        }
        if (img.getAttribute("src") !== src) img.src = src;
      } else {
        let label = text;
        if (el.type === "counter") label = `${text || ""}${state.num?.[el.id] ?? el.value ?? 0}`;
        else if (el.type === "timer") {
          const end = state.timers?.[el.timer];
          const timer = def.timers.find((t) => t.id === el.timer);
          const left = end ? end - opts.now() : (timer?.secs || 0) * 1000;
          label = `${text || ""}${fmtTimer(left)}`;
          node.classList.toggle("running", Boolean(end));
        }
        if (node.textContent !== (label ?? "") || node.children.length) node.textContent = label ?? "";
      }
      if (!opts.editing && opts.onPress) {
        const pressable = def.rules.some((r) => r.when.on === "press" && r.when.el === el.id);
        if (pressable) node.classList.add("pressable");
      }
      if (opts.editing && opts.selectedId === el.id) {
        const handle = document.createElement("span");
        handle.className = "crumb-resize";
        handle.dataset.resize = "1";
        node.append(handle);
      }
      if (card.children[index] !== node) card.insertBefore(node, card.children[index] || null);
      index += 1;
    }
    for (const node of old.values()) node.remove();
  }

  // ---------- per-crumb mute (remembered on this device) ----------
  const MUTE_KEY = "lc-muted-crumbs";
  let mutedIds = new Set();
  try {
    mutedIds = new Set(JSON.parse(localStorage.getItem(MUTE_KEY) || "[]"));
  } catch {}
  const playing = new Map(); // messageId -> Set<Audio>

  function isMuted(id) {
    return Boolean(id) && mutedIds.has(id);
  }

  function setMuted(id, muted) {
    if (muted) mutedIds.add(id);
    else mutedIds.delete(id);
    try {
      localStorage.setItem(MUTE_KEY, JSON.stringify([...mutedIds].slice(-500)));
    } catch {}
    if (muted) {
      for (const audio of playing.get(id) || []) audio.pause();
      playing.delete(id);
    }
  }

  function hasSound(def) {
    return JSON.stringify(def || {}).includes('"a":"sound"');
  }

  function playFired(fired, assetUrl, id = null) {
    for (const f of fired || []) {
      if (f.a === "screen") Fx.screenPulse(f.kind, f.secs);
      else if (f.a === "sound") {
        if (isMuted(id)) continue;
        const audio = new Audio(assetUrl(f.asset));
        if (id) {
          if (!playing.has(id)) playing.set(id, new Set());
          playing.get(id).add(audio);
          audio.addEventListener("ended", () => playing.get(id)?.delete(audio));
        }
        audio.play().catch(() => {});
      }
    }
  }

  // ---------- live crumbs in chat ----------
  const live = new Map(); // messageId -> { def, state, offset, cards:Set, ticking }
  const serverUrl = (id) => `/api/attachments/${id}`;

  function entryFor(message) {
    let entry = live.get(message.id);
    const incoming = message.crumbState;
    if (!entry) {
      entry = { def: message.fx.crumb, state: incoming, server: incoming, offset: 0, cards: new Set(), tickSent: 0, outbox: [] };
      live.set(message.id, entry);
    } else if (JSON.stringify(entry.def) !== JSON.stringify(message.fx.crumb)) {
      // The crumb was edited: start fresh with the new version.
      entry.def = message.fx.crumb;
      entry.state = incoming;
      entry.server = incoming;
      entry.outbox = [];
    } else if (incoming && (incoming.seq || 0) >= (entry.state?.seq || 0)) {
      entry.state = incoming;
      entry.server = incoming;
    }
    if (message.serverNow) entry.offset = message.serverNow - Date.now();
    return entry;
  }

  function redrawEntry(id) {
    const entry = live.get(id);
    if (!entry) return;
    for (const card of [...entry.cards]) {
      if (!card.isConnected) {
        entry.cards.delete(card);
        continue;
      }
      paintLive(id, card);
    }
  }

  function paintLive(id, card) {
    const entry = live.get(id);
    draw(card, entry.def, entry.state, {
      assetUrl: serverUrl,
      now: () => Date.now() + entry.offset,
      onPress: (el, node, cell) => press(id, cell === undefined ? { type: "press", el } : { type: "press", el, cell }),
    });
  }

  // The server runs the rules and sends back the result (same as before).
  async function press(id, event) {
    const entry = live.get(id);
    if (!entry) return;
    try {
      const data = await api(`/api/messages/${id}/crumb`, { method: "POST", body: { event } });
      applyRemote(data, true);
    } catch (err) {
      showError(composeError, err.message);
    }
  }

  function applyRemote(payload, fromMe = false) {
    const entry = live.get(payload.messageId);
    if (!entry) return;
    if ((payload.state.seq || 0) < (entry.state?.seq || 0)) return;
    const changed = (payload.state.seq || 0) !== (entry.state?.seq || 0);
    entry.state = payload.state;
    entry.server = payload.state;
    if (payload.serverNow) entry.offset = payload.serverNow - Date.now();
    redrawEntry(payload.messageId);
    // Everyone gets the screen effects/sounds once (the socket event), not twice.
    if (changed && fromMe) entry.lastFiredSeq = payload.state.seq;
    if (changed) playFired(payload.fired, serverUrl, payload.messageId);
  }

  function onRemoteState(payload) {
    const entry = live.get(payload.messageId);
    if (!entry) return;
    if (entry.lastFiredSeq === payload.state.seq) return; // already handled from our own press
    applyRemote(payload);
  }

  function renderCard(message) {
    const wrap = document.createElement("div");
    wrap.className = "crumb-wrap";
    const def = message.fx.crumb;
    const sound = hasSound(def);
    if (def.title || sound) {
      const head = document.createElement("div");
      head.className = "crumb-head";
      const title = document.createElement("div");
      title.className = "crumb-title";
      title.textContent = def.title ? `🍪 ${def.title}` : "";
      head.append(title);
      if (sound) {
        const mute = document.createElement("button");
        mute.type = "button";
        mute.className = "crumb-mute";
        const paint = () => {
          const muted = isMuted(message.id);
          mute.textContent = muted ? "🔇" : "🔊";
          mute.title = muted ? "Unmute this crumb" : "Mute this crumb";
          mute.setAttribute("aria-pressed", String(muted));
        };
        paint();
        mute.addEventListener("click", (event) => {
          event.stopPropagation();
          setMuted(message.id, !isMuted(message.id));
          paint();
        });
        head.append(mute);
      }
      wrap.append(head);
    }
    const card = document.createElement("div");
    card.className = "crumb-card";
    wrap.append(card);
    const entry = entryFor(message);
    entry.cards.add(card);
    paintLive(message.id, card);
    return wrap;
  }

  // Timers: redraw countdowns and tell the server when one finishes.
  setInterval(() => {
    for (const [id, entry] of live) {
      const alive = [...entry.cards].some((card) => card.isConnected);
      if (!alive) continue;
      const due = E.nextDue(entry.state);
      if (!due) continue;
      if (Object.values(entry.state?.timers || {}).some(Boolean)) redrawEntry(id);
      const now = Date.now() + entry.offset;
      // Fast timers (like gravity in a game) need quick ticks; if a tick
      // didn't change anything, back off so we don't spam the server.
      if (due <= now && !entry.tickBusy && Date.now() - entry.tickSent > (entry.tickGap || 150)) {
        entry.tickSent = Date.now();
        entry.tickBusy = true;
        const before = entry.state?.seq || 0;
        press(id, { type: "tick" }).finally(() => {
          entry.tickBusy = false;
          entry.tickGap = (entry.state?.seq || 0) !== before ? 150 : 1500;
        });
      }
    }
  }, 100);

  // ---------- builder ----------
  const dialog = $("crumb-dialog");
  const stage = $("cb-stage");
  const props = $("cb-props");
  const errorEl = $("cb-error");
  let def = null;
  let selected = null;
  let editingId = null; // message id when editing a sent crumb
  let assets = new Map(); // local key -> { file, url }
  let nextId = 1;
  let assetCallback = null;
  let testState = null;
  let testTimer = null;

  const localUrl = (key) => assets.get(key)?.url || "";
  const uid = (prefix) => `${prefix}${(nextId++).toString(36)}`;

  function freshDef() {
    return { title: "", aspect: "square", bg: "#fff7ec", elements: [], timers: [], rules: [] };
  }

  function openBuilder() {
    if (!activeId) return;
    if (editingId) resetBuilder(); // a half-done edit shouldn't leak into a new crumb
    if (!def) def = freshDef();
    paintMode();
    $("cb-title").value = def.title;
    $("cb-aspect").value = def.aspect;
    $("cb-bg").value = def.bg;
    showError(errorEl, "");
    setTab("build");
    dialog.showModal();
  }

  function resetBuilder() {
    for (const a of assets.values()) if (a.file && !a.remote) URL.revokeObjectURL(a.url);
    $("cb-import").hidden = true;
    assets = new Map();
    def = null;
    selected = null;
    editingId = null;
    paintMode();
  }

  function paintMode() {
    $("cb-send").textContent = editingId ? "Save changes" : "Send crumb";
  }

  // Open a crumb you already sent, change it, and save it in place.
  function openEdit(message) {
    if (!message?.fx?.crumb) return;
    resetBuilder();
    editingId = message.id;
    def = JSON.parse(JSON.stringify(message.fx.crumb));
    // Images/sounds already on the server are kept by their id.
    const existing = new Set();
    for (const el of def.elements) if (el.asset) existing.add(el.asset);
    for (const rule of def.rules) for (const a of rule.do) if (a.asset) existing.add(a.asset);
    for (const id of existing) assets.set(id, { file: null, url: `/api/attachments/${id}`, existing: true });
    // Keep new ids from clashing with the old ones.
    nextId = def.elements.length + def.timers.length + 50;
    $("cb-title").value = def.title || "";
    $("cb-aspect").value = def.aspect;
    $("cb-bg").value = def.bg || "#fff7ec";
    showError(errorEl, "");
    paintMode();
    setTab("build");
    dialog.showModal();
  }

  function setTab(tab) {
    for (const b of dialog.querySelectorAll(".cb-tab")) b.classList.toggle("active", b.dataset.tab === tab);
    for (const p of dialog.querySelectorAll(".cb-pane")) p.hidden = p.dataset.pane !== tab;
    stopTest();
    if (tab === "build") paintStage();
    if (tab === "rules") paintRules();
    if (tab === "test") startTest();
  }

  for (const b of dialog.querySelectorAll(".cb-tab")) b.addEventListener("click", () => setTab(b.dataset.tab));

  $("cb-close").addEventListener("click", () => {
    stopTest();
    dialog.close();
  });
  $("cb-title").addEventListener("input", (e) => (def.title = e.target.value));
  $("cb-aspect").addEventListener("change", (e) => {
    def.aspect = e.target.value;
    paintStage();
  });
  $("cb-bg").addEventListener("input", (e) => {
    def.bg = e.target.value;
    paintStage();
  });

  function pickImage(callback) {
    assetCallback = callback;
    const input = $("cb-image-input");
    input.accept = "image/*";
    input.click();
  }

  function pickSound(callback) {
    assetCallback = callback;
    const input = $("cb-image-input");
    input.accept = "audio/*";
    input.click();
  }

  $("cb-image-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !assetCallback) return;
    const key = uid("asset");
    assets.set(key, { file, url: URL.createObjectURL(file) });
    const cb = assetCallback;
    assetCallback = null;
    cb(key);
  });

  function addElement(type, asset = null) {
    const sizes = {
      button: [30, 14],
      text: [70, 12],
      image: [40, 30],
      counter: [34, 14],
      timer: [34, 14],
      box: [40, 30],
      grid: [80, 70],
    };
    const [w, h] = sizes[type];
    const count = def.elements.length;
    const el = {
      id: uid(type.slice(0, 3)),
      type,
      x: Math.round(50 - w / 2),
      y: Math.min(100 - h, 5 + ((count * 17) % 80)),
      w,
      h,
      hidden: false,
      text: type === "button" ? "Press me" : type === "text" ? "Some text" : type === "counter" ? "Score: " : "",
      color: type === "button" ? "#e0457b" : type === "box" ? "#4d9dff" : type === "grid" ? "#ffe2b8" : null,
      textColor: type === "button" ? "#ffffff" : "#1b1b1b",
      size: type === "text" ? 18 : type === "grid" ? 28 : 16,
      shape: type === "button" ? "pill" : "rounded",
    };
    if (type === "image") el.asset = asset;
    if (type === "counter") el.value = 0;
    if (type === "grid") {
      el.cols = 3;
      el.rows = 3;
      el.lines = "#3b2a1a";
      el.x = 10;
      el.y = 15;
    }
    if (type === "timer") {
      if (!def.timers.length) def.timers.push({ id: uid("t"), name: "Timer 1", secs: 10 });
      el.timer = def.timers[0].id;
    }
    def.elements.push(el);
    selected = el.id;
    paintStage();
  }

  dialog.querySelector(".cb-add").addEventListener("click", (event) => {
    const type = event.target.closest("[data-add]")?.dataset.add;
    if (!type) return;
    if (type === "image") pickImage((key) => addElement("image", key));
    else addElement(type);
  });

  // stageOnly: redraw the card but leave the settings panel alone (so a
  // color picker or slider that's open doesn't get closed).
  function paintStage(stageOnly = false) {
    if (!def) return;
    const state = E.initialState(sanitizedPreview() || { elements: [], timers: [], rules: [] });
    // Show everything while building (hidden ones are faded).
    for (const el of def.elements) state.vis[el.id] = !el.hidden;
    draw(stage, def, state, {
      assetUrl: localUrl,
      now: () => Date.now(),
      editing: true,
      selectedId: selected,
      onSelect: startDrag,
    });
    if (!stageOnly) paintProps();
  }

  // A crumb definition we can run locally (asset keys pass straight through).
  function sanitizedPreview() {
    return E.sanitize(def, (key) => (assets.has(key) ? key : null));
  }

  function startDrag(el, event, node) {
    event.preventDefault();
    event.stopPropagation();
    if (selected !== el.id) {
      selected = el.id;
      paintStage();
      return;
    }
    const resizing = Boolean(event.target.dataset.resize);
    const box = stage.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const orig = { x: el.x, y: el.y, w: el.w, h: el.h };
    node.setPointerCapture?.(event.pointerId);
    const move = (ev) => {
      const dx = ((ev.clientX - startX) / box.width) * 100;
      const dy = ((ev.clientY - startY) / box.height) * 100;
      if (resizing) {
        el.w = Math.round(Math.min(100 - el.x, Math.max(4, orig.w + dx)));
        el.h = Math.round(Math.min(100 - el.y, Math.max(4, orig.h + dy)));
      } else {
        el.x = Math.round(Math.min(100 - el.w, Math.max(0, orig.x + dx)));
        el.y = Math.round(Math.min(100 - el.h, Math.max(0, orig.y + dy)));
      }
      node.style.left = `${el.x}%`;
      node.style.top = `${el.y}%`;
      node.style.width = `${el.w}%`;
      node.style.height = `${el.h}%`;
    };
    const up = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  }

  stage.addEventListener("pointerdown", (event) => {
    if (event.target === stage) {
      selected = null;
      paintStage();
    }
  });

  function field(labelText, input) {
    const label = document.createElement("label");
    label.className = "cb-field";
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(span, input);
    return label;
  }

  function inputEl(type, value, onChange, attrs = {}) {
    const input = document.createElement("input");
    input.type = type;
    if (type === "checkbox") input.checked = Boolean(value);
    else input.value = value ?? "";
    Object.assign(input, attrs);
    input.addEventListener(type === "checkbox" || type === "color" ? "input" : "input", () =>
      onChange(type === "checkbox" ? input.checked : type === "number" ? Number(input.value) : input.value)
    );
    return input;
  }

  function selectEl(options, value, onChange) {
    const select = document.createElement("select");
    for (const [v, text] of options) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = text;
      select.append(opt);
    }
    select.value = value ?? options[0]?.[0] ?? "";
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  function paintProps() {
    props.replaceChildren();
    const el = def.elements.find((item) => item.id === selected);
    if (!el) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = def.elements.length
        ? "Tap something on the card to edit it. Drag to move, use the corner to resize."
        : "Add buttons, text, images, counters and timers, then set up what they do in Rules.";
      props.append(p);
      return;
    }
    const redrawSoon = () => paintStage();
    const redrawCard = () => paintStage(true);
    const head = document.createElement("div");
    head.className = "cb-props-head";
    head.textContent = `${LABELS[el.type]} · ${el.id}`;
    props.append(head);
    const grid = document.createElement("div");
    grid.className = "cb-props-grid";
    if (el.type === "grid") {
      const resize = () => {
        el.cols = Math.max(1, Math.min(12, Math.round(el.cols) || 3));
        el.rows = Math.max(1, Math.min(12, Math.round(el.rows) || 3));
        redrawSoon();
      };
      const cols = inputEl("number", el.cols, (v) => (el.cols = v), { min: 1, max: 12, className: "cb-num" });
      const rows = inputEl("number", el.rows, (v) => (el.rows = v), { min: 1, max: 12, className: "cb-num" });
      cols.addEventListener("change", resize);
      rows.addEventListener("change", resize);
      grid.append(field("Columns", cols), field("Rows", rows));
      grid.append(
        field("Line color", inputEl("color", el.lines || "#3b2a1a", (v) => {
          el.lines = v;
          redrawCard();
        }))
      );
    }
    if (el.type !== "image" && el.type !== "box" && el.type !== "grid") {
      const label = el.type === "counter" || el.type === "timer" ? "Label before the number" : "Text";
      const input = inputEl("text", el.text, (v) => {
        el.text = v;
        const node = stage.querySelector(`[data-el="${el.id}"]`);
        if (node && (el.type === "button" || el.type === "text")) node.firstChild && (node.firstChild.nodeValue = v);
      }, { maxLength: 200 });
      input.addEventListener("change", redrawSoon);
      grid.append(field(label, input));
    }
    if (el.type === "timer") {
      grid.append(
        field(
          "Shows timer",
          selectEl(def.timers.map((t) => [t.id, `${t.name} (${t.secs}s)`]), el.timer, (v) => {
            el.timer = v;
            redrawSoon();
          })
        )
      );
    }
    if (el.type === "counter") {
      grid.append(field("Starts at", inputEl("number", el.value, (v) => (el.value = v))));
    }
    if (el.type !== "image") {
      grid.append(
        field(el.type === "grid" ? "Cell color" : "Color", inputEl("color", el.color || "#ffffff", (v) => {
          el.color = v;
          redrawCard();
        }))
      );
      grid.append(
        field("Text color", inputEl("color", el.textColor || "#1b1b1b", (v) => {
          el.textColor = v;
          redrawCard();
        }))
      );
      const size = inputEl("range", el.size, (v) => {
        el.size = v;
        redrawCard();
      }, { min: 8, max: 72 });
      grid.append(field("Text size", size));
      if (el.type !== "grid") grid.append(
        field(
          "Shape",
          selectEl(
            [
              ["rounded", "Rounded"],
              ["pill", "Pill"],
              ["circle", "Circle"],
              ["square", "Square"],
            ],
            el.shape,
            (v) => {
              el.shape = v;
              redrawSoon();
            }
          )
        )
      );
    } else {
      const change = document.createElement("button");
      change.type = "button";
      change.className = "btn ghost small";
      change.textContent = "Change image";
      change.addEventListener("click", () =>
        pickImage((key) => {
          el.asset = key;
          redrawSoon();
        })
      );
      grid.append(change);
    }
    const group = inputEl("text", el.group || "", (v) => {
      el.group = v.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 24).trim() || undefined;
    }, { maxLength: 24, placeholder: "e.g. coins" });
    group.title = "Things in the same group can share one rule (like “when any coin is pressed”).";
    grid.append(field("Group (optional)", group));
    grid.append(
      field("Starts hidden", inputEl("checkbox", el.hidden, (v) => {
        el.hidden = v;
        redrawSoon();
      }))
    );
    props.append(grid);
    const row = document.createElement("div");
    row.className = "cb-props-actions";
    const dup = document.createElement("button");
    dup.type = "button";
    dup.className = "btn ghost small";
    dup.textContent = "Duplicate";
    dup.addEventListener("click", () => {
      const copy = { ...JSON.parse(JSON.stringify(el)), id: uid(el.type.slice(0, 3)) };
      copy.x = Math.min(100 - copy.w, copy.x + 4);
      copy.y = Math.min(100 - copy.h, copy.y + 4);
      def.elements.push(copy);
      selected = copy.id;
      paintStage();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn ghost small danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      def.elements = def.elements.filter((item) => item.id !== el.id);
      selected = null;
      paintStage();
    });
    row.append(dup, del);
    props.append(row);
  }

  // ---------- rules ----------
  const elName = (id) => {
    if (id === "@pressed") return "the pressed one";
    if (id === "*") return "anything";
    if (typeof id === "string" && id.startsWith("group:")) return `everything in “${id.slice(6)}”`;
    const el = def.elements.find((item) => item.id === id);
    if (!el) return id;
    const text = (el.text || "").trim();
    return `${LABELS[el.type]}${text ? ` “${text.slice(0, 14)}”` : ` ${el.id}`}`;
  };

  function paintRules() {
    // timers
    const tl = $("cb-timer-list");
    tl.replaceChildren();
    for (const t of def.timers) {
      const row = document.createElement("div");
      row.className = "cb-timer";
      row.append(
        inputEl("text", t.name, (v) => (t.name = v), { maxLength: 30, placeholder: "Name" }),
        inputEl("number", t.secs, (v) => (t.secs = Math.max(0.1, v || 1)), { min: 0.1, max: 3600, step: 0.1 })
      );
      const secs = document.createElement("span");
      secs.textContent = "seconds";
      const repeat = field("repeat", inputEl("checkbox", t.repeat, (v) => (t.repeat = v || undefined)));
      repeat.title = "Starts itself again every time it finishes";
      const x = document.createElement("button");
      x.type = "button";
      x.className = "bar-x";
      x.textContent = "×";
      x.addEventListener("click", () => {
        def.timers = def.timers.filter((item) => item !== t);
        paintRules();
      });
      row.append(secs, repeat, x);
      tl.append(row);
    }
    // rules
    const list = $("cb-rule-list");
    list.replaceChildren();
    if (!def.rules.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "No rules yet. Example: When “Press me” is pressed → add 1 to Score.";
      list.append(p);
    }
    def.rules.forEach((rule, index) => list.append(ruleCard(rule, index)));
  }

  const groupNames = () => [...new Set(def.elements.map((el) => el.group).filter(Boolean))];
  const groupOpts = () => groupNames().map((g) => [`group:${g}`, `anything in group “${g}”`]);

  function triggerOptions() {
    const opts = def.elements.map((el) => [
      `press:${el.id}`,
      el.type === "grid" ? `a cell of ${elName(el.id)} is pressed` : `${elName(el.id)} is pressed`,
    ]);
    for (const g of groupNames()) opts.push([`press:group:${g}`, `anything in group “${g}” is pressed`]);
    opts.push(["touch", "two things touch"]);
    for (const t of def.timers) opts.push([`timer:${t.id}`, `timer “${t.name}” finishes`]);
    for (const el of def.elements.filter((item) => item.type === "counter")) {
      opts.push([`count:${el.id}`, `${elName(el.id)} reaches a number`]);
    }
    opts.push(["start", "the crumb is sent"]);
    opts.push(["after", "anything is pressed (checked after)"]);
    return opts;
  }

  function ruleCard(rule, index) {
    const card = document.createElement("div");
    card.className = "cb-rule";
    const whenRow = document.createElement("div");
    whenRow.className = "cb-rule-row";
    const whenLabel = document.createElement("b");
    whenLabel.textContent = "When";
    const key =
      rule.when.on === "touch"
        ? "touch"
        : rule.when.on === "press"
        ? `press:${rule.when.el}`
        : rule.when.on === "timer"
          ? `timer:${rule.when.timer}`
          : rule.when.on === "count"
            ? `count:${rule.when.el}`
            : rule.when.on === "after"
              ? "after"
              : "start";
    const trig = selectEl(triggerOptions(), key, (v) => {
      const cut = v.indexOf(":");
      const on = cut < 0 ? v : v.slice(0, cut);
      const id = cut < 0 ? "" : v.slice(cut + 1);
      if (on === "touch") {
        rule.when = { on, el: def.elements[0]?.id, other: def.elements[1]?.id || def.elements[0]?.id };
        paintRules();
        return;
      }
      if (on === "press") rule.when = { on, el: id };
      else if (on === "timer") rule.when = { on, timer: id };
      else if (on === "count") rule.when = { on, el: id, cmp: ">=", n: 10 };
      else if (on === "after") rule.when = { on: "after" };
      else rule.when = { on: "start" };
      paintRules();
    });
    whenRow.append(whenLabel, trig);
    if (rule.when.on === "touch") {
      const things = () => [...def.elements.map((e) => [e.id, elName(e.id)]), ...groupOpts()];
      const and = document.createElement("span");
      and.textContent = "and";
      whenRow.append(
        selectEl(things(), rule.when.el, (v) => (rule.when.el = v)),
        and,
        selectEl(things(), rule.when.other, (v) => (rule.when.other = v))
      );
    }
    if (rule.when.on === "count") {
      whenRow.append(
        selectEl(
          [
            [">=", "at least"],
            ["<=", "at most"],
            ["==", "exactly"],
          ],
          rule.when.cmp,
          (v) => (rule.when.cmp = v)
        ),
        inputEl("number", rule.when.n, (v) => (rule.when.n = v), { className: "cb-num" })
      );
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "bar-x";
    del.textContent = "×";
    del.title = "Delete rule";
    del.addEventListener("click", () => {
      def.rules.splice(index, 1);
      paintRules();
    });
    const dup = document.createElement("button");
    dup.type = "button";
    dup.className = "cb-dup";
    dup.textContent = "⧉ Duplicate";
    dup.title = "Make a copy of this rule right below it";
    dup.addEventListener("click", () => {
      def.rules.splice(index + 1, 0, JSON.parse(JSON.stringify(rule)));
      paintRules();
      const copy = $("cb-rule-list").children[index + 1];
      copy?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      copy?.classList.add("cb-flash");
    });
    whenRow.append(dup, del);
    card.append(whenRow);
    (rule.if || []).forEach((cond, i) => card.append(condRow(rule, cond, i)));
    const addIf = document.createElement("button");
    addIf.type = "button";
    addIf.className = "btn ghost small cb-if-add";
    addIf.textContent = "+ only if…";
    addIf.addEventListener("click", () => {
      rule.if = rule.if || [];
      rule.if.push({ k: "text", el: def.elements[0]?.id, op: "==", v: "" });
      paintRules();
    });
    card.append(addIf);
    rule.do.forEach((action, i) => card.append(actionRow(rule, action, i)));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn ghost small";
    add.textContent = "+ then do…";
    add.addEventListener("click", () => {
      const first = def.elements[0]?.id;
      rule.do.push({ a: "show", el: first });
      paintRules();
    });
    card.append(add);
    return card;
  }

  const withPressed = () => [["@pressed", "the pressed one"], ...def.elements.map((e) => [e.id, elName(e.id)]), ...groupOpts()];
  const gridOpts = () => def.elements.filter((e) => e.type === "grid").map((e) => [e.id, elName(e.id)]);
  const counterOpts = () => def.elements.filter((e) => e.type === "counter").map((e) => [e.id, elName(e.id)]);

  const COND_KINDS = [
    ["text:==", "text is"],
    ["text:!=", "text isn't"],
    ["num:>=", "counter ≥"],
    ["num:<=", "counter ≤"],
    ["num:==", "counter ="],
    ["num:!=", "counter ≠"],
    ["shown:==", "is shown"],
    ["shown:!=", "is hidden"],
    ["enabled:==", "is turned on"],
    ["enabled:!=", "is turned off"],
    ["touch:==", "is touching"],
    ["touch:!=", "isn't touching"],
    ["cell:==", "grid: pressed cell is"],
    ["cell:!=", "grid: pressed cell isn't"],
    ["room:==", "grid: pressed column has room"],
    ["line:==", "grid: has a line of"],
    ["line:!=", "grid: has no line of"],
    ["full:==", "grid: is full"],
    ["full:!=", "grid: isn't full"],
    ["all:==", "group: all shown"],
    ["any:==", "group: any shown"],
    ["none:==", "group: none shown"],
    ["math:==", "math is true"],
  ];

  function condRow(rule, cond, index) {
    const row = document.createElement("div");
    row.className = "cb-rule-row cb-cond";
    const label = document.createElement("span");
    label.textContent = index === 0 ? "only if" : "and";
    const k = cond.k;
    const isGrid = ["cell", "room", "line", "full"].includes(k);
    const isGroup = ["all", "any", "none"].includes(k);
    row.append(label);
    if (k !== "math") {
      const opts = isGrid ? gridOpts() : isGroup ? groupOpts() : withPressed();
      if (opts.length && !opts.some(([v]) => v === cond.el)) cond.el = opts[0][0];
      row.append(selectEl(opts.length ? opts : [["", isGroup ? "(no groups yet)" : "(add a grid)"]], cond.el, (v) => (cond.el = v)));
    }
    row.append(
      selectEl(COND_KINDS, `${k}:${cond.op || "=="}`, (v) => {
        const [nk, op] = v.split(":");
        const fresh = { k: nk, op, el: cond.el };
        if (nk === "num") fresh.v = 0;
        if (nk === "text" || nk === "cell") fresh.v = "";
        if (nk === "line") {
          fresh.v = "";
          fresh.n = 3;
        }
        if (nk === "touch") fresh.other = def.elements.find((e) => e.id !== cond.el)?.id || cond.el;
        if (nk === "math") fresh.expr = "";
        Object.keys(cond).forEach((key) => delete cond[key]);
        Object.assign(cond, fresh);
        paintRules();
      })
    );
    if (k === "text") {
      row.append(inputEl("text", cond.v, (v) => (cond.v = v), { maxLength: 200, placeholder: "(empty)" }));
    } else if (k === "num") {
      row.append(inputEl("number", cond.v, (v) => (cond.v = v), { className: "cb-num" }));
    } else if (k === "cell") {
      row.append(inputEl("text", cond.v, (v) => (cond.v = v), { maxLength: 20, placeholder: "(empty)", className: "cb-short" }));
    } else if (k === "line") {
      row.append(
        inputEl("number", cond.n, (v) => (cond.n = v), { className: "cb-num", min: 2, max: 12, title: "how many in a row" }),
        inputEl("text", cond.v, (v) => (cond.v = v), { maxLength: 20, placeholder: "anything", className: "cb-short", title: "which piece (leave empty = anyone's)" })
      );
    } else if (k === "touch") {
      row.append(selectEl([...def.elements.map((e) => [e.id, elName(e.id)]), ...groupOpts()], cond.other, (v) => (cond.other = v)));
    } else if (k === "math") {
      row.append(inputEl("text", cond.expr, (v) => (cond.expr = v), { maxLength: 200, placeholder: "score >= 10 && lives > 0" }));
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "bar-x";
    x.textContent = "×";
    x.addEventListener("click", () => {
      rule.if.splice(index, 1);
      paintRules();
    });
    row.append(x);
    return row;
  }

  // A little copy of the card where you drag a ghost to where the thing
  // should move to (no numbers to type).
  function movePicker(rule, action) {
    const box = document.createElement("div");
    box.className = "cb-move";
    const hint = document.createElement("div");
    hint.className = "cb-move-hint";
    hint.textContent = "to here — drag it where it should go:";
    const mini = document.createElement("div");
    mini.className = "crumb-card cb-move-card";
    const preview = sanitizedPreview() || { elements: [], timers: [], rules: [], aspect: def.aspect, bg: def.bg };
    const state = E.initialState(preview);
    for (const el of def.elements) state.vis[el.id] = !el.hidden;
    state.pos = {};
    draw(mini, def, state, { assetUrl: localUrl, now: () => Date.now(), editing: true });
    const targetId = action.el === "@pressed" ? (rule.when?.on === "press" ? rule.when.el : null) : action.el;
    const target = def.elements.find((e) => e.id === targetId);
    const w = target ? target.w : 20;
    const h = target ? target.h : 12;
    const from = mini.querySelector(`[data-el="${targetId}"]`);
    // The ghost looks like the real thing, so you can see where it'll end up.
    let ghost;
    if (from) {
      ghost = from.cloneNode(true);
      ghost.removeAttribute("data-el");
      ghost.classList.remove("crumb-hidden", "selected");
      ghost.classList.add("cb-move-ghost");
      from.classList.add("cb-move-from");
    } else {
      ghost = document.createElement("div");
      ghost.className = "cb-move-ghost cb-move-ghost-blank";
      ghost.textContent = "pressed one";
    }
    ghost.style.width = `${w}%`;
    ghost.style.height = `${h}%`;
    const place = () => {
      ghost.style.left = `${action.x}%`;
      ghost.style.top = `${action.y}%`;
    };
    place();
    mini.append(ghost);
    const setFrom = (event) => {
      const r = mini.getBoundingClientRect();
      const cx = ((event.clientX - r.left) / r.width) * 100;
      const cy = ((event.clientY - r.top) / r.height) * 100;
      action.x = Math.round(Math.min(100 - w, Math.max(0, cx - w / 2)));
      action.y = Math.round(Math.min(100 - h, Math.max(0, cy - h / 2)));
      place();
    };
    mini.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setFrom(event);
      mini.setPointerCapture?.(event.pointerId);
      const move = (ev) => setFrom(ev);
      const up = () => {
        mini.removeEventListener("pointermove", move);
        mini.removeEventListener("pointerup", up);
        mini.removeEventListener("pointercancel", up);
      };
      mini.addEventListener("pointermove", move);
      mini.addEventListener("pointerup", up);
      mini.addEventListener("pointercancel", up);
    });
    box.append(hint, mini);
    return box;
  }

  const ACTIONS = [
    ["show", "show"],
    ["hide", "hide"],
    ["toggle", "show/hide"],
    ["text", "change text of"],
    ["color", "change color of"],
    ["image", "change image of"],
    ["add", "add to counter"],
    ["set", "set counter"],
    ["addc", "add counter onto counter"],
    ["move", "move"],
    ["moveby", "nudge (move by)"],
    ["cell", "grid: set a cell"],
    ["drop", "grid: drop into pressed column"],
    ["clear", "grid: clear"],
    ["cycle", "cycle text through"],
    ["calc", "set counter to math"],
    ["disable", "turn off (can't press)"],
    ["enable", "turn back on"],
    ["start", "start timer"],
    ["stop", "stop timer"],
    ["screen", "screen effect"],
    ["sound", "play sound"],
    ["wait", "wait until pressed"],
    ["delay", "wait seconds"],
    ["copy", "copy text"],
    ["loop", "start these steps over"],
    ["halt", "stop all waiting (end)"],
    ["reset", "reset everything"],
  ];

  function actionRow(rule, action, index) {
    const row = document.createElement("div");
    row.className = "cb-rule-row cb-action";
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    const kind = selectEl(ACTIONS, action.a, (v) => {
      const first = def.elements[0]?.id;
      const counter = def.elements.find((e) => e.type === "counter")?.id || first;
      const image = def.elements.find((e) => e.type === "image")?.id || first;
      const timer = def.timers[0]?.id;
      const fresh = { a: v };
      if (["show", "hide", "toggle", "text", "color", "move"].includes(v)) fresh.el = action.el || first;
      if (v === "text") fresh.text = "New text";
      if (v === "color") fresh.color = "#ffd166";
      if (v === "image") fresh.el = image;
      if (v === "add" || v === "set") {
        fresh.el = counter;
        fresh.n = v === "add" ? 1 : 0;
      }
      if (v === "addc") {
        const counters = def.elements.filter((e) => e.type === "counter");
        fresh.from = counters[0]?.id || first;
        fresh.el = counters[1]?.id || counters[0]?.id || first;
      }
      const grid0 = def.elements.find((e) => e.type === "grid")?.id;
      if (["moveby", "disable", "enable", "cycle"].includes(v)) fresh.el = action.el || first;
      if (v === "moveby") {
        fresh.dx = 10;
        fresh.dy = 0;
      }
      if (v === "cycle") fresh.opts = ["X", "O"];
      if (v === "calc") {
        fresh.el = counter;
        fresh.expr = "";
      }
      if (v === "cell" || v === "drop" || v === "clear") fresh.el = grid0;
      if (v === "cell") fresh.at = "pressed";
      if (v === "cell" || v === "drop") fresh.text = "X";
      if (v === "move") {
        fresh.x = 50;
        fresh.y = 50;
      }
      if (v === "start" || v === "stop") fresh.timer = timer;
      if (v === "screen") {
        fresh.kind = "shake";
        fresh.secs = 2;
      }
      if (v === "wait") {
        fresh.el = "*";
        fresh.blank = false;
      }
      if (v === "delay") fresh.secs = 1;
      if (v === "copy") {
        fresh.from = first;
        fresh.el = "@pressed";
      }
      rule.do[index] = fresh;
      paintRules();
    });
    row.append(arrow, kind);
    const elOptions = def.elements.map((e) => [e.id, elName(e.id)]);
    if (["show", "hide", "toggle", "text", "color", "move", "image", "moveby", "disable", "enable", "cycle"].includes(action.a)) {
      const opts =
        action.a === "image"
          ? [["@pressed", "the pressed one"], ...elOptions.filter(([id]) => def.elements.find((e) => e.id === id)?.type === "image")]
          : withPressed();
      row.append(
        selectEl(opts, action.el, (v) => {
          action.el = v;
          if (action.a === "move") paintRules(); // resize the preview ghost
        })
      );
    }
    if (action.a === "wait") {
      row.append(
        selectEl([["*", "anything"], ...elOptions, ...groupOpts()], action.el, (v) => (action.el = v)),
        field("only empty ones", inputEl("checkbox", action.blank, (v) => (action.blank = v)))
      );
    }
    if (action.a === "delay") {
      row.append(inputEl("number", action.secs, (v) => (action.secs = v), { className: "cb-num", min: 0.2, step: 0.5, title: "seconds" }));
    }
    if (action.a === "copy") {
      const from = document.createElement("span");
      from.textContent = "from";
      const to = document.createElement("span");
      to.textContent = "to";
      row.append(
        from,
        selectEl(withPressed(), action.from, (v) => (action.from = v)),
        to,
        selectEl(withPressed(), action.el, (v) => (action.el = v))
      );
    }
    if (action.a === "addc") {
      const counters = elOptions.filter(([id]) => def.elements.find((e) => e.id === id)?.type === "counter");
      const onto = document.createElement("span");
      onto.textContent = "onto";
      row.append(
        selectEl(counters, action.from, (v) => (action.from = v)),
        onto,
        selectEl(counters, action.el, (v) => (action.el = v))
      );
    }
    if (action.a === "add" || action.a === "set") {
      row.append(
        selectEl(elOptions.filter(([id]) => def.elements.find((e) => e.id === id)?.type === "counter"), action.el, (v) => (action.el = v)),
        inputEl("number", action.n, (v) => (action.n = v), { className: "cb-num" })
      );
    }
    if (action.a === "text") {
      const t = inputEl("text", action.text, (v) => (action.text = v), { maxLength: 200 });
      t.title = "Tip: {score} shows a counter, {line} shows who got the line";
      row.append(t);
    }
    if (action.a === "moveby") {
      const right = document.createElement("span");
      right.textContent = "right";
      const down = document.createElement("span");
      down.textContent = "down";
      row.append(
        right,
        inputEl("number", action.dx, (v) => (action.dx = v), { className: "cb-num", title: "% of the card (negative = left)" }),
        down,
        inputEl("number", action.dy, (v) => (action.dy = v), { className: "cb-num", title: "% of the card (negative = up)" })
      );
    }
    if (action.a === "cycle") {
      row.append(
        inputEl("text", (action.opts || []).join(", "), (v) => (action.opts = v.split(",").map((o) => o.trim()).filter(Boolean)), {
          maxLength: 200,
          placeholder: "X, O",
          title: "Each time, the text moves to the next one in this list",
        })
      );
    }
    if (action.a === "calc") {
      const to = document.createElement("span");
      to.textContent = "to";
      row.append(
        selectEl(counterOpts(), action.el, (v) => (action.el = v)),
        to,
        inputEl("text", action.expr, (v) => (action.expr = v), { maxLength: 200, placeholder: "score + hits * 10" })
      );
    }
    if (["cell", "drop", "clear"].includes(action.a)) {
      const grids = gridOpts();
      row.append(selectEl(grids.length ? grids : [["", "(add a grid first)"]], action.el, (v) => (action.el = v)));
    }
    if (action.a === "cell") {
      row.append(
        selectEl(
          [
            ["pressed", "the pressed cell"],
            ["rc", "row / column"],
          ],
          action.at,
          (v) => {
            action.at = v;
            if (v === "rc") {
              action.r = action.r || 1;
              action.c = action.c || 1;
            }
            paintRules();
          }
        )
      );
      if (action.at === "rc") {
        row.append(
          inputEl("number", action.r, (v) => (action.r = v), { className: "cb-num", min: 1, max: 12, title: "row" }),
          inputEl("number", action.c, (v) => (action.c = v), { className: "cb-num", min: 1, max: 12, title: "column" })
        );
      }
    }
    if (action.a === "cell" || action.a === "drop") {
      const to = document.createElement("span");
      to.textContent = "to";
      const sourceOpts = [["", "this:"], ...def.elements.filter((e) => e.type !== "grid").map((e) => [e.id, `text of ${elName(e.id)}`])];
      row.append(
        to,
        selectEl(sourceOpts, action.from || "", (v) => {
          if (v) {
            action.from = v;
            delete action.text;
          } else {
            delete action.from;
            action.text = "X";
          }
          paintRules();
        })
      );
      if (!action.from) row.append(inputEl("text", action.text, (v) => (action.text = v), { maxLength: 20, className: "cb-short", placeholder: "X" }));
    }
    if (action.a === "color") row.append(inputEl("color", action.color, (v) => (action.color = v)));
    if (action.a === "move") row.append(movePicker(rule, action));
    if (action.a === "image" || action.a === "sound") {
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "btn ghost small";
      pick.textContent = action.asset ? (action.a === "sound" ? "Sound ✓" : "Image ✓") : action.a === "sound" ? "Choose sound" : "Choose image";
      pick.addEventListener("click", () =>
        (action.a === "sound" ? pickSound : pickImage)((key) => {
          action.asset = key;
          paintRules();
        })
      );
      row.append(pick);
    }
    if (action.a === "start" || action.a === "stop") {
      row.append(selectEl(def.timers.map((t) => [t.id, t.name]), action.timer, (v) => (action.timer = v)));
    }
    if (action.a === "screen") {
      row.append(
        selectEl(Object.entries(Fx.SCREEN_LABELS), action.kind, (v) => (action.kind = v)),
        inputEl("number", action.secs, (v) => (action.secs = v), { className: "cb-num", min: 0.5, max: 30, step: 0.5, title: "seconds" })
      );
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "bar-x";
    x.textContent = "×";
    x.addEventListener("click", () => {
      rule.do.splice(index, 1);
      paintRules();
    });
    const copyStep = document.createElement("button");
    copyStep.type = "button";
    copyStep.className = "cb-dup small";
    copyStep.textContent = "⧉";
    copyStep.title = "Duplicate this step";
    copyStep.addEventListener("click", () => {
      rule.do.splice(index + 1, 0, JSON.parse(JSON.stringify(action)));
      paintRules();
    });
    row.append(copyStep, x);
    return row;
  }

  $("cb-add-timer").addEventListener("click", () => {
    def.timers.push({ id: uid("t"), name: `Timer ${def.timers.length + 1}`, secs: 10 });
    paintRules();
  });

  $("cb-add-rule").addEventListener("click", () => {
    const button = def.elements.find((e) => e.type === "button") || def.elements[0];
    def.rules.push({
      when: button ? { on: "press", el: button.id } : { on: "start" },
      do: [],
    });
    paintRules();
  });

  // ---------- test mode ----------
  function startTest() {
    const clean = sanitizedPreview();
    const card = $("cb-test");
    if (!clean) {
      card.replaceChildren();
      card.textContent = "Add something first.";
      return;
    }
    testState = E.initialState(clean);
    const paint = () =>
      draw(card, clean, testState, {
        assetUrl: localUrl,
        now: () => Date.now(),
        onPress: (el, node, cell) => {
          const result = E.apply(clean, testState, cell === undefined ? { type: "press", el } : { type: "press", el, cell });
          testState = result.state;
          playFired(result.fired, localUrl);
          paint();
        },
      });
    paint();
    testTimer = setInterval(() => {
      const result = E.apply(clean, testState, { type: "tick" });
      if (result.changed) {
        testState = result.state;
        playFired(result.fired, localUrl);
      }
      if (E.nextDue(testState) || result.changed) paint();
    }, 60);
  }

  function stopTest() {
    clearInterval(testTimer);
    testTimer = null;
  }

  $("cb-test-reset").addEventListener("click", () => {
    stopTest();
    startTest();
  });

  // ---------- crumb codes (copy / import) ----------
  // A crumb code is the whole crumb (layout, rules, and its images/sounds)
  // squished into one line of text you can paste anywhere.
  const CODE_PREFIX = "CRUMB1.";
  const MAX_CODE_ASSETS = 4 * 1024 * 1024;

  const toB64 = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const urlSafe = (b64) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromUrlSafe = (text) => {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  };

  async function squish(bytes, mode) {
    const stream = new Blob([bytes]).stream().pipeThrough(new (mode === "in" ? CompressionStream : DecompressionStream)("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function assetKeysOf(crumb) {
    const keys = new Set();
    for (const el of crumb.elements || []) if (el.asset != null) keys.add(el.asset);
    for (const rule of crumb.rules || []) for (const a of rule.do || []) if (a.asset != null) keys.add(a.asset);
    return keys;
  }

  // crumb: a definition; urlFor(key) gives a URL to fetch each image/sound.
  async function makeCode(crumb, urlFor) {
    const packed = { v: 1, crumb, assets: {} };
    let total = 0;
    let skipped = 0;
    for (const key of assetKeysOf(crumb)) {
      try {
        const blob = await (await fetch(urlFor(key))).blob();
        if (total + blob.size > MAX_CODE_ASSETS) {
          skipped += 1;
          continue;
        }
        total += blob.size;
        packed.assets[key] = { t: blob.type || "", d: toB64(new Uint8Array(await blob.arrayBuffer())) };
      } catch {
        skipped += 1;
      }
    }
    let bytes = new TextEncoder().encode(JSON.stringify(packed));
    let mark = "z";
    if (typeof CompressionStream === "function") bytes = await squish(bytes, "in");
    else mark = "j";
    return { code: `${CODE_PREFIX}${mark}${urlSafe(toB64(bytes))}`, skipped };
  }

  async function readCode(text) {
    const clean = String(text || "").replace(/\s+/g, "");
    const at = clean.indexOf(CODE_PREFIX);
    if (at < 0) throw new Error("That doesn't look like a crumb code.");
    const body = clean.slice(at + CODE_PREFIX.length);
    let bytes = fromB64(fromUrlSafe(body.slice(1)));
    if (body[0] === "z") {
      if (typeof DecompressionStream !== "function") throw new Error("This browser is too old to open crumb codes.");
      bytes = await squish(bytes, "out");
    }
    const packed = JSON.parse(new TextDecoder().decode(bytes));
    if (!packed?.crumb) throw new Error("That crumb code is broken.");
    return packed;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Older/locked-down browsers: fall back to a hidden text box.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      (dialog.open ? dialog : document.body).append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      area.remove();
      return ok;
    }
  }

  // From the message menu: copy the code of a crumb someone sent.
  async function copyCodeOf(message) {
    if (!message?.fx?.crumb) return;
    try {
      const { code, skipped } = await makeCode(message.fx.crumb, (id) => `/api/attachments/${id}`);
      const ok = await copyText(code);
      showError(
        composeError,
        ok
          ? `Crumb code copied!${skipped ? ` (${skipped} picture/sound was too big to include.)` : ""}`
          : "Couldn't copy. Your browser blocked the clipboard."
      );
    } catch (err) {
      showError(composeError, err.message);
    }
  }

  // Open a sent crumb in the builder as a brand-new copy you can change.
  function remix(message) {
    if (!message?.fx?.crumb) return;
    resetBuilder();
    def = JSON.parse(JSON.stringify(message.fx.crumb));
    const keys = assetKeysOf(def);
    // Their images/sounds get downloaded and re-uploaded with your version.
    for (const key of keys) assets.set(key, { file: null, url: `/api/attachments/${key}`, remote: true });
    nextId = def.elements.length + def.timers.length + 50;
    openLoaded();
  }

  function openLoaded() {
    $("cb-title").value = def.title || "";
    $("cb-aspect").value = def.aspect || "square";
    $("cb-bg").value = def.bg || "#fff7ec";
    showError(errorEl, "");
    paintMode();
    setTab("build");
    if (!dialog.open) dialog.showModal();
  }

  async function loadCode(text) {
    const packed = await readCode(text);
    const raw = packed.crumb;
    // Give every image/sound a fresh local key.
    const map = new Map();
    const files = new Map();
    for (const [key, data] of Object.entries(packed.assets || {})) {
      const local = uid("asset");
      const file = new File([fromB64(data.d)], data.t?.startsWith("audio/") ? "sound" : "image", { type: data.t || "" });
      map.set(String(key), local);
      files.set(local, file);
    }
    const fix = (value) => (value != null && map.has(String(value)) ? map.get(String(value)) : null);
    const copy = JSON.parse(JSON.stringify(raw));
    for (const el of copy.elements || []) if (el.asset != null) el.asset = fix(el.asset);
    for (const rule of copy.rules || []) for (const a of rule.do || []) if (a.asset != null) a.asset = fix(a.asset);
    const clean = E.sanitize(copy, (key) => (files.has(key) ? key : null));
    if (!clean) throw new Error("That crumb code is empty.");
    resetBuilder();
    for (const [key, file] of files) assets.set(key, { file, url: URL.createObjectURL(file) });
    def = clean;
    nextId = def.elements.length + def.timers.length + 50;
    openLoaded();
  }

  $("cb-import-open").addEventListener("click", () => {
    $("cb-import").hidden = false;
    $("cb-import-text").value = "";
    $("cb-import-text").focus();
  });
  $("cb-import-cancel").addEventListener("click", () => ($("cb-import").hidden = true));
  $("cb-import-load").addEventListener("click", async () => {
    showError(errorEl, "");
    const text = $("cb-import-text").value;
    if (def?.elements?.length && !confirm("Replace what you're building with this crumb?")) return;
    try {
      await loadCode(text);
      $("cb-import").hidden = true;
    } catch (err) {
      showError(errorEl, err.message || "That crumb code didn't work.");
    }
  });

  $("cb-copy-code").addEventListener("click", async () => {
    showError(errorEl, "");
    const clean = sanitizedPreview();
    if (!clean) {
      showError(errorEl, "Add something to your crumb first.");
      return;
    }
    const button = $("cb-copy-code");
    button.disabled = true;
    try {
      const { code, skipped } = await makeCode(clean, localUrl);
      const ok = await copyText(code);
      button.textContent = ok ? "✅ Copied" : "Couldn't copy";
      if (skipped) showError(errorEl, `${skipped} picture/sound was too big to go in the code.`);
      setTimeout(() => (button.textContent = "📋 Copy code"), 1500);
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      button.disabled = false;
    }
  });

  // ---------- send ----------
  $("cb-send").addEventListener("click", async () => {
    showError(errorEl, "");
    const clean = sanitizedPreview();
    if (!clean) {
      showError(errorEl, "Add at least one thing to your crumb.");
      return;
    }
    // Remixed images/sounds from someone else's crumb: download them so they
    // get uploaded with your copy.
    try {
      for (const [key, a] of assets) {
        if (!a.remote || a.file) continue;
        const blob = await (await fetch(a.url)).blob();
        a.file = new File([blob], "asset", { type: blob.type });
      }
    } catch {
      showError(errorEl, "Couldn't download one of the pictures/sounds.");
      return;
    }
    // Local asset keys → upload order (images already sent keep their id).
    const files = [];
    const index = new Map();
    const toIndex = (key) => {
      if (assets.get(key)?.existing) return key;
      if (!index.has(key)) {
        index.set(key, files.length);
        files.push(assets.get(key).file);
      }
      return index.get(key);
    };
    const payload = JSON.parse(JSON.stringify(clean));
    for (const el of payload.elements) if (el.asset) el.asset = toIndex(el.asset);
    for (const rule of payload.rules) for (const a of rule.do) if (a.asset) a.asset = toIndex(a.asset);
    const button = $("cb-send");
    button.disabled = true;
    button.textContent = editingId ? "Saving…" : "Sending…";
    const body = clean.title ? `🍪 ${clean.title}` : "🍪 Crumb";
    try {
      if (editingId) {
        const form = new FormData();
        form.append("body", body);
        form.append("fx", JSON.stringify({ crumb: payload }));
        for (const file of files) form.append("fxfiles", file);
        const updated = await api(`/api/messages/${editingId}`, { method: "PATCH", body: form });
        upsertMessage(updated, true);
      } else {
        await Fx.sendFx({ crumb: payload }, files, body);
      }
      stopTest();
      dialog.close();
      resetBuilder();
    } catch (err) {
      showError(errorEl, err.message);
    } finally {
      button.disabled = false;
      paintMode();
    }
  });

  dialog.addEventListener("close", stopTest);

  return { openBuilder, openEdit, renderCard, onRemoteState, copyCodeOf, remix };
})();
