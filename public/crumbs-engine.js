// Crumbs: tiny no-code interactive cards that live inside a message.
// This file is shared by the browser and the server (the server is the
// referee, so everyone sees the same thing). No imports/exports on purpose.
(function (root) {
  const TYPES = ["button", "text", "image", "counter", "timer", "box", "grid"];
  const ASPECTS = { square: 1, wide: 16 / 9, tall: 3 / 4 };
  const SHAPES = ["rounded", "pill", "circle", "square"];
  const SCREEN_KINDS = ["shake", "flip", "mirror", "spin", "invert", "rainbow", "zoom", "wobble", "tilt", "grayscale"];
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const ID = /^[A-Za-z0-9_-]{1,24}$/;
  const GROUP = /^[A-Za-z0-9 _-]{1,24}$/;
  const MAX = { elements: 60, timers: 12, rules: 120, actions: 30, text: 200, cell: 20, gridSide: 12 };

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const color = (value, fallback = null) => (typeof value === "string" && HEX.test(value) ? value.toLowerCase() : fallback);

  // ---------- math ("score + hits * 10", "rand(1, 6)", "row == 2") ----------
  // A tiny safe calculator. Names are counters (their number) or text
  // elements (their text as a number). row/col = the grid cell just pressed.
  function tokenize(src) {
    const out = [];
    const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_-]*)|"([^"]*)"|'([^']*)'|(<=|>=|==|!=|&&|\|\||[-+*/%()<>,!]))/y;
    let m;
    re.lastIndex = 0;
    while (re.lastIndex < src.length) {
      const at = re.lastIndex;
      m = re.exec(src);
      if (!m) {
        if (/^\s*$/.test(src.slice(at))) break;
        throw new Error("bad math");
      }
      if (m[1] !== undefined) out.push({ t: "n", v: Number(m[1]) });
      else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
      else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: "s", v: m[3] ?? m[4] });
      else out.push({ t: "op", v: m[5] });
    }
    return out;
  }

  function evaluate(expr, lookup) {
    const tokens = tokenize(String(expr || ""));
    let i = 0;
    const peek = () => tokens[i];
    const take = (v) => {
      if (peek()?.v === v) {
        i += 1;
        return true;
      }
      return false;
    };
    const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
    function primary() {
      const tok = tokens[i++];
      if (!tok) throw new Error("bad math");
      if (tok.t === "n" || tok.t === "s") return tok.v;
      if (tok.t === "op" && tok.v === "(") {
        const v = orExpr();
        take(")");
        return v;
      }
      if (tok.t === "op" && tok.v === "-") return -num(unary());
      if (tok.t === "op" && tok.v === "!") return num(unary()) ? 0 : 1;
      if (tok.t === "id") {
        if (take("(")) {
          const args = [];
          if (!take(")")) {
            do {
              // Raw names for functions that want an element, not its value.
              if (["x", "y", "count", "text"].includes(tok.v) && args.length === 0 && peek()?.t === "id") {
                args.push({ name: tokens[i++].v });
              } else args.push(orExpr());
            } while (take(","));
            take(")");
          }
          return lookup.call(tok.v, args);
        }
        return lookup.name(tok.v);
      }
      throw new Error("bad math");
    }
    function unary() {
      return primary();
    }
    function mul() {
      let v = unary();
      for (;;) {
        if (take("*")) v = num(v) * num(unary());
        else if (take("/")) {
          const d = num(unary());
          v = d ? num(v) / d : 0;
        } else if (take("%")) {
          const d = num(unary());
          v = d ? num(v) % d : 0;
        } else return v;
      }
    }
    function addExpr() {
      let v = mul();
      for (;;) {
        if (take("+")) {
          const r = mul();
          v = typeof v === "string" || typeof r === "string" ? `${v}${r}` : num(v) + num(r);
        } else if (take("-")) v = num(v) - num(mul());
        else return v;
      }
    }
    function cmp() {
      let v = addExpr();
      for (;;) {
        const op = peek()?.t === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(peek().v) ? tokens[i++].v : null;
        if (!op) return v;
        const r = addExpr();
        const same = typeof v === "string" || typeof r === "string" ? String(v) === String(r) : num(v) === num(r);
        v =
          op === "==" ? same : op === "!=" ? !same : op === "<" ? num(v) < num(r) : op === "<=" ? num(v) <= num(r) : op === ">" ? num(v) > num(r) : num(v) >= num(r);
        v = v ? 1 : 0;
      }
    }
    function andExpr() {
      let v = cmp();
      while (take("&&")) {
        const r = cmp();
        v = num(v) && num(r) ? 1 : 0;
      }
      return v;
    }
    function orExpr() {
      let v = andExpr();
      while (take("||")) {
        const r = andExpr();
        v = num(v) || num(r) ? 1 : 0;
      }
      return v;
    }
    const result = orExpr();
    if (i < tokens.length) throw new Error("bad math");
    return result;
  }

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
    const groups = new Set();
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
      if (typeof item.group === "string" && GROUP.test(item.group.trim())) {
        el.group = item.group.trim();
        groups.add(el.group);
      }
      if (item.type === "image") {
        el.asset = item.asset != null ? assetFor(item.asset) : null;
        if (!el.asset) continue;
      }
      if (item.type === "counter") el.value = Math.round(clamp(item.value, -1e6, 1e6, 0));
      if (item.type === "timer") el.timer = ID.test(String(item.timer || "")) ? item.timer : null;
      if (item.type === "grid") {
        el.cols = Math.round(clamp(item.cols, 1, MAX.gridSide, 3));
        el.rows = Math.round(clamp(item.rows, 1, MAX.gridSide, 3));
        el.lines = color(item.lines, "#3b2a1a");
        const cells = Array.isArray(item.cells) ? item.cells : [];
        if (cells.some((c) => typeof c === "string" && c)) {
          el.cells = Array.from({ length: el.cols * el.rows }, (_, i) => str(cells[i], MAX.cell));
        }
      }
      ids.add(el.id);
      def.elements.push(el);
    }
    const timerIds = new Set();
    for (const t of (Array.isArray(raw.timers) ? raw.timers : []).slice(0, MAX.timers)) {
      if (!t || !ID.test(String(t.id || "")) || timerIds.has(t.id)) continue;
      timerIds.add(t.id);
      const timer = { id: t.id, name: str(t.name, 30) || t.id, secs: clamp(t.secs, 0.1, 3600, 5) };
      if (t.repeat) timer.repeat = true;
      def.timers.push(timer);
    }
    for (const el of def.elements) if (el.type === "timer" && !timerIds.has(el.timer)) el.timer = null;
    const gridIds = new Set(def.elements.filter((el) => el.type === "grid").map((el) => el.id));
    // An element reference: an id, "@pressed", or "group:<name>".
    const ref = (value, allowPressed = true) => {
      if (ids.has(value)) return value;
      if (allowPressed && value === "@pressed") return value;
      if (typeof value === "string" && value.startsWith("group:") && groups.has(value.slice(6))) return value;
      return null;
    };
    const valueSource = (a, out) => {
      // cell values come from typed text, or the text of another element
      if (ref(a.from)) out.from = ref(a.from);
      else out.text = str(a.text, MAX.cell);
      return out;
    };
    const cleanAction = (a) => {
      if (!a || typeof a !== "object") return null;
      // "@pressed" = whichever element was just pressed.
      const el = ref(a.el);
      switch (a.a) {
        case "show":
        case "hide":
        case "toggle":
        case "enable":
        case "disable":
          return el ? { a: a.a, el } : null;
        case "text":
          return el ? { a: "text", el, text: str(a.text, MAX.text) } : null;
        case "cycle": {
          const opts = (Array.isArray(a.opts) ? a.opts : String(a.opts || "").split(","))
            .map((o) => str(String(o), 40).trim())
            .filter(Boolean)
            .slice(0, 12);
          return el && opts.length ? { a: "cycle", el, opts } : null;
        }
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
        case "calc":
          return el && typeof a.expr === "string" && a.expr.trim() ? { a: "calc", el, expr: str(a.expr, 200) } : null;
        case "move":
          return el ? { a: "move", el, x: clamp(a.x, 0, 100, 50), y: clamp(a.y, 0, 100, 50) } : null;
        case "moveby":
          return el ? { a: "moveby", el, dx: clamp(a.dx, -100, 100, 0), dy: clamp(a.dy, -100, 100, 0) } : null;
        case "addc": {
          // add one counter's number onto another counter
          const from = ids.has(a.from) ? a.from : null;
          return el && from ? { a: "addc", from, el } : null;
        }
        case "cell": {
          if (!gridIds.has(a.el)) return null;
          const out = { a: "cell", el: a.el, at: a.at === "rc" ? "rc" : "pressed" };
          if (out.at === "rc") {
            out.r = Math.round(clamp(a.r, 1, MAX.gridSide, 1));
            out.c = Math.round(clamp(a.c, 1, MAX.gridSide, 1));
          }
          return valueSource(a, out);
        }
        case "drop":
          return gridIds.has(a.el) ? valueSource(a, { a: "drop", el: a.el }) : null;
        case "clear":
          return gridIds.has(a.el) ? { a: "clear", el: a.el } : null;
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
          const target = ref(a.el, false) || (a.el === "*" ? "*" : null);
          return target ? { a: "wait", el: target, blank: Boolean(a.blank) } : null;
        }
        case "delay":
          return { a: "delay", secs: clamp(a.secs, 0.1, 3600, 1) };
        case "loop":
          return { a: "loop" };
        case "halt":
          return { a: "halt" };
        case "copy": {
          const from = ref(a.from);
          return el && from ? { a: "copy", from, el } : null;
        }
        default:
          return null;
      }
    };
    const eqOp = (op) => (op === "!=" ? "!=" : "==");
    const cleanCond = (c) => {
      if (!c || typeof c !== "object") return null;
      if (c.k === "math") return typeof c.expr === "string" && c.expr.trim() ? { k: "math", expr: str(c.expr, 200) } : null;
      if (["all", "any", "none"].includes(c.k)) {
        const g = typeof c.el === "string" && c.el.startsWith("group:") && groups.has(c.el.slice(6)) ? c.el : null;
        return g ? { k: c.k, el: g } : null;
      }
      const el = ref(c.el);
      if (!el) return null;
      if (c.k === "text") return { k: "text", el, op: eqOp(c.op), v: str(c.v, MAX.text) };
      if (c.k === "num" && [">=", "<=", "==", "!="].includes(c.op)) {
        return { k: "num", el, op: c.op, v: Math.round(clamp(c.v, -1e6, 1e6, 0)) };
      }
      if (c.k === "shown" || c.k === "enabled") return { k: c.k, el, op: eqOp(c.op) };
      if (c.k === "touch") {
        const other = ref(c.other);
        return other ? { k: "touch", el, other, op: eqOp(c.op) } : null;
      }
      if (!gridIds.has(el)) return null;
      if (c.k === "cell") return { k: "cell", el, op: eqOp(c.op), v: str(c.v, MAX.cell) };
      if (c.k === "room" || c.k === "full") return { k: c.k, el, op: eqOp(c.op) };
      if (c.k === "line") return { k: "line", el, op: eqOp(c.op), v: str(c.v, MAX.cell), n: Math.round(clamp(c.n, 2, MAX.gridSide, 3)) };
      return null;
    };
    for (const r of (Array.isArray(raw.rules) ? raw.rules : []).slice(0, MAX.rules)) {
      if (!r || !r.when) continue;
      let when = null;
      if (r.when.on === "press" && ref(r.when.el, false)) when = { on: "press", el: r.when.el };
      else if (r.when.on === "timer" && timerIds.has(r.when.timer)) when = { on: "timer", timer: r.when.timer };
      else if (r.when.on === "start") when = { on: "start" };
      else if (r.when.on === "after") when = { on: "after" };
      else if (r.when.on === "count" && ids.has(r.when.el) && [">=", "<=", "=="].includes(r.when.cmp)) {
        when = { on: "count", el: r.when.el, cmp: r.when.cmp, n: Math.round(clamp(r.when.n, -1e6, 1e6, 10)) };
      } else if (r.when.on === "touch" && ref(r.when.el, false) && ref(r.when.other, false)) {
        when = { on: "touch", el: r.when.el, other: r.when.other };
      }
      if (!when) continue;
      const actions = (Array.isArray(r.do) ? r.do : []).slice(0, MAX.actions).map(cleanAction).filter(Boolean);
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
    const state = {
      vis: {},
      text: {},
      img: {},
      color: {},
      num: {},
      pos: {},
      grid: {},
      off: {},
      tch: {},
      timers: {},
      waits: [],
      seq: 0,
    };
    for (const el of def.elements) {
      state.vis[el.id] = !el.hidden;
      if (el.type === "counter") state.num[el.id] = el.value || 0;
      if (el.type === "grid") state.grid[el.id] = el.cells ? [...el.cells] : Array(el.cols * el.rows).fill("");
    }
    for (const t of def.timers) state.timers[t.id] = null;
    return state;
  }

  const byId = (def, id) => def.elements.find((el) => el.id === id);

  function textOf(def, state, id) {
    if (state.text[id] !== undefined) return state.text[id];
    return byId(def, id)?.text || "";
  }

  // "@pressed" / "group:x" / id -> list of element ids
  function targets(def, ref, ctx) {
    if (ref === "@pressed") return ctx.pressed ? [ctx.pressed] : [];
    if (typeof ref === "string" && ref.startsWith("group:")) {
      const g = ref.slice(6);
      return def.elements.filter((el) => el.group === g).map((el) => el.id);
    }
    return byId(def, ref) ? [ref] : [];
  }

  function boxOf(def, state, id) {
    const el = byId(def, id);
    if (!el) return null;
    const pos = state.pos?.[id];
    return { x: pos ? pos.x : el.x, y: pos ? pos.y : el.y, w: el.w, h: el.h };
  }

  function touching(def, state, a, b, ctx) {
    const as = targets(def, a, ctx).filter((id) => state.vis[id] !== false);
    const bs = targets(def, b, ctx).filter((id) => state.vis[id] !== false);
    for (const i of as) {
      const p = boxOf(def, state, i);
      for (const j of bs) {
        if (i === j) continue;
        const q = boxOf(def, state, j);
        if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) return true;
      }
    }
    return false;
  }

  function cells(def, state, id) {
    const el = byId(def, id);
    if (!el || el.type !== "grid") return null;
    if (!state.grid) state.grid = {};
    if (!state.grid[id]) state.grid[id] = Array(el.cols * el.rows).fill("");
    return { el, list: state.grid[id] };
  }

  // Is there a line of `n` equal cells? v = "" means "any non-empty value".
  // Returns the value that made the line (so "{line}" can show the winner).
  function findLine(el, list, v, n) {
    const at = (r, c) => (r >= 0 && c >= 0 && r < el.rows && c < el.cols ? list[r * el.cols + c] : undefined);
    for (let r = 0; r < el.rows; r += 1) {
      for (let c = 0; c < el.cols; c += 1) {
        const start = at(r, c);
        if (!start || (v && start !== v)) continue;
        for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
          let k = 1;
          while (k < n && at(r + dr * k, c + dc * k) === start) k += 1;
          if (k >= n) return start;
        }
      }
    }
    return null;
  }

  function mathLookup(def, state, ctx) {
    return {
      name(n) {
        if (n === "row") return ctx.row ?? 0;
        if (n === "col") return ctx.col ?? 0;
        if (n === "true") return 1;
        if (n === "false") return 0;
        if (state.num[n] !== undefined) return state.num[n];
        const el = byId(def, n);
        if (el) {
          const t = textOf(def, state, n);
          const v = Number(t);
          return t !== "" && Number.isFinite(v) ? v : t;
        }
        return 0;
      },
      call(fn, args) {
        const nums = args.map((a) => (typeof a === "object" ? 0 : Number(a) || 0));
        switch (fn) {
          case "min":
            return nums.length ? Math.min(...nums) : 0;
          case "max":
            return nums.length ? Math.max(...nums) : 0;
          case "abs":
            return Math.abs(nums[0] || 0);
          case "round":
            return Math.round(nums[0] || 0);
          case "floor":
            return Math.floor(nums[0] || 0);
          case "ceil":
            return Math.ceil(nums[0] || 0);
          case "rand": {
            const lo = Math.ceil(Math.min(nums[0] ?? 1, nums[1] ?? 6));
            const hi = Math.floor(Math.max(nums[0] ?? 1, nums[1] ?? 6));
            return lo + Math.floor(Math.random() * (hi - lo + 1));
          }
          case "x":
          case "y": {
            const box = args[0]?.name ? boxOf(def, state, args[0].name) : null;
            return box ? box[fn] : 0;
          }
          case "text":
            return args[0]?.name ? textOf(def, state, args[0].name) : "";
          case "count": {
            // count(grid, "X") = how many cells hold X ("" = empty cells)
            const g = args[0]?.name ? cells(def, state, args[0].name) : null;
            const want = args.length > 1 ? String(args[1]) : null;
            if (!g) return 0;
            return g.list.filter((v) => (want === null ? v : v === want)).length;
          }
          default:
            return 0;
        }
      },
    };
  }

  function calc(def, state, expr, ctx) {
    try {
      return evaluate(expr, mathLookup(def, state, ctx));
    } catch {
      return 0;
    }
  }

  // "{score}" in text shows a counter / another element's text;
  // {row} {col} = pressed grid cell, {line} = who made the line.
  function fillTemplate(def, state, text, ctx) {
    return String(text).replace(/\{([A-Za-z0-9_-]{1,24})\}/g, (whole, name) => {
      if (name === "row") return String(ctx.row ?? "");
      if (name === "col") return String(ctx.col ?? "");
      if (name === "line") return ctx.line ?? "";
      if (state.num[name] !== undefined) return String(state.num[name]);
      if (byId(def, name)) return textOf(def, state, name);
      return whole;
    });
  }

  function condsMet(def, state, rule, ctx) {
    for (const c of rule.if || []) {
      if (c.k === "math") {
        const v = calc(def, state, c.expr, ctx);
        if (!(typeof v === "string" ? v : Number(v))) return false;
        continue;
      }
      if (c.k === "all" || c.k === "any" || c.k === "none") {
        const shown = targets(def, c.el, ctx).map((id) => state.vis[id] !== false);
        const ok = c.k === "all" ? shown.every(Boolean) : c.k === "any" ? shown.some(Boolean) : !shown.some(Boolean);
        if (!ok) return false;
        continue;
      }
      if (c.k === "touch") {
        if (touching(def, state, c.el, c.other, ctx) !== (c.op === "==")) return false;
        continue;
      }
      const list = targets(def, c.el, ctx);
      if (!list.length) return false;
      for (const id of list) {
        let ok = true;
        if (c.k === "text") ok = (textOf(def, state, id) === c.v) === (c.op === "==");
        else if (c.k === "num") {
          const n = state.num[id] || 0;
          ok = c.op === ">=" ? n >= c.v : c.op === "<=" ? n <= c.v : c.op === "==" ? n === c.v : n !== c.v;
        } else if (c.k === "shown") ok = (state.vis[id] !== false) === (c.op === "==");
        else if (c.k === "enabled") ok = !state.off?.[id] === (c.op === "==");
        else {
          const g = cells(def, state, id);
          if (!g) return false;
          if (c.k === "cell") {
            const here = ctx.pressed === id && ctx.cell != null ? g.list[ctx.cell] : null;
            ok = here !== null && (here === c.v) === (c.op === "==");
          } else if (c.k === "room") {
            const col = ctx.pressed === id ? ctx.col : null;
            const room = col != null && g.list[col - 1] === "";
            ok = room === (c.op === "==");
          } else if (c.k === "full") {
            ok = g.list.every(Boolean) === (c.op === "==");
          } else if (c.k === "line") {
            const who = findLine(g.el, g.list, c.v, c.n);
            if (who) ctx.line = who;
            ok = Boolean(who) === (c.op === "==");
          }
        }
        if (!ok) return false;
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
  // everyone to see. ctx = { pressed, cell, row, col, rule }.
  function run(def, state, actions, now, fired, budget, ctx = {}) {
    const setNum = (el, value) => {
      const before = { ...state.num };
      state.num[el] = Math.max(-1e9, Math.min(1e9, Math.round(Number(value) || 0)));
      // "when counter reaches N" rules fire when the condition becomes true.
      def.rules.forEach((rule, index) => {
        if (rule.when.on !== "count" || rule.when.el !== el) return;
        const was = countMatches(rule, { num: before });
        const c = { ...ctx };
        if (!was && countMatches(rule, state) && condsMet(def, state, rule, c)) {
          run(def, state, rule.do, now, fired, budget, { ...c, rule: index });
        }
      });
    };
    const valueFor = (a) => (a.from ? textOf(def, state, targets(def, a.from, ctx)[0]) : fillTemplate(def, state, a.text, ctx)).slice(0, MAX.cell);
    for (let i = 0; i < actions.length; i += 1) {
      const a = actions[i];
      if (budget.left-- <= 0) return;
      const list = a.el ? targets(def, a.el, ctx) : [];
      switch (a.a) {
        case "show":
          for (const el of list) state.vis[el] = true;
          break;
        case "hide":
          for (const el of list) state.vis[el] = false;
          break;
        case "toggle":
          for (const el of list) state.vis[el] = !(state.vis[el] !== false);
          break;
        case "enable":
          for (const el of list) delete state.off[el];
          break;
        case "disable":
          for (const el of list) state.off[el] = true;
          break;
        case "text": {
          const text = fillTemplate(def, state, a.text, ctx);
          for (const el of list) state.text[el] = text;
          break;
        }
        case "cycle":
          for (const el of list) {
            const at = a.opts.indexOf(textOf(def, state, el));
            state.text[el] = a.opts[(at + 1) % a.opts.length];
          }
          break;
        case "copy": {
          const from = targets(def, a.from, ctx)[0];
          if (from) for (const el of list) state.text[el] = textOf(def, state, from);
          break;
        }
        case "image":
          for (const el of list) state.img[el] = a.asset;
          break;
        case "color":
          for (const el of list) state.color[el] = a.color;
          break;
        case "move":
          for (const el of list) state.pos[el] = { x: a.x, y: a.y };
          break;
        case "moveby":
          for (const el of list) {
            const box = boxOf(def, state, el);
            state.pos[el] = {
              x: Math.max(0, Math.min(100 - box.w, box.x + a.dx)),
              y: Math.max(0, Math.min(100 - box.h, box.y + a.dy)),
            };
          }
          break;
        case "add":
        case "set":
          for (const el of list) setNum(el, a.a === "add" ? (state.num[el] || 0) + a.n : a.n);
          break;
        case "addc":
          for (const el of list) setNum(el, (state.num[el] || 0) + (state.num[a.from] || 0));
          break;
        case "calc":
          for (const el of list) setNum(el, calc(def, state, a.expr, { ...ctx }));
          break;
        case "cell": {
          const g = cells(def, state, a.el);
          if (!g) break;
          let index = null;
          if (a.at === "rc") {
            if (a.r <= g.el.rows && a.c <= g.el.cols) index = (a.r - 1) * g.el.cols + (a.c - 1);
          } else if (ctx.pressed === a.el && ctx.cell != null) index = ctx.cell;
          if (index !== null) g.list[index] = valueFor(a);
          break;
        }
        case "drop": {
          // Falls to the lowest empty cell of the pressed column.
          const g = cells(def, state, a.el);
          if (!g || ctx.pressed !== a.el || ctx.col == null) break;
          for (let r = g.el.rows - 1; r >= 0; r -= 1) {
            const index = r * g.el.cols + (ctx.col - 1);
            if (!g.list[index]) {
              g.list[index] = valueFor(a);
              break;
            }
          }
          break;
        }
        case "clear": {
          const g = cells(def, state, a.el);
          if (g) g.list.fill("");
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

  // "When A starts touching B" rules: fire once each time they meet.
  function runTouches(def, state, now, fired, budget) {
    if (!state.tch) state.tch = {};
    let any = false;
    for (let pass = 0; pass < 4; pass += 1) {
      let fresh = false;
      def.rules.forEach((rule, index) => {
        if (rule.when.on !== "touch") return;
        const on = touching(def, state, rule.when.el, rule.when.other, {});
        const was = Boolean(state.tch[index]);
        state.tch[index] = on;
        const c = {};
        if (on && !was && condsMet(def, state, rule, c)) {
          run(def, state, rule.do, now, fired, budget, { ...c, rule: index });
          fresh = true;
          any = true;
        }
      });
      if (!fresh) break;
    }
    return any;
  }

  function runStart(def, state, now, fired, budget) {
    def.rules.forEach((rule, index) => {
      const c = {};
      if (rule.when.on === "start" && condsMet(def, state, rule, c)) {
        run(def, state, rule.do, now, fired, budget, { ...c, rule: index });
      }
    });
    runTouches(def, state, now, fired, budget);
  }

  function initialState(def, now = Date.now()) {
    const state = baseState(def);
    runStart(def, state, now, [], { left: 600 });
    return state;
  }

  const inGroupRef = (def, ref, id) =>
    ref === id || (typeof ref === "string" && ref.startsWith("group:") && byId(def, id)?.group === ref.slice(6));

  // event: { type: "press", el, cell? } or { type: "tick" } (finish timers/delays)
  function apply(def, prevState, event, now = Date.now()) {
    const state = JSON.parse(JSON.stringify(prevState || initialState(def, now)));
    if (!Array.isArray(state.waits)) state.waits = [];
    for (const key of ["grid", "off", "tch", "pos"]) if (!state[key]) state[key] = {};
    const fired = [];
    const budget = { left: 600 };
    let changed = false;
    if (event?.type === "press") {
      const el = byId(def, event.el);
      if (el && state.vis[el.id] !== false && !state.off[el.id]) {
        const ctx = { pressed: el.id };
        if (el.type === "grid") {
          const cell = Math.round(Number(event.cell));
          if (!Number.isInteger(cell) || cell < 0 || cell >= el.cols * el.rows) return { state: prevState, fired: [], changed: false };
          ctx.cell = cell;
          ctx.row = Math.floor(cell / el.cols) + 1;
          ctx.col = (cell % el.cols) + 1;
        }
        // Anything that was waiting for this press carries on.
        const ready = state.waits.filter(
          (w) => w.el && (w.el === "*" || inGroupRef(def, w.el, el.id)) && (!w.blank || !textOf(def, state, el.id))
        );
        if (ready.length) {
          state.waits = state.waits.filter((w) => !ready.includes(w));
          for (const w of ready) run(def, state, w.rest, now, fired, budget, { ...ctx, rule: w.rule });
          changed = true;
        }
        def.rules.forEach((rule, index) => {
          const c = { ...ctx };
          if (rule.when.on === "press" && inGroupRef(def, rule.when.el, el.id) && condsMet(def, state, rule, c)) {
            run(def, state, rule.do, now, fired, budget, { ...c, rule: index });
            changed = true;
          }
        });
        // "After any press" rules (good for checking who won).
        def.rules.forEach((rule, index) => {
          const after = { ...ctx };
          if (rule.when.on === "after" && condsMet(def, state, rule, after)) {
            run(def, state, rule.do, now, fired, budget, { ...after, rule: index });
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
      for (const [id, end] of due) {
        const timer = def.timers.find((t) => t.id === id);
        // Repeating timers go again (keeping the beat, unless far behind).
        state.timers[id] = timer?.repeat ? Math.max(end + timer.secs * 1000, now - 1000 + timer.secs * 1000) : null;
        changed = true;
        def.rules.forEach((rule, index) => {
          const c = {};
          if (rule.when.on === "timer" && rule.when.timer === id && condsMet(def, state, rule, c)) {
            run(def, state, rule.do, now, fired, budget, { ...c, rule: index });
          }
        });
      }
      if (delays.length) {
        state.waits = state.waits.filter((w) => !delays.includes(w));
        for (const w of delays) run(def, state, w.rest, now, fired, budget, { pressed: w.pressed, rule: w.rule });
        changed = true;
      }
    }
    if (runTouches(def, state, now, fired, budget)) changed = true;
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

  const api = { sanitize, initialState, apply, nextDue, assetsOf, evaluate, TYPES, ASPECTS, SHAPES, SCREEN_KINDS };
  root.CrumbsEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
