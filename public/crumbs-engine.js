// Crumbs: tiny no-code interactive cards that live inside a message.
// This file is shared by the browser and the server (the server is the
// referee, so everyone sees the same thing). No imports/exports on purpose.
(function (root) {
  const TYPES = ["button", "text", "image", "counter", "timer", "box"];
  const ASPECTS = { square: 1, wide: 16 / 9, tall: 3 / 4 };
  const SHAPES = ["rounded", "pill", "circle", "square"];
  const SCREEN_KINDS = ["shake", "flip", "mirror", "spin", "invert", "rainbow", "zoom", "wobble", "tilt", "grayscale"];
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const ID = /^[A-Za-z0-9_-]{1,24}$/;
  const MAX = { elements: 40, timers: 12, rules: 60, actions: 12, text: 200 };

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const color = (value, fallback = null) => (typeof value === "string" && HEX.test(value) ? value.toLowerCase() : fallback);

  // Clean a crumb definition. assetFor(value) maps an image/sound reference to
  // a stored asset id (or returns null to drop it).
  function sanitize(raw, assetFor = (a) => a) {
    if (!raw || typeof raw !== "object") return null;
    const def = {
      v: 1,
      title: str(raw.title, 60),
      aspect: ASPECTS[raw.aspect] ? raw.aspect : "square",
      bg: color(raw.bg, "#fff7ec"),
      elements: [],
      timers: [],
      rules: [],
    };
    const ids = new Set();
    for (const item of (Array.isArray(raw.elements) ? raw.elements : []).slice(0, MAX.elements)) {
      if (!item || !TYPES.includes(item.type) || !ID.test(String(item.id || "")) || ids.has(item.id)) continue;
      const el = {
        id: item.id,
        type: item.type,
        x: clamp(item.x, 0, 100, 10),
        y: clamp(item.y, 0, 100, 10),
        w: clamp(item.w, 3, 100, 30),
        h: clamp(item.h, 3, 100, 15),
        hidden: Boolean(item.hidden),
        text: str(item.text, MAX.text),
        color: color(item.color, item.type === "button" ? "#e0457b" : null),
        textColor: color(item.textColor, "#1b1b1b"),
        size: Math.round(clamp(item.size, 8, 72, 16)),
        shape: SHAPES.includes(item.shape) ? item.shape : "rounded",
      };
      if (item.type === "image") {
        el.asset = item.asset != null ? assetFor(item.asset) : null;
        if (!el.asset) continue;
      }
      if (item.type === "counter") el.value = Math.round(clamp(item.value, -1e6, 1e6, 0));
      if (item.type === "timer") el.timer = ID.test(String(item.timer || "")) ? item.timer : null;
      ids.add(el.id);
      def.elements.push(el);
    }
    const timerIds = new Set();
    for (const t of (Array.isArray(raw.timers) ? raw.timers : []).slice(0, MAX.timers)) {
      if (!t || !ID.test(String(t.id || "")) || timerIds.has(t.id)) continue;
      timerIds.add(t.id);
      def.timers.push({ id: t.id, name: str(t.name, 30) || t.id, secs: clamp(t.secs, 0.5, 3600, 5) });
    }
    for (const el of def.elements) if (el.type === "timer" && !timerIds.has(el.timer)) el.timer = null;
    const cleanAction = (a) => {
      if (!a || typeof a !== "object") return null;
      const el = ids.has(a.el) ? a.el : null;
      switch (a.a) {
        case "show":
        case "hide":
        case "toggle":
          return el ? { a: a.a, el } : null;
        case "text":
          return el ? { a: "text", el, text: str(a.text, MAX.text) } : null;
        case "image": {
          const asset = a.asset != null ? assetFor(a.asset) : null;
          return el && asset ? { a: "image", el, asset } : null;
        }
        case "color": {
          const c = color(a.color);
          return el && c ? { a: "color", el, color: c } : null;
        }
        case "add":
        case "set":
          return el ? { a: a.a, el, n: Math.round(clamp(a.n, -1e6, 1e6, a.a === "add" ? 1 : 0)) } : null;
        case "move":
          return el ? { a: "move", el, x: clamp(a.x, 0, 100, 50), y: clamp(a.y, 0, 100, 50) } : null;
        case "start":
        case "stop":
          return timerIds.has(a.timer) ? { a: a.a, timer: a.timer } : null;
        case "screen":
          return SCREEN_KINDS.includes(a.kind) ? { a: "screen", kind: a.kind, secs: clamp(a.secs, 0.5, 30, 2) } : null;
        case "sound": {
          const asset = a.asset != null ? assetFor(a.asset) : null;
          return asset ? { a: "sound", asset } : null;
        }
        case "reset":
          return { a: "reset" };
        default:
          return null;
      }
    };
    for (const r of (Array.isArray(raw.rules) ? raw.rules : []).slice(0, MAX.rules)) {
      if (!r || !r.when) continue;
      let when = null;
      if (r.when.on === "press" && ids.has(r.when.el)) when = { on: "press", el: r.when.el };
      else if (r.when.on === "timer" && timerIds.has(r.when.timer)) when = { on: "timer", timer: r.when.timer };
      else if (r.when.on === "start") when = { on: "start" };
      else if (r.when.on === "count" && ids.has(r.when.el) && [">=", "<=", "=="].includes(r.when.cmp)) {
        when = { on: "count", el: r.when.el, cmp: r.when.cmp, n: Math.round(clamp(r.when.n, -1e6, 1e6, 10)) };
      }
      if (!when) continue;
      const actions = (Array.isArray(r.do) ? r.do : []).slice(0, MAX.actions).map(cleanAction).filter(Boolean);
      if (actions.length) def.rules.push({ when, do: actions });
    }
    return def.elements.length ? def : null;
  }

  function assetsOf(def) {
    const out = new Set();
    for (const el of def?.elements || []) if (el.asset) out.add(el.asset);
    for (const r of def?.rules || []) for (const a of r.do) if (a.asset) out.add(a.asset);
    return out;
  }

  function baseState(def) {
    const state = { vis: {}, text: {}, img: {}, color: {}, num: {}, pos: {}, timers: {}, seq: 0 };
    for (const el of def.elements) {
      state.vis[el.id] = !el.hidden;
      if (el.type === "counter") state.num[el.id] = el.value || 0;
    }
    for (const t of def.timers) state.timers[t.id] = null;
    return state;
  }

  function countMatches(rule, state) {
    const n = state.num[rule.when.el] || 0;
    if (rule.when.cmp === ">=") return n >= rule.when.n;
    if (rule.when.cmp === "<=") return n <= rule.when.n;
    return n === rule.when.n;
  }

  // Runs a list of actions; returns effects everyone should see (screen/sound).
  function run(def, state, actions, now, fired, budget) {
    for (const a of actions) {
      if (budget.left-- <= 0) return;
      switch (a.a) {
        case "show":
          state.vis[a.el] = true;
          break;
        case "hide":
          state.vis[a.el] = false;
          break;
        case "toggle":
          state.vis[a.el] = !state.vis[a.el];
          break;
        case "text":
          state.text[a.el] = a.text;
          break;
        case "image":
          state.img[a.el] = a.asset;
          break;
        case "color":
          state.color[a.el] = a.color;
          break;
        case "move":
          state.pos[a.el] = { x: a.x, y: a.y };
          break;
        case "add":
        case "set": {
          const before = { ...state.num };
          state.num[a.el] = a.a === "add" ? (state.num[a.el] || 0) + a.n : a.n;
          // "when counter reaches N" rules fire when the condition becomes true.
          for (const rule of def.rules) {
            if (rule.when.on !== "count" || rule.when.el !== a.el) continue;
            const was = countMatches(rule, { num: before });
            if (!was && countMatches(rule, state)) run(def, state, rule.do, now, fired, budget);
          }
          break;
        }
        case "start": {
          const timer = def.timers.find((t) => t.id === a.timer);
          if (timer) state.timers[a.timer] = now + timer.secs * 1000;
          break;
        }
        case "stop":
          state.timers[a.timer] = null;
          break;
        case "screen":
        case "sound":
          fired.push(a);
          break;
        case "reset": {
          const fresh = baseState(def);
          Object.assign(state, fresh, { seq: state.seq });
          break;
        }
        default:
          break;
      }
    }
  }

  function initialState(def, now = Date.now()) {
    const state = baseState(def);
    const fired = [];
    const budget = { left: 200 };
    for (const rule of def.rules) {
      if (rule.when.on === "start") run(def, state, rule.do, now, fired, budget);
    }
    return state;
  }

  // event: { type: "press", el } or { type: "tick" } (finish expired timers)
  function apply(def, prevState, event, now = Date.now()) {
    const state = JSON.parse(JSON.stringify(prevState || initialState(def, now)));
    const fired = [];
    const budget = { left: 200 };
    let changed = false;
    if (event?.type === "press") {
      const el = def.elements.find((item) => item.id === event.el);
      if (el && state.vis[el.id] !== false) {
        for (const rule of def.rules) {
          if (rule.when.on === "press" && rule.when.el === el.id) {
            run(def, state, rule.do, now, fired, budget);
            changed = true;
          }
        }
      }
    }
    // Timers that are done (a press may also have run for a while).
    for (let guard = 0; guard < 20; guard += 1) {
      const due = Object.entries(state.timers).filter(([, end]) => end && end <= now);
      if (!due.length) break;
      for (const [id] of due) {
        state.timers[id] = null;
        changed = true;
        for (const rule of def.rules) {
          if (rule.when.on === "timer" && rule.when.timer === id) run(def, state, rule.do, now, fired, budget);
        }
      }
    }
    if (changed) state.seq = (state.seq || 0) + 1;
    return { state, fired, changed };
  }

  const api = { sanitize, initialState, apply, assetsOf, TYPES, ASPECTS, SHAPES, SCREEN_KINDS };
  root.CrumbsEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
