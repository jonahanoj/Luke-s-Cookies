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
  };

  // ---------- drawing a crumb ----------
  function fmtTimer(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // opts: { assetUrl(id), onPress(el), now(), editing, selectedId, onSelect(el, event) }
  function draw(card, def, state, opts) {
    card.replaceChildren();
    card.style.aspectRatio = String(E.ASPECTS[def.aspect] || 1);
    card.style.background = def.bg || "#fff7ec";
    card.classList.add("crumb-card");
    for (const el of def.elements) {
      const visible = state.vis[el.id] !== false;
      if (!visible && !opts.editing) continue;
      const pos = state.pos?.[el.id];
      const node = document.createElement(el.type === "button" ? "button" : "div");
      if (el.type === "button") node.type = "button";
      node.className = `crumb-el crumb-${el.type} shape-${el.shape}`;
      if (!visible) node.classList.add("crumb-hidden");
      if (opts.selectedId === el.id) node.classList.add("selected");
      node.dataset.el = el.id;
      node.style.left = `${pos ? pos.x : el.x}%`;
      node.style.top = `${pos ? pos.y : el.y}%`;
      node.style.width = `${el.w}%`;
      node.style.height = `${el.h}%`;
      node.style.setProperty("--s", el.size);
      node.style.color = el.textColor || "#1b1b1b";
      const fill = state.color?.[el.id] || el.color;
      if (fill && el.type !== "image") node.style.background = fill;
      const text = state.text?.[el.id] ?? el.text;
      if (el.type === "image") {
        const img = document.createElement("img");
        img.src = opts.assetUrl(state.img?.[el.id] || el.asset);
        img.alt = "";
        img.draggable = false;
        node.append(img);
      } else if (el.type === "counter") {
        node.textContent = `${text || ""}${state.num?.[el.id] ?? el.value ?? 0}`;
      } else if (el.type === "timer") {
        const end = state.timers?.[el.timer];
        const timer = def.timers.find((t) => t.id === el.timer);
        const left = end ? end - opts.now() : (timer?.secs || 0) * 1000;
        node.textContent = `${text || ""}${fmtTimer(left)}`;
        node.classList.toggle("running", Boolean(end));
      } else {
        node.textContent = text;
      }
      if (!opts.editing && opts.onPress) {
        node.addEventListener("click", (event) => {
          event.stopPropagation();
          opts.onPress(el.id, node);
        });
        const pressable = def.rules.some((r) => r.when.on === "press" && r.when.el === el.id);
        if (pressable) node.classList.add("pressable");
      }
      if (opts.editing) {
        node.addEventListener("pointerdown", (event) => opts.onSelect?.(el, event, node));
        if (opts.selectedId === el.id) {
          const handle = document.createElement("span");
          handle.className = "crumb-resize";
          handle.dataset.resize = "1";
          node.append(handle);
        }
      }
      card.append(node);
    }
  }

  function playFired(fired, assetUrl) {
    for (const f of fired || []) {
      if (f.a === "screen") Fx.screenPulse(f.kind, f.secs);
      else if (f.a === "sound") {
        const audio = new Audio(assetUrl(f.asset));
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
      entry = { def: message.fx.crumb, state: incoming, offset: 0, cards: new Set(), tickSent: 0 };
      live.set(message.id, entry);
    } else if (JSON.stringify(entry.def) !== JSON.stringify(message.fx.crumb)) {
      // The crumb was edited: start fresh with the new version.
      entry.def = message.fx.crumb;
      entry.state = incoming;
    } else if (incoming && (incoming.seq || 0) >= (entry.state?.seq || 0)) {
      entry.state = incoming;
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
      onPress: (el) => send(id, { type: "press", el }),
    });
  }

  async function send(id, event) {
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
    if (payload.serverNow) entry.offset = payload.serverNow - Date.now();
    redrawEntry(payload.messageId);
    // Everyone gets the screen effects/sounds once (the socket event), not twice.
    if (changed && !fromMe) playFired(payload.fired, serverUrl);
    else if (changed && fromMe) {
      entry.lastFiredSeq = payload.state.seq;
      playFired(payload.fired, serverUrl);
    }
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
    if (def.title) {
      const title = document.createElement("div");
      title.className = "crumb-title";
      title.textContent = `🍪 ${def.title}`;
      wrap.append(title);
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
      if (due <= now && Date.now() - entry.tickSent > 1500) {
        entry.tickSent = Date.now();
        send(id, { type: "tick" });
      }
    }
  }, 250);

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
    for (const a of assets.values()) if (a.file) URL.revokeObjectURL(a.url);
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
      color: type === "button" ? "#e0457b" : type === "box" ? "#4d9dff" : null,
      textColor: type === "button" ? "#ffffff" : "#1b1b1b",
      size: type === "text" ? 18 : 16,
      shape: type === "button" ? "pill" : "rounded",
    };
    if (type === "image") el.asset = asset;
    if (type === "counter") el.value = 0;
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

  function paintStage() {
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
    paintProps();
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
    const head = document.createElement("div");
    head.className = "cb-props-head";
    head.textContent = `${LABELS[el.type]} · ${el.id}`;
    props.append(head);
    const grid = document.createElement("div");
    grid.className = "cb-props-grid";
    if (el.type !== "image" && el.type !== "box") {
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
        field("Color", inputEl("color", el.color || "#ffffff", (v) => {
          el.color = v;
          redrawSoon();
        }))
      );
      grid.append(
        field("Text color", inputEl("color", el.textColor || "#1b1b1b", (v) => {
          el.textColor = v;
          redrawSoon();
        }))
      );
      const size = inputEl("range", el.size, (v) => {
        el.size = v;
        redrawSoon();
      }, { min: 8, max: 72 });
      grid.append(field("Text size", size));
      grid.append(
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
        inputEl("number", t.secs, (v) => (t.secs = Math.max(0.5, v || 1)), { min: 0.5, max: 3600, step: 0.5 })
      );
      const secs = document.createElement("span");
      secs.textContent = "seconds";
      const x = document.createElement("button");
      x.type = "button";
      x.className = "bar-x";
      x.textContent = "×";
      x.addEventListener("click", () => {
        def.timers = def.timers.filter((item) => item !== t);
        paintRules();
      });
      row.append(secs, x);
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

  function triggerOptions() {
    const opts = def.elements.map((el) => [`press:${el.id}`, `${elName(el.id)} is pressed`]);
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
      rule.when.on === "press"
        ? `press:${rule.when.el}`
        : rule.when.on === "timer"
          ? `timer:${rule.when.timer}`
          : rule.when.on === "count"
            ? `count:${rule.when.el}`
            : rule.when.on === "after"
              ? "after"
              : "start";
    const trig = selectEl(triggerOptions(), key, (v) => {
      const [on, id] = v.split(":");
      if (on === "press") rule.when = { on, el: id };
      else if (on === "timer") rule.when = { on, timer: id };
      else if (on === "count") rule.when = { on, el: id, cmp: ">=", n: 10 };
      else if (on === "after") rule.when = { on: "after" };
      else rule.when = { on: "start" };
      paintRules();
    });
    whenRow.append(whenLabel, trig);
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

  const withPressed = () => [["@pressed", "the pressed one"], ...def.elements.map((e) => [e.id, elName(e.id)])];

  const COND_KINDS = [
    ["text:==", "text is"],
    ["text:!=", "text isn't"],
    ["num:>=", "counter ≥"],
    ["num:<=", "counter ≤"],
    ["num:==", "counter ="],
    ["num:!=", "counter ≠"],
    ["shown:==", "is shown"],
    ["shown:!=", "is hidden"],
  ];

  function condRow(rule, cond, index) {
    const row = document.createElement("div");
    row.className = "cb-rule-row cb-cond";
    const label = document.createElement("span");
    label.textContent = index === 0 ? "only if" : "and";
    row.append(
      label,
      selectEl(withPressed(), cond.el, (v) => (cond.el = v)),
      selectEl(COND_KINDS, `${cond.k}:${cond.op}`, (v) => {
        const [k, op] = v.split(":");
        cond.k = k;
        cond.op = op;
        cond.v = k === "num" ? 0 : k === "text" ? "" : undefined;
        paintRules();
      })
    );
    if (cond.k === "text") {
      row.append(inputEl("text", cond.v, (v) => (cond.v = v), { maxLength: 200, placeholder: "(empty)" }));
    } else if (cond.k === "num") {
      row.append(inputEl("number", cond.v, (v) => (cond.v = v), { className: "cb-num" }));
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

  const ACTIONS = [
    ["show", "show"],
    ["hide", "hide"],
    ["toggle", "show/hide"],
    ["text", "change text of"],
    ["color", "change color of"],
    ["image", "change image of"],
    ["add", "add to counter"],
    ["set", "set counter"],
    ["move", "move"],
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
    if (["show", "hide", "toggle", "text", "color", "move", "image"].includes(action.a)) {
      const opts =
        action.a === "image"
          ? [["@pressed", "the pressed one"], ...elOptions.filter(([id]) => def.elements.find((e) => e.id === id)?.type === "image")]
          : withPressed();
      row.append(selectEl(opts, action.el, (v) => (action.el = v)));
    }
    if (action.a === "wait") {
      row.append(
        selectEl([["*", "anything"], ...elOptions], action.el, (v) => (action.el = v)),
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
    if (action.a === "add" || action.a === "set") {
      row.append(
        selectEl(elOptions.filter(([id]) => def.elements.find((e) => e.id === id)?.type === "counter"), action.el, (v) => (action.el = v)),
        inputEl("number", action.n, (v) => (action.n = v), { className: "cb-num" })
      );
    }
    if (action.a === "text") row.append(inputEl("text", action.text, (v) => (action.text = v), { maxLength: 200 }));
    if (action.a === "color") row.append(inputEl("color", action.color, (v) => (action.color = v)));
    if (action.a === "move") {
      row.append(
        inputEl("number", action.x, (v) => (action.x = v), { className: "cb-num", title: "x %" }),
        inputEl("number", action.y, (v) => (action.y = v), { className: "cb-num", title: "y %" })
      );
    }
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
        onPress: (el) => {
          const result = E.apply(clean, testState, { type: "press", el });
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
    }, 200);
  }

  function stopTest() {
    clearInterval(testTimer);
    testTimer = null;
  }

  $("cb-test-reset").addEventListener("click", () => {
    stopTest();
    startTest();
  });

  // ---------- send ----------
  $("cb-send").addEventListener("click", async () => {
    showError(errorEl, "");
    const clean = sanitizedPreview();
    if (!clean) {
      showError(errorEl, "Add at least one thing to your crumb.");
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

  return { openBuilder, openEdit, renderCard, onRemoteState };
})();
