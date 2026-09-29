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
    for (const node of [...el.querySelectorAll(".fx-overlay")]) node.remove();
    el.hidden = true;
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

    for (const overlay of effect.overlays || []) {
      const img = document.createElement("img");
      img.className = "fx-overlay";
      img.src = urlFor(overlay.a);
      img.alt = "";
      img.style.left = `${overlay.x}%`;
      img.style.top = `${overlay.y}%`;
      img.style.width = `${overlay.w}vw`;
      el.append(img);
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
  const editorDialog = document.getElementById("fx-dialog");
  const editor = document.getElementById("fx-editor");
  const stage = document.getElementById("fx-stage");
  const fxError = document.getElementById("fx-error");
  let savedRange = null;
  let overlays = [];
  let selectedOverlay = null;
  let audioFile = null;
  let nextOverlayId = 1;

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

  function saveRange() {
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  }

  document.addEventListener("selectionchange", () => {
    if (editorDialog.open) saveRange();
  });

  function restoreRange() {
    if (!savedRange) return null;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return savedRange;
  }

  function styleEditorSpan(span) {
    const d = span.dataset;
    span.style.cssText = "";
    span.className = "";
    if (d.b) span.style.fontWeight = "700";
    if (d.i) span.style.fontStyle = "italic";
    const deco = [d.u && "underline", d.s && "line-through"].filter(Boolean).join(" ");
    if (deco) span.style.textDecoration = deco;
    if (d.sz) span.style.fontSize = `${d.sz}px`;
    if (d.c) span.style.color = d.c;
    if (d.g) {
      span.classList.add("fx-grad");
      span.style.backgroundImage = `linear-gradient(90deg, ${d.g})`;
    }
    if (d.rb) span.classList.add("fx-rainbow");
    if (d.w) span.classList.add("ed-wiggle");
    if (d.sh) span.classList.add("ed-shake");
    if (d.gl) span.classList.add("fx-glow");
  }

  function applyStyle(attrs) {
    const range = restoreRange();
    if (!range || range.collapsed || !editor.contains(range.commonAncestorContainer)) {
      showError(fxError, "Select some text in the box first.");
      return;
    }
    showError(fxError, "");
    const span = document.createElement("span");
    for (const [key, value] of Object.entries(attrs)) span.dataset[key] = value;
    span.append(range.extractContents());
    range.insertNode(span);
    styleEditorSpan(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    const after = document.createRange();
    after.selectNodeContents(span);
    sel.addRange(after);
    savedRange = after.cloneRange();
    editor.focus();
  }

  function insertAtCaret(node) {
    let range = restoreRange();
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
  }

  // Editor DOM → spans. Inner styles win; "clear" resets everything.
  function serialize() {
    const spans = [];
    const push = (text, style) => {
      if (!text) return;
      const last = spans[spans.length - 1];
      const clean = {};
      for (const [k, v] of Object.entries(style)) if (v !== undefined && v !== null && v !== false) clean[k] = v;
      if (last && !last.e && JSON.stringify({ ...last, t: "" }) === JSON.stringify({ ...clean, t: "" })) {
        last.t += text;
      } else {
        spans.push({ t: text, ...clean });
      }
    };
    const walk = (node, style) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          push(child.nodeValue.replace(/ /g, " "), style);
        } else if (child.nodeName === "BR") {
          push("\n", style);
        } else if (child.nodeName === "IMG" && child.dataset.emojiFile) {
          spans.push({ e: { f: child.dataset.emojiFile, n: child.dataset.emojiName } });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const d = child.dataset || {};
          let next = { ...style };
          if (d.clear) next = {};
          if (d.b) next.b = 1;
          if (d.i) next.i = 1;
          if (d.u) next.u = 1;
          if (d.s) next.s = 1;
          if (d.w) next.w = 1;
          if (d.sh) next.sh = 1;
          if (d.gl) next.gl = 1;
          if (d.sz) next.sz = Number(d.sz);
          if (d.c) {
            next.c = d.c;
            delete next.g;
            delete next.rb;
          }
          if (d.g) {
            next.g = d.g.split(",");
            delete next.c;
            delete next.rb;
          }
          if (d.rb) {
            next.rb = 1;
            delete next.c;
            delete next.g;
          }
          const block = child.nodeName === "DIV" || child.nodeName === "P";
          if (block && spans.length) push("\n", {});
          walk(child, next);
        }
      }
    };
    walk(editor, {});
    // trim trailing newlines
    while (spans.length && !spans[spans.length - 1].e && /^\s*$/.test(spans[spans.length - 1].t)) spans.pop();
    return spans;
  }

  function renderStage() {
    for (const node of [...stage.querySelectorAll(".stage-item")]) node.remove();
    stage.querySelector(".stage-hint").hidden = overlays.length > 0;
    for (const item of overlays) {
      const img = document.createElement("img");
      img.className = "stage-item" + (item === selectedOverlay ? " selected" : "");
      img.src = item.url;
      img.alt = "";
      img.draggable = false;
      img.style.left = `${item.x}%`;
      img.style.top = `${item.y}%`;
      img.style.width = `${item.w}%`;
      img.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        selectOverlay(item);
        const box = stage.getBoundingClientRect();
        img.setPointerCapture?.(event.pointerId);
        const move = (ev) => {
          item.x = Math.round(Math.min(100, Math.max(0, ((ev.clientX - box.left) / box.width) * 100)));
          item.y = Math.round(Math.min(100, Math.max(0, ((ev.clientY - box.top) / box.height) * 100)));
          img.style.left = `${item.x}%`;
          img.style.top = `${item.y}%`;
        };
        const up = () => {
          img.removeEventListener("pointermove", move);
          img.removeEventListener("pointerup", up);
          img.removeEventListener("pointercancel", up);
        };
        img.addEventListener("pointermove", move);
        img.addEventListener("pointerup", up);
        img.addEventListener("pointercancel", up);
      });
      stage.append(img);
    }
  }

  function selectOverlay(item) {
    selectedOverlay = item;
    const edit = document.getElementById("fx-overlay-edit");
    edit.hidden = !item;
    if (item) {
      document.getElementById("fx-ov-size").value = item.w;
      document.getElementById("fx-ov-size-val").textContent = `${item.w}% of screen width`;
      document.getElementById("fx-ov-start").value = item.s;
      document.getElementById("fx-ov-end").value = item.e;
    }
    for (const node of stage.querySelectorAll(".stage-item")) node.classList.remove("selected");
    renderStage();
  }

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
    document.getElementById("fx-overlay-edit").hidden = true;
    paintMusicRows();
    renderStage();
    showError(fxError, "");
  }

  function openEditor(initialText = "") {
    if (!activeId) return;
    if (!editor.childNodes.length && initialText) editor.textContent = initialText;
    const ratio = window.innerWidth / Math.max(1, window.innerHeight);
    stage.style.aspectRatio = `${ratio}`;
    renderGradInputs();
    renderStage();
    paintMusicRows();
    showError(fxError, "");
    if (!Emoji.loaded) Emoji.load();
    editorDialog.showModal();
    editor.focus();
  }

  // Build the fx payload. assetUrl: true → local preview URLs, false → indices.
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
        return { a, x: item.x, y: item.y, w: item.w, s: item.s, e: item.e };
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

  document.getElementById("fx-toolbar").addEventListener("mousedown", (event) => {
    // keep the text selection when clicking toolbar buttons
    if (event.target.closest("button")) event.preventDefault();
  });

  document.getElementById("fx-toolbar").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-cmd]");
    if (!button) return;
    const cmd = button.dataset.cmd;
    if (cmd === "c") applyStyle({ c: document.getElementById("fx-color").value });
    else if (cmd === "g") applyStyle({ g: gradColors().join(",") });
    else if (cmd === "clear") applyStyle({ clear: "1" });
    else applyStyle({ [cmd]: "1" });
  });

  document.getElementById("fx-grad-count").addEventListener("change", renderGradInputs);

  document.getElementById("fx-size").addEventListener("change", (event) => {
    const value = event.target.value;
    event.target.value = "";
    if (value) applyStyle({ sz: value });
  });

  document.getElementById("fx-emoji").addEventListener("click", (event) => {
    saveRange();
    openPicker(event.currentTarget, (emoji) => {
      const img = document.createElement("img");
      img.className = "fx-emoji";
      img.src = emoji.url;
      img.alt = `:${emoji.name}:`;
      img.dataset.emojiFile = emoji.fileId;
      img.dataset.emojiName = emoji.name;
      img.contentEditable = "false";
      insertAtCaret(img);
      editor.focus();
    });
  });

  editor.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    insertAtCaret(document.createTextNode(text));
  });

  document.getElementById("fx-overlay-input").addEventListener("change", (event) => {
    for (const file of [...(event.target.files || [])]) {
      if (overlays.length >= 12) break;
      const item = {
        id: nextOverlayId++,
        file,
        url: URL.createObjectURL(file),
        x: 50,
        y: 50,
        w: 30,
        s: 0,
        e: 5,
      };
      overlays.push(item);
      selectedOverlay = item;
    }
    event.target.value = "";
    selectOverlay(selectedOverlay);
  });

  document.getElementById("fx-ov-size").addEventListener("input", (event) => {
    if (!selectedOverlay) return;
    selectedOverlay.w = Number(event.target.value);
    document.getElementById("fx-ov-size-val").textContent = `${selectedOverlay.w}% of screen width`;
    renderStage();
  });

  document.getElementById("fx-ov-start").addEventListener("change", (event) => {
    if (!selectedOverlay) return;
    selectedOverlay.s = Math.min(9.5, Math.max(0, Number(event.target.value) || 0));
    if (selectedOverlay.e <= selectedOverlay.s) selectedOverlay.e = Math.min(10, selectedOverlay.s + 0.5);
    selectOverlay(selectedOverlay);
  });

  document.getElementById("fx-ov-end").addEventListener("change", (event) => {
    if (!selectedOverlay) return;
    selectedOverlay.e = Math.min(10, Math.max(selectedOverlay.s + 0.5, Number(event.target.value) || 0));
    selectOverlay(selectedOverlay);
  });

  document.getElementById("fx-ov-remove").addEventListener("click", () => {
    if (!selectedOverlay) return;
    URL.revokeObjectURL(selectedOverlay.url);
    overlays = overlays.filter((item) => item !== selectedOverlay);
    selectOverlay(overlays[overlays.length - 1] || null);
  });

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
      play(effect, (url) => url);
    } catch (err) {
      showError(fxError, err.message);
    }
  });

  document.getElementById("fx-send").addEventListener("click", async () => {
    showError(fxError, "");
    const button = document.getElementById("fx-send");
    let payload;
    try {
      const spans = serialize();
      const { effect, files } = buildEffect(false);
      payload = { fx: {}, files };
      if (spans.length) payload.fx.spans = spans;
      if (effect) payload.fx.effect = effect;
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
      await sendFx(payload.fx, payload.files, plain);
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
