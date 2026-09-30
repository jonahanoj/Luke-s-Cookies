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
  const MAX = { elements: 60, timers: 12, rules: 120, actions: 30, text: 200 };

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
      // "@pressed" = whichever element was just pressed.
      const el = ids.has(a.el) || a.el === "@pressed" ? a.el : null;
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
        case "addc": {
          // add one counter's number onto another counter
          const from = ids.has(a.from) ? a.from : null;
          return el && from ? { a: "addc", from, el } : null;
        }
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
        case "wait": {
          // wait until a certain element (or "*" = anything) is pressed
          const target = ids.has(a.el) || a.el === "*" ? a.el : null;
          return target ? { a: "wait", el: target, blank: Boolean(a.blank) } : null;
        }
        case "delay":
          return { a: "delay", secs: clamp(a.secs, 0.2, 3600, 1) };
        case "loop":
          return { a: "loop" };
        case "halt":
          return { a: "halt" };
        case "copy": {
          const from = ids.has(a.from) || a.from === "@pressed" ? a.from : null;
          return el && from ? { a: "copy", from, el } : null;
        }
        default:
          return null;
      }
    };
    const cleanCond = (c) => {
      if (!c || typeof c !== "object") return null;
      const el = ids.has(c.el) || c.el === "@pressed" ? c.el : null;
      if (!el) return null;
      if (c.k === "text") return { k: "text", el, op: c.op === "!=" ? "!=" : "==", v: str(c.v, MAX.text) };
      if (c.k === "num" && [">=", "<=", "==", "!="].includes(c.op)) {
        return { k: "num", el, op: c.op, v: Math.round(clamp(c.v, -1e6, 1e6, 0)) };
      }
      if (c.k === "shown") return { k: "shown", el, op: c.op === "!=" ? "!=" : "==" };
      return null;
    };
    for (const r of (Array.isArray(raw.rules) ? raw.rules : []).slice(0, MAX.rules)) {
      if (!r || !r.when) continue;
      let when = null;
      if (r.when.on === "press" && ids.has(r.when.el)) when = { on: "press", el: r.when.el };
      else if (r.when.on === "timer" && timerIds.has(r.when.timer)) when = { on: "timer", timer: r.when.timer };
      else if (r.when.on === "start") when = { on: "start" };
      else if (r.when.on === "after") when = { on: "after" };
      else if (r.when.on === "count" && ids.has(r.when.el) && [">=", "<=", "=="].includes(r.when.cmp)) {
        when = { on: "count", el: r.when.el, cmp: r.when.cmp, n: Math.round(clamp(r.when.n, -1e6, 1e6, 10)) };
      }
      if (!when) continue;
      const actions = (Array.isArray(r.do) ? r.do : []).slice(0, 30).map(cleanAction).filter(Boolean);
      const conds = (Array.isArray(r.if) ? r.if : []).slice(0, 10).map(cleanCond).filter(Boolean);
      if (actions.length) def.rules.push(conds.length ? { when, if: conds, do: actions } : { when, do: actions });
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
    const state = { vis: {}, text: {}, img: {}, color: {}, num: {}, pos: {}, timers: {}, waits: [], seq: 0 };
    for (const el of def.elements) {
      state.vis[el.id] = !el.hidden;
      if (el.type === "counter") state.num[el.id] = el.value || 0;
    }
    for (const t of def.timers) state.timers[t.id] = null;
    return state;
  }

  function textOf(def, state, id) {
    if (state.text[id] !== undefined) return state.text[id];
    return def.elements.find((el) => el.id === id)?.text || "";
  }

  function condsMet(def, state, rule, ctx) {
    for (const c of rule.if || []) {
      const id = c.el === "@pressed" ? ctx.pressed : c.el;
      if (!id) return false;
      if (c.k === "text") {
        const same = textOf(def, state, id) === c.v;
        if ((c.op === "==") !== same) return false;
      } else if (c.k === "num") {
        const n = state.num[id] || 0;
        const ok =
          c.op === ">=" ? n >= c.v : c.op === "<=" ? n <= c.v : c.op === "==" ? n === c.v : n !== c.v;
        if (!ok) return false;
      } else if (c.k === "shown") {
        const shown = state.vis[id] !== false;
        if ((c.op === "==") !== shown) return false;
      }
    }
    return true;
  }

  function countMatches(rule, state) {
    const n = state.num[rule.when.el] || 0;
    if (rule.when.cmp === ">=") return n >= rule.when.n;
    if (rule.when.cmp === "<=") return n <= rule.when.n;
    return n === rule.when.n;
  }

  // Runs a list of actions. Screen/sound effects go into `fired` for
  // everyone to see. ctx = { pressed, rule } (who was pressed, which rule).
  function run(def, state, actions, now, fired, budget, ctx = {}) {
    const target = (id) => (id === "@pressed" ? ctx.pressed : id);
    for (let i = 0; i < actions.length; i += 1) {
      const a = actions[i];
      if (budget.left-- <= 0) return;
      const el = target(a.el);
      switch (a.a) {
        case "show":
          if (el) state.vis[el] = true;
          break;
        case "hide":
          if (el) state.vis[el] = false;
          break;
        case "toggle":
          if (el) state.vis[el] = !state.vis[el];
          break;
        case "text":
          if (el) state.text[el] = a.text;
          break;
        case "copy": {
          const from = target(a.from);
          if (el && from) state.text[el] = textOf(def, state, from);
          break;
        }
        case "image":
          if (el) state.img[el] = a.asset;
          break;
        case "color":
          if (el) state.color[el] = a.color;
          break;
        case "move":
          if (el) state.pos[el] = { x: a.x, y: a.y };
          break;
        case "add":
        case "addc":
        case "set": {
          if (!el) break;
          const before = { ...state.num };
          const amount = a.a === "addc" ? state.num[a.from] || 0 : a.n;
          state.num[el] = a.a === "set" ? amount : Math.max(-1e9, Math.min(1e9, (state.num[el] || 0) + amount));
          // "when counter reaches N" rules fire when the condition becomes true.
          def.rules.forEach((rule, index) => {
            if (rule.when.on !== "count" || rule.when.el !== el) return;
            const was = countMatches(rule, { num: before });
            if (!was && countMatches(rule, state) && condsMet(def, state, rule, ctx)) {
              run(def, state, rule.do, now, fired, budget, { ...ctx, rule: index });
            }
          });
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
        case "wait":
          // Pause here until the right thing is pressed.
          if (state.waits.length < 50) {
            state.waits.push({ el: a.el, blank: a.blank, rest: actions.slice(i + 1), rule: ctx.rule ?? null, pressed: ctx.pressed || null });
          }
          return;
        case "delay":
          if (state.waits.length < 50) {
            state.waits.push({ until: now + a.secs * 1000, rest: actions.slice(i + 1), rule: ctx.rule ?? null, pressed: ctx.pressed || null });
          }
          return;
        case "halt":
          // Stop everything that's waiting (e.g. the game is over).
          state.waits = [];
          return;
        case "loop": {
          // Start this rule's steps over (use a wait or delay so it doesn't spin).
          const rule = def.rules[ctx.rule];
          if (rule && budget.left > 0) run(def, state, rule.do, now, fired, budget, ctx);
          return;
        }
        case "reset": {
          const fresh = baseState(def);
          Object.assign(state, fresh, { seq: state.seq });
          runStart(def, state, now, fired, budget);
          return;
        }
        default:
          break;
      }
    }
  }

  function runStart(def, state, now, fired, budget) {
    def.rules.forEach((rule, index) => {
      if (rule.when.on === "start" && condsMet(def, state, rule, {})) {
        run(def, state, rule.do, now, fired, budget, { rule: index });
      }
    });
  }

  function initialState(def, now = Date.now()) {
    const state = baseState(def);
    runStart(def, state, now, [], { left: 400 });
    return state;
  }

  // event: { type: "press", el } or { type: "tick" } (finish timers/delays)
  function apply(def, prevState, event, now = Date.now()) {
    const state = JSON.parse(JSON.stringify(prevState || initialState(def, now)));
    if (!Array.isArray(state.waits)) state.waits = [];
    const fired = [];
    const budget = { left: 400 };
    let changed = false;
    if (event?.type === "press") {
      const el = def.elements.find((item) => item.id === event.el);
      if (el && state.vis[el.id] !== false) {
        const ctx = { pressed: el.id };
        // Anything that was waiting for this press carries on.
        const ready = state.waits.filter(
          (w) => w.el && (w.el === el.id || w.el === "*") && (!w.blank || !textOf(def, state, el.id))
        );
        if (ready.length) {
          state.waits = state.waits.filter((w) => !ready.includes(w));
          for (const w of ready) run(def, state, w.rest, now, fired, budget, { pressed: el.id, rule: w.rule });
          changed = true;
        }
        def.rules.forEach((rule, index) => {
          if (rule.when.on === "press" && rule.when.el === el.id && condsMet(def, state, rule, ctx)) {
            run(def, state, rule.do, now, fired, budget, { ...ctx, rule: index });
            changed = true;
          }
        });
        // "After any press" rules (good for checking who won).
        def.rules.forEach((rule, index) => {
          if (rule.when.on === "after" && condsMet(def, state, rule, ctx)) {
            run(def, state, rule.do, now, fired, budget, { ...ctx, rule: index });
            changed = true;
          }
        });
      }
    }
    // Timers and delays that are done.
    for (let guard = 0; guard < 20; guard += 1) {
      const due = Object.entries(state.timers).filter(([, end]) => end && end <= now);
      const delays = state.waits.filter((w) => w.until && w.until <= now);
      if (!due.length && !delays.length) break;
      for (const [id] of due) {
        state.timers[id] = null;
        changed = true;
        def.rules.forEach((rule, index) => {
          if (rule.when.on === "timer" && rule.when.timer === id && condsMet(def, state, rule, {})) {
            run(def, state, rule.do, now, fired, budget, { rule: index });
          }
        });
      }
      if (delays.length) {
        state.waits = state.waits.filter((w) => !delays.includes(w));
        for (const w of delays) run(def, state, w.rest, now, fired, budget, { pressed: w.pressed, rule: w.rule });
        changed = true;
      }
    }
    if (changed) state.seq = (state.seq || 0) + 1;
    return { state, fired, changed };
  }

  // Next moment something time-based happens (for clients to send a tick).
  function nextDue(state) {
    const times = [
      ...Object.values(state?.timers || {}).filter(Boolean),
      ...(state?.waits || []).map((w) => w.until).filter(Boolean),
    ];
    return times.length ? Math.min(...times) : null;
  }

  const api = { sanitize, initialState, apply, nextDue, assetsOf, TYPES, ASPECTS, SHAPES, SCREEN_KINDS };
  root.CrumbsEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
