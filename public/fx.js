// Fancy messages: styled text, custom emojis, screen effects and music.
// Loaded before app.js; everything here only touches app.js globals
// (api, activeId, me, upsertMessage…) from inside functions.

const Fx = (() => {
  const MAX_SECONDS = 10;
  const SEEN_KEY = "lc-fx-seen";

  // ---------- small helpers ----------
  function hexToRgb(hex) {
    const n = hex.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  }

  function lerpColor(stops, t) {
    if (stops.length === 1) return stops[0];
    const scaled = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
    const i = Math.floor(scaled);
    const f = scaled - i;
    const a = hexToRgb(stops[i]);
    const b = hexToRgb(stops[i + 1]);
    const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
  }

  function parseTime(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
    const parts = text.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((total, n) => total * 60 + n, 0);
  }

  function formatTime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    const secText = Number.isInteger(rest) ? String(rest).padStart(2, "0") : rest.toFixed(1).padStart(4, "0");
    return `${m}:${secText}`;
  }

  function youtubeInfo(url) {
    const text = String(url || "").trim();
    let id = null;
    let start = null;
    try {
      const u = new URL(text.startsWith("http") ? text : `https://${text}`);
      if (u.hostname.includes("youtu.be")) id = u.pathname.slice(1, 12);
      else if (u.searchParams.get("v")) id = u.searchParams.get("v");
      else {
        const m = u.pathname.match(/\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
        if (m) id = m[2];
      }
      const t = u.searchParams.get("t") || u.searchParams.get("start");
      if (t) {
        const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
        if (m) start = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
      }
    } catch {
      id = null;
    }
    if (!id && /^[A-Za-z0-9_-]{11}$/.test(text)) id = text;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { id, start } : null;
  }

  function loadSeen() {
    try {
      return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }

  function saveSeen(set) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-600)));
    } catch {
      // storage unavailable: effects may replay, which is fine
    }
  }

  // ---------- emojis ----------
  const Emoji = {
    packs: [],
    byName: new Map(),
    loaded: false,
    async load() {
      try {
        const data = await api("/api/emojis");
        this.packs = data.packs;
      } catch {
        this.packs = [];
      }
      this.byName = new Map();
      for (const pack of this.packs) {
        for (const emoji of pack.emojis) {
          const key = emoji.name.toLowerCase();
          if (!this.byName.has(key)) this.byName.set(key, emoji);
        }
      }
      this.loaded = true;
    },
  };

  function emojiImg(fileId, name) {
    const img = document.createElement("img");
    img.className = "fx-emoji";
    img.src = `/api/emoji-files/${fileId}`;
    img.alt = `:${name}:`;
    img.title = `:${name}:`;
    img.draggable = false;
    img.addEventListener("error", () => img.replaceWith(document.createTextNode(`:${name}:`)));
    return img;
  }

  // Plain text with :name: tokens → spans (null if no known emoji is used).
  function textToFx(text) {
    if (!Emoji.byName.size || !text.includes(":")) return null;
    const spans = [];
    let last = 0;
    let used = false;
    for (const match of text.matchAll(/:([A-Za-z0-9_]{1,32}):/g)) {
      const emoji = Emoji.byName.get(match[1].toLowerCase());
      if (!emoji) continue;
      if (match.index > last) spans.push({ t: text.slice(last, match.index) });
      spans.push({ e: { f: emoji.fileId, n: emoji.name } });
      last = match.index + match[0].length;
      used = true;
    }
    if (!used) return null;
    if (last < text.length) spans.push({ t: text.slice(last) });
    return { spans };
  }

  // ---------- rendering styled text ----------
  function renderSpans(el, spans, query = "") {
    el.replaceChildren();
    el.classList.add("fx-text");
    let lastSize = null;
    for (const span of spans) {
      if (span.e) {
        const img = emojiImg(span.e.f, span.e.n);
        if (lastSize) img.style.fontSize = `${lastSize}px`;
        el.append(img);
        continue;
      }
      const node = document.createElement("span");
      if (span.b) node.style.fontWeight = "700";
      if (span.i) node.style.fontStyle = "italic";
      const deco = [span.u && "underline", span.s && "line-through"].filter(Boolean).join(" ");
      if (deco) node.style.textDecoration = deco;
      if (span.sz) node.style.fontSize = `${span.sz}px`;
      lastSize = span.sz || null;
      if (span.gl) node.classList.add("fx-glow");
      const perChar = span.w || span.sh;
      if (perChar) {
        const chars = [...span.t];
        const visible = chars.filter((c) => c.trim()).length || 1;
        let index = 0;
        for (const ch of chars) {
          if (!ch.trim()) {
            node.append(ch);
            continue;
          }
          const c = document.createElement("span");
          c.className = "fx-ch" + (span.w ? " fx-wiggle" : "") + (span.sh ? " fx-shake" : "");
          c.textContent = ch;
          c.style.animationDelay = span.w
            ? `${-(index * 0.09).toFixed(2)}s`
            : `${-(Math.random() * 0.3).toFixed(2)}s`;
          if (span.c) c.style.color = span.c;
          else if (span.g) c.style.color = lerpColor(span.g, index / Math.max(1, visible - 1));
          else if (span.rb) {
            c.classList.add("fx-rainbow-ch");
            if (!span.w) c.style.animationDelay = `${-(index * 0.12).toFixed(2)}s`;
          }
          node.append(c);
          index += 1;
        }
      } else {
        if (span.c) node.style.color = span.c;
        else if (span.g) {
          node.classList.add("fx-grad");
          node.style.backgroundImage = `linear-gradient(90deg, ${span.g.join(", ")})`;
        } else if (span.rb) node.classList.add("fx-rainbow");
        renderRichText(node, span.t, query);
      }
      el.append(node);
    }
  }

  // ---------- playing screen effects ----------
  const layer = () => document.getElementById("fx-layer");
  let playing = null;
  let ytApi = null;

  function loadYouTubeApi() {
    if (ytApi) return ytApi;
    ytApi = new Promise((resolve, reject) => {
      if (window.YT?.Player) {
        resolve(window.YT);
        return;
      }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        ytApi = null;
        reject(new Error("YouTube didn't load"));
      };
      document.head.append(script);
    });
    return ytApi;
  }

  function stop() {
    if (!playing) return;
    const current = playing;
    playing = null;
    for (const timer of current.timers) clearTimeout(timer);
    current.cleanup.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore
      }
    });
    const el = layer();
    el.classList.remove("show");
    for (const node of [...el.querySelectorAll(".fx-frame")]) node.remove();
    el.hidden = true;
  }

  // Effects are laid out inside a phone-shaped area in the middle of the
  // screen, so what the sender places is visible on phones too.
  function frameRect() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(vw, vh * 0.5);
    return { left: (vw - width) / 2, top: 0, width, height: vh };
  }

  function makeFrame() {
    const rect = frameRect();
    const frame = document.createElement("div");
    frame.className = "fx-frame";
    frame.style.left = `${rect.left}px`;
    frame.style.top = `${rect.top}px`;
    frame.style.width = `${rect.width}px`;
    frame.style.height = `${rect.height}px`;
    return frame;
  }

  function placeOverlay(node, overlay) {
    node.style.left = `${overlay.x}%`;
    node.style.top = `${overlay.y}%`;
    node.style.width = `${overlay.w}%`;
    node.style.setProperty("--rot", `${overlay.r || 0}deg`);
  }

  // effect: { overlays: [{a,x,y,w,s,e}], music: {a|yt, s, e, v} }
  // urlFor(assetId) gives the image/audio URL.
  function play(effect, urlFor) {
    stop();
    if (!effect) return;
    const el = layer();
    const state = { timers: [], cleanup: [] };
    playing = state;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    let total = 0;
    const frame = makeFrame();
    el.append(frame);

    for (const overlay of effect.overlays || []) {
      const img = document.createElement("img");
      img.className = "fx-overlay";
      img.src = urlFor(overlay.a);
      img.alt = "";
      placeOverlay(img, overlay);
      frame.append(img);
      const start = Math.max(0, overlay.s || 0) * 1000;
      const end = Math.min(MAX_SECONDS, overlay.e || MAX_SECONDS) * 1000;
      total = Math.max(total, end);
      state.timers.push(setTimeout(() => img.classList.add("on"), start));
      state.timers.push(setTimeout(() => img.classList.remove("on"), Math.max(start, end - 400)));
    }

    const music = effect.music;
    if (music) {
      const length = Math.min(MAX_SECONDS, Math.max(0.5, music.e - music.s)) * 1000;
      total = Math.max(total, length);
      const volume = music.v ?? 0.8;
      if (music.yt) {
        const holder = document.createElement("div");
        holder.className = "fx-yt";
        const target = document.createElement("div");
        holder.append(target);
        document.body.append(holder);
        let player = null;
        state.cleanup.push(() => {
          try {
            player?.destroy();
          } catch {
            // ignore
          }
          holder.remove();
        });
        loadYouTubeApi()
          .then((YT) => {
            if (playing !== state) return;
            player = new YT.Player(target, {
              width: 200,
              height: 113,
              videoId: music.yt,
              playerVars: {
                autoplay: 1,
                controls: 0,
                start: Math.floor(music.s),
                end: Math.ceil(music.e),
                playsinline: 1,
              },
              events: {
                onReady: (event) => {
                  event.target.setVolume(Math.round(volume * 100));
                  event.target.seekTo(music.s, true);
                  event.target.playVideo();
                },
              },
            });
          })
          .catch(() => {});
      } else if (music.a) {
        const audio = new Audio(urlFor(music.a));
        audio.volume = volume;
        audio.preload = "auto";
        const begin = () => {
          try {
            audio.currentTime = music.s || 0;
          } catch {
            // ignore
          }
          audio.play().catch(() => {});
        };
        if (audio.readyState >= 1) begin();
        else audio.addEventListener("loadedmetadata", begin, { once: true });
        state.cleanup.push(() => {
          audio.pause();
          audio.src = "";
        });
      }
    }

    total = Math.min(MAX_SECONDS * 1000, Math.max(total, 500));
    state.timers.push(setTimeout(() => el.classList.remove("show"), total - 300));
    state.timers.push(setTimeout(() => {
      if (playing === state) stop();
    }, total));
  }

  function playMessage(message) {
    const effect = message.fx?.effect;
    if (!effect) return;
    play(effect, (id) => `/api/attachments/${id}`);
  }

  // Plays the newest unseen effect someone else sent (one at a time, so
  // nobody gets bombarded), and marks everything as seen.
  function autoplay(messages) {
    const seen = loadSeen();
    let target = null;
    let changed = false;
    for (const message of messages) {
      if (!message.fx?.effect || seen.has(message.id)) continue;
      seen.add(message.id);
      changed = true;
      if (!message.mine && !message.blocked) target = message;
    }
    if (changed) saveSeen(seen);
    if (target) playMessage(target);
  }

  function markSeen(id) {
    const seen = loadSeen();
    seen.add(id);
    saveSeen(seen);
  }

  // ---------- shared emoji pack card ----------
  function renderPackCard(pack) {
    const card = document.createElement("div");
    card.className = "pack-card";
    const title = document.createElement("div");
    title.className = "pack-card-title";
    title.textContent = `Emoji pack: ${pack.name}`;
    const grid = document.createElement("div");
    grid.className = "pack-card-grid";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn primary small";
    button.textContent = "Add to my emojis";
    card.append(title, grid, button);
    api(`/api/emoji-packs/${pack.id}`)
      .then((data) => {
        for (const emoji of data.pack.emojis.slice(0, 24)) {
          grid.append(emojiImg(emoji.fileId, emoji.name));
        }
        if (data.pack.emojis.length > 24) {
          const more = document.createElement("span");
          more.textContent = `+${data.pack.emojis.length - 24}`;
          grid.append(more);
        }
        if (data.mine) {
          button.textContent = "This is your pack";
          button.disabled = true;
        }
      })
      .catch(() => {
        grid.textContent = "This pack was deleted.";
        button.disabled = true;
      });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/emoji-packs/${pack.id}/copy`, { method: "POST" });
        await Emoji.load();
        button.textContent = "Added ✓";
      } catch (err) {
        button.textContent = err.message;
      }
    });
    return card;
  }

  // ---------- emoji picker ----------
  let pickerCallback = null;

  function openPicker(anchor, onPick) {
    const picker = document.getElementById("emoji-picker");
    const body = document.getElementById("emoji-picker-body");
    pickerCallback = onPick;
    body.replaceChildren();
    const render = () => {
      body.replaceChildren();
      if (!Emoji.packs.some((pack) => pack.emojis.length)) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = "No emojis yet. Make a pack and upload some.";
        body.append(p);
      }
      for (const pack of Emoji.packs) {
        if (!pack.emojis.length) continue;
        const head = document.createElement("div");
        head.className = "picker-pack";
        head.textContent = pack.name;
        const grid = document.createElement("div");
        grid.className = "picker-grid";
        for (const emoji of pack.emojis) {
          const b = document.createElement("button");
          b.type = "button";
          b.title = `:${emoji.name}:`;
          b.append(emojiImg(emoji.fileId, emoji.name));
          b.addEventListener("mousedown", (event) => event.preventDefault());
          b.addEventListener("click", () => {
            pickerCallback?.(emoji);
          });
          grid.append(b);
        }
        body.append(head, grid);
      }
    };
    render();
    if (!Emoji.loaded) Emoji.load().then(render);
    const host = anchor.closest("dialog") || document.body;
    host.append(picker);
    picker.hidden = false;
    const box = anchor.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    picker.style.width = `${width}px`;
    picker.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    const height = Math.min(320, picker.offsetHeight || 320);
    const above = box.top - height - 6 > 8;
    picker.style.top = `${above ? box.top - height - 6 : Math.min(box.bottom + 6, window.innerHeight - height - 8)}px`;
  }

  function closePicker() {
    const picker = document.getElementById("emoji-picker");
    picker.hidden = true;
    pickerCallback = null;
  }

  document.addEventListener("mousedown", (event) => {
    const picker = document.getElementById("emoji-picker");
    if (picker.hidden) return;
    if (event.target.closest("#emoji-picker, #emoji-btn, #fx-emoji")) return;
    closePicker();
  });

  // ---------- emoji manager ----------
  async function openManager() {
    closePicker();
    await Emoji.load();
    renderManager();
    const dialog = document.getElementById("emoji-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function renderManager() {
    const list = document.getElementById("pack-list");
    const errorEl = document.getElementById("emoji-error");
    list.replaceChildren();
    if (!Emoji.packs.length) {
      const p = document.createElement("p");
      p.textContent = "No packs yet. Create one above.";
      list.append(p);
    }
    for (const pack of Emoji.packs) {
      const box = document.createElement("section");
      box.className = "pack";
      const head = document.createElement("div");
      head.className = "pack-head";
      const name = document.createElement("input");
      name.value = pack.name;
      name.maxLength = 40;
      name.addEventListener("change", async () => {
        try {
          await api(`/api/emoji-packs/${pack.id}`, { method: "PATCH", body: { name: name.value } });
          pack.name = name.value;
        } catch (err) {
          showError(errorEl, err.message);
        }
      });
      const upload = document.createElement("label");
      upload.className = "btn ghost small file-btn";
      upload.textContent = "Upload";
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      upload.append(input);
      input.addEventListener("change", async () => {
        const files = [...(input.files || [])];
        input.value = "";
        if (!files.length) return;
        showError(errorEl, "");
        upload.firstChild.textContent = "Uploading…";
        const form = new FormData();
        for (const file of files) form.append("emojis", file);
        try {
          const data = await api(`/api/emoji-packs/${pack.id}/emojis`, { method: "POST", body: form });
          if (data.errors?.length) showError(errorEl, data.errors.join(" "));
        } catch (err) {
          showError(errorEl, err.message);
        }
        await Emoji.load();
        renderManager();
      });
      const share = document.createElement("button");
      share.type = "button";
      share.className = "btn ghost small";
      share.textContent = "Send to this chat";
      share.disabled = !activeId || !pack.emojis.length;
      share.title = activeId ? "Share this pack in the open chat" : "Open a chat first";
      share.addEventListener("click", async () => {
        try {
          await sendFx({ pack: { id: pack.id, name: pack.name } }, []);
          share.textContent = "Sent ✓";
          share.disabled = true;
        } catch (err) {
          showError(errorEl, err.message);
        }
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn ghost small danger";
      del.textContent = "Delete pack";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete the pack "${pack.name}" and its emojis?`)) return;
        await api(`/api/emoji-packs/${pack.id}`, { method: "DELETE" });
        await Emoji.load();
        renderManager();
      });
      head.append(name, upload, share, del);
      const grid = document.createElement("div");
      grid.className = "manage-grid";
      if (!pack.emojis.length) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = "Empty. Upload PNGs or GIFs.";
        grid.append(p);
      }
      for (const emoji of pack.emojis) {
        const cell = document.createElement("div");
        cell.className = "manage-emoji";
        const img = emojiImg(emoji.fileId, emoji.name);
        const label = document.createElement("input");
        label.value = emoji.name;
        label.maxLength = 32;
        label.title = "Rename (letters, numbers, _)";
        label.addEventListener("change", async () => {
          try {
            await api(`/api/emojis/${emoji.id}`, { method: "PATCH", body: { name: label.value.trim() } });
            await Emoji.load();
          } catch (err) {
            label.value = emoji.name;
            showError(errorEl, err.message);
          }
        });
        const x = document.createElement("button");
        x.type = "button";
        x.className = "manage-x";
        x.title = "Delete emoji";
        x.textContent = "×";
        x.addEventListener("click", async () => {
          await api(`/api/emojis/${emoji.id}`, { method: "DELETE" });
          await Emoji.load();
          renderManager();
        });
        cell.append(img, label, x);
        grid.append(cell);
      }
      box.append(head, grid);
      list.append(box);
    }
  }

  document.getElementById("new-pack").addEventListener("click", async () => {
    const input = document.getElementById("new-pack-name");
    try {
      await api("/api/emoji-packs", { method: "POST", body: { name: input.value.trim() || "My emojis" } });
      input.value = "";
      await Emoji.load();
      renderManager();
    } catch (err) {
      showError(document.getElementById("emoji-error"), err.message);
    }
  });

  document.getElementById("emoji-manage").addEventListener("click", openManager);

  // ---------- sending ----------
  async function sendFx(fx, fxFiles, body = "") {
    if (!activeId) throw new Error("Open a chat first.");
    const form = new FormData();
    form.append("body", body);
    form.append("fx", JSON.stringify(fx));
    for (const file of fxFiles) form.append("fxfiles", file);
    const message = await api(`/api/conversations/${activeId}/messages`, { method: "POST", body: form });
    markSeen(message.id);
    if (typeof isFiltering === "function" && isFiltering()) clearFilter();
    stickToBottom = true;
    upsertMessage(message);
    refreshConversations();
    return message;
  }

  // ---------- the editor ----------
  // The text box is driven by a simple model: a list of characters, each with
  // its own style. Styles are applied to the model and the box is redrawn as
  // flat spans (never nested), which keeps Clear style / colors predictable.
  const editorDialog = document.getElementById("fx-dialog");
  const editor = document.getElementById("fx-editor");
  const fxError = document.getElementById("fx-error");
  const STYLE_KEYS = ["b", "i", "u", "s", "c", "g", "rb", "w", "sh", "gl", "sz"];
  let savedRange = null;
  let pending = null; // style for the next thing typed at a collapsed caret
  let overlays = [];
  let selectedOverlay = null;
  let audioFile = null;
  let nextOverlayId = 1;

  function cleanStyle(st) {
    const out = {};
    for (const key of STYLE_KEYS) {
      const value = st?.[key];
      if (value === undefined || value === null || value === false || value === "") continue;
      out[key] = value;
    }
    if (out.c) {
      delete out.g;
      delete out.rb;
    } else if (out.g) delete out.rb;
    return out;
  }

  const styleKey = (st) => JSON.stringify(cleanStyle(st));

  function gradColors() {
    return [...document.querySelectorAll("#fx-grad-colors input")].map((input) => input.value);
  }

  function renderGradInputs() {
    const wrap = document.getElementById("fx-grad-colors");
    const count = Number(document.getElementById("fx-grad-count").value);
    const current = gradColors();
    const defaults = ["#ff5f6d", "#ffc371", "#47e5bc", "#4d9dff", "#b15eff", "#ff5fd2"];
    wrap.replaceChildren();
    for (let i = 0; i < count; i += 1) {
      const input = document.createElement("input");
      input.type = "color";
      input.value = current[i] || defaults[i];
      wrap.append(input);
    }
  }

  // ----- model <-> DOM -----
  const ZWSP = String.fromCharCode(0x200b);
  const NBSP = String.fromCharCode(0xa0);
  const cleanText = (text) => text.split(ZWSP).join("").split(NBSP).join(" ");

  function readModel(root = editor) {
    const out = [];
    const walk = (node, st) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          // Loose text next to a styled span (from phone keyboards) takes its style.
          let textStyle = st;
          if (node === editor && child.previousSibling?.dataset?.st) {
            try {
              textStyle = JSON.parse(child.previousSibling.dataset.st);
            } catch {
              textStyle = st;
            }
          }
          for (const ch of cleanText(child.nodeValue)) {
            out.push({ t: ch, st: textStyle });
          }
        } else if (child.nodeName === "BR") {
          if (!child.dataset?.sentinel) out.push({ t: "\n", st });
        } else if (child.nodeName === "IMG") {
          if (child.dataset?.emojiFile) {
            out.push({ e: { f: child.dataset.emojiFile, n: child.dataset.emojiName }, st: {} });
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          let next = st;
          if (child.dataset?.st) {
            try {
              next = JSON.parse(child.dataset.st);
            } catch {
              next = st;
            }
          }
          const block = child.nodeName === "DIV" || child.nodeName === "P";
          if (block && out.length && out[out.length - 1].t !== "\n") out.push({ t: "\n", st });
          walk(child, next);
        }
      }
    };
    walk(root, {});
    return out;
  }

  function styleEditorSpan(span, st) {
    span.style.cssText = "";
    span.className = "";
    if (st.b) span.style.fontWeight = "700";
    if (st.i) span.style.fontStyle = "italic";
    const deco = [st.u && "underline", st.s && "line-through"].filter(Boolean).join(" ");
    if (deco) span.style.textDecoration = deco;
    if (st.sz) span.style.fontSize = `${st.sz}px`;
    if (st.c) span.style.color = st.c;
    else if (st.g) {
      span.classList.add("fx-grad");
      span.style.backgroundImage = `linear-gradient(90deg, ${st.g.join(", ")})`;
    } else if (st.rb) span.classList.add("fx-rainbow");
    if (st.w) span.classList.add("ed-wiggle");
    if (st.sh) span.classList.add("ed-shake");
    if (st.gl) span.classList.add("fx-glow");
  }

  function emojiNode(e) {
    const img = document.createElement("img");
    img.className = "fx-emoji";
    img.src = `/api/emoji-files/${e.f}`;
    img.alt = `:${e.n}:`;
    img.dataset.emojiFile = e.f;
    img.dataset.emojiName = e.n;
    img.contentEditable = "false";
    return img;
  }

  function renderModel(model) {
    editor.replaceChildren();
    let run = null;
    const flush = () => {
      if (!run) return;
      const span = document.createElement("span");
      span.dataset.st = JSON.stringify(run.st);
      span.textContent = run.text;
      styleEditorSpan(span, run.st);
      editor.append(span);
      run = null;
    };
    for (const item of model) {
      if (item.e) {
        flush();
        editor.append(emojiNode(item.e));
        continue;
      }
      const st = cleanStyle(item.st);
      // Moving text is drawn per line so wiggle/shake never swallow line breaks.
      if (run && styleKey(run.st) === styleKey(st) && item.t !== "\n" && !run.text.endsWith("\n")) {
        run.text += item.t;
      } else {
        flush();
        run = { st, text: item.t };
      }
    }
    flush();
    if (model.length && model[model.length - 1].t === "\n") {
      const br = document.createElement("br");
      br.dataset.sentinel = "1";
      editor.append(br);
    }
  }

  function countBefore(container, offset) {
    const range = document.createRange();
    range.setStart(editor, 0);
    try {
      range.setEnd(container, offset);
    } catch {
      return 0;
    }
    const holder = document.createElement("div");
    holder.append(range.cloneContents());
    return readModel(holder).length;
  }

  function currentOffsets() {
    const sel = window.getSelection();
    let range = null;
    if (sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      range = sel.getRangeAt(0);
    } else if (savedRange) range = savedRange;
    if (!range) {
      const end = readModel().length;
      return { start: end, end };
    }
    const a = countBefore(range.startContainer, range.startOffset);
    const b = countBefore(range.endContainer, range.endOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  function pointAt(index) {
    let remaining = index;
    for (const node of editor.childNodes) {
      if (node.nodeName === "BR" && node.dataset?.sentinel) continue;
      const len = node.nodeName === "IMG" ? 1 : (node.textContent || "").length;
      if (remaining <= len) {
        if (node.nodeName === "IMG") {
          return remaining === 0 ? { before: node } : { after: node };
        }
        const text = node.firstChild || node;
        return { node: text, offset: remaining };
      }
      remaining -= len;
    }
    return { end: true };
  }

  function setSelection(start, end = start) {
    const range = document.createRange();
    const place = (point, setter) => {
      if (point.node) range[setter](point.node, point.offset);
      else if (point.before) range[setter === "setStart" ? "setStartBefore" : "setEndBefore"](point.before);
      else if (point.after) range[setter === "setStart" ? "setStartAfter" : "setEndAfter"](point.after);
      else {
        range[setter](editor, editor.childNodes.length);
      }
    };
    place(pointAt(start), "setStart");
    place(pointAt(end), "setEnd");
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
  }

  function styleAt(model, index) {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (!model[i].e) return cleanStyle(model[i].st);
    }
    return {};
  }

  // change(style, allHaveIt) -> new style
  function applyStyle(change, toggleKey = null) {
    showError(fxError, "");
    const { start, end } = currentOffsets();
    const model = readModel();
    if (start === end) {
      // Nothing selected: this becomes the style for what you type next.
      const base = pending || styleAt(model, start);
      const has = toggleKey ? Boolean(base[toggleKey]) : false;
      pending = cleanStyle(change({ ...base }, has));
      paintPending();
      editor.focus();
      setSelection(start);
      return;
    }
    const chosen = model.slice(start, end).filter((item) => !item.e && item.t !== "\n");
    const allHave = toggleKey ? chosen.length > 0 && chosen.every((item) => item.st?.[toggleKey]) : false;
    for (let i = start; i < end; i += 1) {
      if (model[i].e) continue;
      model[i] = { t: model[i].t, st: cleanStyle(change({ ...cleanStyle(model[i].st) }, allHave)) };
    }
    pending = null;
    paintPending();
    renderModel(model);
    editor.focus();
    setSelection(start, end);
  }

  function paintPending() {
    const note = document.getElementById("fx-pending");
    if (!note) return;
    if (!pending) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    note.replaceChildren();
    const sample = document.createElement("span");
    sample.textContent = Object.keys(pending).length ? "Next text will look like this" : "Next text will be plain";
    styleEditorSpan(sample, pending);
    note.append(sample);
  }

  function insertItems(items) {
    const { start, end } = currentOffsets();
    const model = readModel();
    model.splice(start, end - start, ...items);
    renderModel(model);
    editor.focus();
    setSelection(start + items.length);
  }

  function insertText(text) {
    const { start } = currentOffsets();
    const model = readModel();
    const st = pending || styleAt(model, start);
    pending = null;
    paintPending();
    insertItems([...text].map((ch) => ({ t: ch, st: { ...st } })));
  }

  editor.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
      insertText("\n");
    } else if (event.inputType === "insertText" && event.data) {
      // We place typed text ourselves so it always gets the right style.
      event.preventDefault();
      insertText(event.data);
    }
  });

  editor.addEventListener("compositionstart", () => {
    editor.dataset.composing = "1";
  });
  editor.addEventListener("compositionend", () => {
    delete editor.dataset.composing;
    const { start, end } = currentOffsets();
    renderModel(readModel());
    setSelection(start, end);
  });

  editor.addEventListener("paste", (event) => {
    event.preventDefault();
    insertText(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
  });

  // Chrome sometimes wraps typed text in its own <font>/<div> tags; tidy up
  // after each edit so the box always matches what will be sent.
  editor.addEventListener("input", () => {
    const stray =
      editor.querySelector("font, div, p, b, i, u, strike, span:not([data-st])") ||
      [...editor.childNodes].some((node) => node.nodeType === Node.TEXT_NODE);
    if (!stray || editor.dataset.composing) return;
    const { start, end } = currentOffsets();
    renderModel(readModel());
    setSelection(start, end);
  });

  function saveRange() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0).cloneRange();
    if (savedRange && pending) {
      // moving the caret somewhere else drops a pending style
      const same =
        range.collapsed &&
        savedRange.collapsed &&
        range.startContainer === savedRange.startContainer &&
        range.startOffset === savedRange.startOffset;
      if (!same) {
        pending = null;
        paintPending();
      }
    }
    savedRange = range;
  }

  document.addEventListener("selectionchange", () => {
    if (editorDialog.open) saveRange();
  });

  function serialize() {
    const spans = [];
    for (const item of readModel()) {
      if (item.e) {
        spans.push({ e: item.e });
        continue;
      }
      const st = cleanStyle(item.st);
      const last = spans[spans.length - 1];
      if (last && !last.e && styleKey(last) === styleKey(st)) last.t += item.t;
      else spans.push({ t: item.t, ...st });
    }
    while (spans.length && !spans[spans.length - 1].e && !spans[spans.length - 1].t.trim()) spans.pop();
    while (spans.length && !spans[0].e && !spans[0].t.trim()) spans.shift();
    return spans;
  }

  const toggle = (key) => (st, allHave) => {
    if (allHave) delete st[key];
    else st[key] = 1;
    if (key === "rb" && st.rb) {
      delete st.c;
      delete st.g;
    }
    return st;
  };

  document.getElementById("fx-toolbar").addEventListener("mousedown", (event) => {
    // keep the text selection when clicking toolbar buttons
    if (event.target.closest("button")) event.preventDefault();
  });

  document.getElementById("fx-toolbar").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-cmd]");
    if (!button) return;
    const cmd = button.dataset.cmd;
    if (cmd === "c") {
      const color = document.getElementById("fx-color").value;
      applyStyle((st) => ({ ...st, c: color, g: null, rb: null }));
    } else if (cmd === "g") {
      const colors = gradColors();
      applyStyle((st) => ({ ...st, g: colors, c: null, rb: null }));
    } else if (cmd === "clear") {
      applyStyle(() => ({}));
    } else {
      applyStyle(toggle(cmd), cmd);
    }
  });

  // Picking a color applies it straight away, like Google Docs.
  document.getElementById("fx-color").addEventListener("change", (event) => {
    const color = event.target.value;
    applyStyle((st) => ({ ...st, c: color, g: null, rb: null }));
  });

  document.getElementById("fx-grad-count").addEventListener("change", renderGradInputs);

  document.getElementById("fx-size").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    event.target.value = "";
    if (value) applyStyle((st) => ({ ...st, sz: value === 16 ? null : value }));
  });

  document.getElementById("fx-emoji").addEventListener("click", (event) => {
    saveRange();
    openPicker(event.currentTarget, (emoji) => {
      insertItems([{ e: { f: emoji.fileId, n: emoji.name }, st: {} }]);
    });
  });

  // ----- screen overlays: placed on the real screen -----
  function renderOverlayThumbs() {
    const list = document.getElementById("fx-overlay-list");
    list.replaceChildren();
    for (const item of overlays) {
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = "";
      img.title = `${item.s}s to ${item.e}s`;
      list.append(img);
    }
    document.getElementById("fx-place").hidden = !overlays.length;
    document.getElementById("fx-overlay-empty").hidden = overlays.length > 0;
  }

  let placer = null;

  function openPlacer() {
    stop();
    editorDialog.close();
    const el = layer();
    el.hidden = false;
    el.classList.add("show", "placing");
    const frame = makeFrame();
    frame.classList.add("placing-frame");
    const label = document.createElement("div");
    label.className = "frame-label";
    label.textContent = "Phone screen: everything here is visible on every device";
    frame.append(label);
    el.append(frame);

    const bar = document.createElement("div");
    bar.className = "place-bar";
    bar.innerHTML = `
      <label class="btn ghost small file-btn">Add image / GIF<input type="file" accept="image/*" multiple hidden></label>
      <span class="place-times">Show <input type="number" min="0" max="9.5" step="0.5" data-t="s">s → <input type="number" min="0.5" max="10" step="0.5" data-t="e">s</span>
      <button type="button" class="btn ghost small" data-act="remove">Remove</button>
      <button type="button" class="btn ghost small" data-act="preview">▶ Preview</button>
      <button type="button" class="btn primary small" data-act="done">Done</button>`;
    el.append(bar);
    placer = { frame, bar };

    bar.querySelector('input[type="file"]').addEventListener("change", (event) => {
      addOverlayFiles([...(event.target.files || [])]);
      event.target.value = "";
      drawPlaced();
    });
    for (const input of bar.querySelectorAll("input[data-t]")) {
      input.addEventListener("change", () => {
        if (!selectedOverlay) return;
        const s = Math.min(9.5, Math.max(0, Number(bar.querySelector('[data-t="s"]').value) || 0));
        let e = Math.min(10, Math.max(0.5, Number(bar.querySelector('[data-t="e"]').value) || 10));
        if (e <= s) e = Math.min(10, s + 0.5);
        selectedOverlay.s = s;
        selectedOverlay.e = e;
        paintTimes();
      });
    }
    bar.addEventListener("click", (event) => {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (act === "remove" && selectedOverlay) {
        URL.revokeObjectURL(selectedOverlay.url);
        overlays = overlays.filter((item) => item !== selectedOverlay);
        selectedOverlay = overlays[overlays.length - 1] || null;
        drawPlaced();
      } else if (act === "preview") {
        closePlacer(false);
        try {
          const { effect } = buildEffect(true);
          if (effect) play(effect, (url) => url);
          const wait = setInterval(() => {
            if (!playing) {
              clearInterval(wait);
              openPlacer();
            }
          }, 200);
        } catch (err) {
          openPlacer();
        }
      } else if (act === "done") {
        closePlacer(true);
      }
    });
    drawPlaced();
  }

  function paintTimes() {
    if (!placer) return;
    const times = placer.bar.querySelector(".place-times");
    times.style.visibility = selectedOverlay ? "visible" : "hidden";
    if (selectedOverlay) {
      times.querySelector('[data-t="s"]').value = selectedOverlay.s;
      times.querySelector('[data-t="e"]').value = selectedOverlay.e;
    }
    placer.bar.querySelector('[data-act="remove"]').disabled = !selectedOverlay;
  }

  function drawPlaced() {
    if (!placer) return;
    const { frame } = placer;
    for (const node of [...frame.querySelectorAll(".place-item")]) node.remove();
    for (const item of overlays) {
      const box = document.createElement("div");
      box.className = "place-item" + (item === selectedOverlay ? " selected" : "");
      placeOverlay(box, item);
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = "";
      img.draggable = false;
      const rot = document.createElement("span");
      rot.className = "h-rotate";
      rot.title = "Drag to rotate";
      const size = document.createElement("span");
      size.className = "h-resize";
      size.title = "Drag to resize";
      box.append(img, rot, size);
      frame.append(box);

      const center = () => {
        const r = frame.getBoundingClientRect();
        return { x: r.left + (item.x / 100) * r.width, y: r.top + (item.y / 100) * r.height, r };
      };
      const drag = (startEvent, onMove) => {
        startEvent.preventDefault();
        startEvent.stopPropagation();
        if (selectedOverlay !== item) {
          selectedOverlay = item;
          for (const node of frame.querySelectorAll(".place-item")) node.classList.remove("selected");
          box.classList.add("selected");
          paintTimes();
        }
        const target = startEvent.currentTarget;
        target.setPointerCapture?.(startEvent.pointerId);
        const move = (ev) => {
          onMove(ev);
          placeOverlay(box, item);
        };
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
      };

      box.addEventListener("pointerdown", (event) => {
        const c = center();
        const offX = event.clientX - c.x;
        const offY = event.clientY - c.y;
        drag(event, (ev) => {
          item.x = Math.round(Math.min(100, Math.max(0, ((ev.clientX - offX - c.r.left) / c.r.width) * 100)) * 10) / 10;
          item.y = Math.round(Math.min(100, Math.max(0, ((ev.clientY - offY - c.r.top) / c.r.height) * 100)) * 10) / 10;
        });
      });
      size.addEventListener("pointerdown", (event) => {
        const c = center();
        const startDist = Math.hypot(event.clientX - c.x, event.clientY - c.y) || 1;
        const startW = item.w;
        drag(event, (ev) => {
          const dist = Math.hypot(ev.clientX - c.x, ev.clientY - c.y);
          item.w = Math.round(Math.min(150, Math.max(4, (startW * dist) / startDist)));
        });
      });
      rot.addEventListener("pointerdown", (event) => {
        const c = center();
        drag(event, (ev) => {
          let angle = (Math.atan2(ev.clientY - c.y, ev.clientX - c.x) * 180) / Math.PI + 90;
          if (angle > 180) angle -= 360;
          if (Math.abs(angle) < 5) angle = 0;
          item.r = Math.round(angle);
        });
      });
    }
    paintTimes();
  }

  function closePlacer(reopen) {
    const el = layer();
    el.classList.remove("placing", "show");
    for (const node of [...el.querySelectorAll(".fx-frame, .place-bar")]) node.remove();
    el.hidden = true;
    placer = null;
    if (reopen) {
      renderOverlayThumbs();
      editorDialog.showModal();
    }
  }

  function addOverlayFiles(files) {
    for (const file of files) {
      if (overlays.length >= 12) break;
      const item = {
        id: nextOverlayId++,
        file,
        url: URL.createObjectURL(file),
        x: 50,
        y: 45,
        w: 60,
        r: 0,
        s: 0,
        e: 5,
      };
      overlays.push(item);
      selectedOverlay = item;
    }
  }

  document.getElementById("fx-overlay-input").addEventListener("change", (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    addOverlayFiles(files);
    openPlacer();
  });

  document.getElementById("fx-place").addEventListener("click", () => {
    if (!selectedOverlay) selectedOverlay = overlays[0] || null;
    openPlacer();
  });

  // ----- music -----
  function musicKind() {
    return document.querySelector('input[name="fx-music"]:checked').value;
  }

  function paintMusicRows() {
    const kind = musicKind();
    document.getElementById("fx-music-file").hidden = kind !== "file";
    document.getElementById("fx-music-yt").hidden = kind !== "yt";
    document.getElementById("fx-music-times").hidden = kind === "none";
  }

  function resetEditor() {
    editor.replaceChildren();
    pending = null;
    paintPending();
    for (const item of overlays) URL.revokeObjectURL(item.url);
    overlays = [];
    selectedOverlay = null;
    audioFile = null;
    document.getElementById("fx-audio-name").textContent = "";
    document.getElementById("fx-yt-url").value = "";
    document.getElementById("fx-music-start").value = "";
    document.getElementById("fx-music-end").value = "";
    document.getElementById("fx-music-vol").value = "0.8";
    document.querySelector('input[name="fx-music"][value="none"]').checked = true;
    paintMusicRows();
    renderOverlayThumbs();
    showError(fxError, "");
  }

  function openEditor(initialText = "") {
    if (!activeId) return;
    if (!editor.childNodes.length && initialText) {
      renderModel([...initialText].map((ch) => ({ t: ch, st: {} })));
    }
    renderGradInputs();
    renderOverlayThumbs();
    paintMusicRows();
    paintPending();
    showError(fxError, "");
    if (!Emoji.loaded) Emoji.load();
    editorDialog.showModal();
    editor.focus();
    setSelection(readModel().length);
  }

  // Build the fx payload. forPreview: local URLs instead of upload indexes.
  function buildEffect(forPreview) {
    const effect = {};
    const files = [];
    if (overlays.length) {
      effect.overlays = overlays.map((item) => {
        let a;
        if (forPreview) a = item.url;
        else {
          a = files.length;
          files.push(item.file);
        }
        return { a, x: item.x, y: item.y, w: item.w, r: item.r, s: item.s, e: item.e };
      });
    }
    const kind = musicKind();
    if (kind !== "none") {
      const start = parseTime(document.getElementById("fx-music-start").value) ?? 0;
      let end = parseTime(document.getElementById("fx-music-end").value);
      if (end === null) end = start + MAX_SECONDS;
      if (end <= start) throw new Error("Music end has to be after the start.");
      if (end - start > MAX_SECONDS + 0.001) throw new Error("Music can be up to 10 seconds long.");
      const v = Number(document.getElementById("fx-music-vol").value);
      if (kind === "yt") {
        const info = youtubeInfo(document.getElementById("fx-yt-url").value);
        if (!info) throw new Error("That doesn't look like a YouTube link.");
        effect.music = { yt: info.id, s: start, e: end, v };
      } else {
        if (!audioFile) throw new Error("Choose an audio file.");
        let a;
        if (forPreview) a = audioFile.url;
        else {
          a = files.length;
          files.push(audioFile.file);
        }
        effect.music = { a, s: start, e: end, v };
      }
    }
    return { effect: effect.overlays || effect.music ? effect : null, files };
  }

  for (const radio of document.querySelectorAll('input[name="fx-music"]')) {
    radio.addEventListener("change", paintMusicRows);
  }

  document.getElementById("fx-audio-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (audioFile) URL.revokeObjectURL(audioFile.url);
    audioFile = { file, url: URL.createObjectURL(file) };
    document.getElementById("fx-audio-name").textContent = file.name;
  });

  document.getElementById("fx-yt-url").addEventListener("change", (event) => {
    const info = youtubeInfo(event.target.value);
    const startInput = document.getElementById("fx-music-start");
    const endInput = document.getElementById("fx-music-end");
    if (info?.start != null && !startInput.value) {
      startInput.value = formatTime(info.start);
      if (!endInput.value) endInput.value = formatTime(info.start + MAX_SECONDS);
    }
  });

  document.getElementById("fx-preview").addEventListener("click", () => {
    showError(fxError, "");
    try {
      const { effect } = buildEffect(true);
      if (!effect) {
        showError(fxError, "Add an image, GIF or music to preview a screen effect.");
        return;
      }
      editorDialog.close();
      play(effect, (url) => url);
      const wait = setInterval(() => {
        if (!playing) {
          clearInterval(wait);
          if (!editorDialog.open) editorDialog.showModal();
        }
      }, 200);
    } catch (err) {
      showError(fxError, err.message);
    }
  });

  document.getElementById("fx-send").addEventListener("click", async () => {
    showError(fxError, "");
    const button = document.getElementById("fx-send");
    try {
      const spans = serialize();
      const { effect, files } = buildEffect(false);
      const fx = {};
      if (spans.length) fx.spans = spans;
      if (effect) fx.effect = effect;
      if (!spans.length && !effect) {
        showError(fxError, "Write something or add an effect first.");
        return;
      }
      const plain = spans.map((span) => (span.e ? `:${span.e.n}:` : span.t)).join("");
      if (plain.length > 2000) {
        showError(fxError, "That's too much text (2000 characters max).");
        return;
      }
      button.disabled = true;
      button.textContent = "Sending…";
      await sendFx(fx, files, plain);
      stop();
      resetEditor();
      editorDialog.close();
      composeInput.value = "";
    } catch (err) {
      showError(fxError, err.message);
    } finally {
      button.disabled = false;
      button.textContent = "Send";
    }
  });

  document.getElementById("fx-close").addEventListener("click", () => {
    stop();
    editorDialog.close();
  });

  document.getElementById("fx-skip").addEventListener("click", stop);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && playing) stop();
  });

  return {
    Emoji,
    textToFx,
    renderSpans,
    renderPackCard,
    play,
    playMessage,
    autoplay,
    markSeen,
    openPicker,
    closePicker,
    openManager,
    openEditor,
    stop,
  };
})();
