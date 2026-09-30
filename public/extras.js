// Extra chat features: message menu, replies, voice messages, audio player,
// drawings, polls, stars, read receipts, typing, scheduling, themes, roulette
// and self-destructing messages. Loaded after app.js and uses its globals.

const Extras = (() => {
  // ---------- small popover menus ----------
  let openMenuEl = null;

  function closeMenus() {
    for (const id of ["plus-menu", "msg-menu", "star-pop"]) $(id).hidden = true;
    openMenuEl = null;
    menuWatcher?.disconnect();
  }

  // Keeps a popup fully on screen, and re-checks whenever its size changes
  // (e.g. the star row fills in after "Loading…").
  let menuAnchor = null;
  const menuWatcher = typeof ResizeObserver === "function" ? new ResizeObserver(() => placeMenu()) : null;

  function placeMenu() {
    const menu = openMenuEl;
    if (!menu || menu.hidden || !menuAnchor) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.visualViewport?.height || window.innerHeight;
    const box = menuAnchor.getBoundingClientRect();
    const width = Math.min(menu.offsetWidth || 240, vw - 16);
    const height = Math.min(menu.offsetHeight || 200, vh - 16);
    const left = Math.max(8, Math.min(box.left, vw - width - 8));
    let top;
    if (box.bottom + 6 + height <= vh - 8) top = box.bottom + 6;
    else if (box.top - height - 6 >= 8) top = box.top - height - 6;
    else top = vh - height - 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  function showMenu(menu, anchor) {
    closeMenus();
    menu.hidden = false;
    openMenuEl = menu;
    menuAnchor = anchor;
    placeMenu();
    menuWatcher?.disconnect();
    menuWatcher?.observe(menu);
  }

  document.addEventListener("mousedown", (event) => {
    if (!openMenuEl) return;
    if (event.target.closest(".pop-menu, #plus-btn, .more-btn")) return;
    closeMenus();
  });
  window.addEventListener("resize", () => placeMenu());
  window.visualViewport?.addEventListener("resize", () => placeMenu());

  // ---------- send options: reply + schedule ----------
  let replyTo = null;
  let scheduleAt = null;

  function applySendOptions(form) {
    if (replyTo) form.append("replyTo", replyTo.id);
    if (scheduleAt) form.append("scheduledFor", scheduleAt.toISOString());
  }

  function clearSendOptions() {
    replyTo = null;
    scheduleAt = null;
    $("reply-bar").hidden = true;
    $("schedule-bar").hidden = true;
  }

  function startReply(message) {
    replyTo = message;
    $("reply-who").textContent = message.mine ? "yourself" : message.username || "them";
    const snippet =
      message.body ||
      (message.fx?.poll ? `📊 ${message.fx.poll.q}` : message.attachments?.[0]?.name || "a message");
    $("reply-snippet").textContent = snippet.length > 80 ? `${snippet.slice(0, 79)}…` : snippet;
    $("reply-bar").hidden = false;
    composeInput.focus();
  }

  $("reply-cancel").addEventListener("click", () => {
    replyTo = null;
    $("reply-bar").hidden = true;
  });

  function renderReply(reply) {
    const quote = document.createElement("button");
    quote.type = "button";
    quote.className = "reply-quote" + (reply.gone ? " gone" : "");
    const who = document.createElement("b");
    who.textContent = reply.username ? `${reply.username}` : "";
    const text = document.createElement("span");
    text.textContent = reply.snippet;
    quote.append(who, text);
    quote.addEventListener("click", (event) => {
      event.stopPropagation();
      if (reply.id) jumpToMessage(reply.id);
    });
    return quote;
  }

  // Schedule dialog
  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }

  function openSchedule() {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setSeconds(0, 0);
    $("schedule-input").value = toLocalInput(scheduleAt || soon);
    $("schedule-input").min = toLocalInput(new Date(Date.now() + 2 * 60 * 1000));
    showError($("schedule-error"), "");
    $("schedule-dialog").showModal();
  }

  $("schedule-set").addEventListener("click", () => {
    const when = new Date($("schedule-input").value);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60 * 1000) {
      showError($("schedule-error"), "Pick a time at least a minute from now.");
      return;
    }
    scheduleAt = when;
    $("schedule-when").textContent = formatTime(when.toISOString());
    $("schedule-bar").hidden = false;
    $("schedule-dialog").close();
  });

  $("schedule-cancel").addEventListener("click", () => {
    scheduleAt = null;
    $("schedule-bar").hidden = true;
  });

  // ---------- "+" menu ----------
  $("plus-btn").addEventListener("click", (event) => {
    const menu = $("plus-menu");
    if (!menu.hidden) {
      closeMenus();
      return;
    }
    for (const el of menu.querySelectorAll(".group-only")) el.hidden = !activeChat?.isGroup;
    showMenu(menu, event.currentTarget);
  });

  $("plus-menu").addEventListener("click", async (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    closeMenus();
    if (act === "file") $("file-input").click();
    else if (act === "poll") openPoll();
    else if (act === "draw") openDraw();
    else if (act === "crumb") Crumbs.openBuilder();
    else if (act === "boom") Fx.openEditorWith({ boom: "crumble" });
    else if (act === "schedule") openSchedule();
    else if (act === "theme") sendTheme();
    else if (act === "roulette") runRoulette();
  });

  // ---------- message "⋯" menu ----------
  function openMessageMenu(anchor, message) {
    const menu = $("msg-menu");
    if (!menu.hidden && menu.dataset.for === message.id) {
      closeMenus();
      return;
    }
    menu.replaceChildren();
    menu.dataset.for = message.id;
    const item = (label, fn, danger = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (danger) b.className = "danger";
      b.addEventListener("click", () => {
        closeMenus();
        fn();
      });
      menu.append(b);
    };
    const special = message.fx?.poll || message.fx?.crumb || message.fx?.roulette || message.fx?.theme || message.fx?.pack;
    if (message.scheduledFor) {
      item("Cancel scheduled message", () => deleteMessage(message, true), true);
    } else if (!message.gone) {
      if (message.canStar ?? !message.mine) item("★ Rate with stars", () => openStars(anchor, message));
      item("↪ Forward", () => openForward(message));
      const tooBig = (message.totalSize || 0) > MAX_PIN_BYTES;
      if (message.pinned) item("📌 Unpin", () => pinMessage(message, false));
      else if (!tooBig) item("📌 Pin (keep past the wipe)", () => pinMessage(message, true));
      if (message.mine && !special) item("✏️ Edit", () => Fx.openEditForMessage(message));
      if (message.mine && !message.forwarded && message.fx?.crumb) item("✏️ Edit crumb", () => Crumbs.openEdit(message));
      if (message.mine) item("🗑 Delete", () => deleteMessage(message, false), true);
    } else if (message.mine) {
      item("🗑 Remove", () => deleteMessage(message, false), true);
    }
    if (!menu.children.length) return;
    showMenu(menu, anchor);
  }

  async function pinMessage(message, pin) {
    try {
      const updated = await api(`/api/messages/${message.id}/${pin ? "pin" : "unpin"}`, { method: "POST" });
      upsertMessage(updated, true);
      refreshPinned();
    } catch (err) {
      showError(composeError, err.message);
    }
  }

  async function deleteMessage(message, scheduled) {
    const question = scheduled
      ? "Cancel this scheduled message? It won't be sent."
      : 'Delete this message? It will show as "Deleted message".';
    if (!confirm(question)) return;
    try {
      const result = await api(`/api/messages/${message.id}`, { method: "DELETE" });
      if (result.removed) {
        messagesEl.querySelector(`[data-id="${message.id}"]`)?.remove();
        activeMessages.delete(message.id);
      } else upsertMessage(result, true);
      refreshConversations();
      refreshPinned();
    } catch (err) {
      showError(composeError, err.message);
    }
  }

  // ---------- stars ----------
  async function openStars(anchor, message) {
    const pop = $("star-pop");
    const row = $("star-row");
    const note = $("star-note");
    row.replaceChildren();
    note.textContent = "Loading…";
    showMenu(pop, anchor);
    let remaining = 0;
    try {
      remaining = (await api("/api/stars/me")).remaining;
    } catch {
      remaining = 0;
    }
    if (message.stars?.mine) {
      note.textContent = `You gave this ${message.stars.mine} ★ already.`;
      return;
    }
    note.textContent = remaining
      ? `You have ${remaining} of 10 stars left today.`
      : "You're out of stars for today. More tomorrow!";
    for (let n = 1; n <= 10; n += 1) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "star";
      b.textContent = "★";
      b.title = `${n} star${n === 1 ? "" : "s"}`;
      b.disabled = n > remaining;
      b.addEventListener("mouseenter", () => {
        for (const [i, s] of [...row.children].entries()) s.classList.toggle("lit", i < n);
      });
      b.addEventListener("click", async () => {
        try {
          const data = await api(`/api/messages/${message.id}/stars`, { method: "POST", body: { stars: n } });
          upsertMessage(data.message, true);
          closeMenus();
        } catch (err) {
          note.textContent = err.message;
        }
      });
      row.append(b);
    }
    row.addEventListener("mouseleave", () => {
      for (const s of row.children) s.classList.remove("lit");
    });
  }

  function onStarsReceived(payload) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = `★ ${payload.from} gave you ${payload.stars} star${payload.stars === 1 ? "" : "s"}!`;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  // ---------- audio player (voice messages + audio files) ----------
  function fmt(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function audioPlayer(url, name) {
    const box = document.createElement("div");
    box.className = "audio-player";
    const audio = new Audio();
    audio.preload = "metadata";
    audio.src = url;
    const play = document.createElement("button");
    play.type = "button";
    play.className = "ap-play";
    play.textContent = "▶";
    play.setAttribute("aria-label", "Play");
    const bar = document.createElement("input");
    bar.type = "range";
    bar.className = "ap-bar";
    bar.min = "0";
    bar.max = "1000";
    bar.value = "0";
    bar.setAttribute("aria-label", "Seek");
    const time = document.createElement("span");
    time.className = "ap-time";
    time.textContent = "0:00";
    const label = document.createElement("div");
    label.className = "ap-name";
    const voice = /^voice message/i.test(name || "");
    label.textContent = voice ? "🎤 Voice message" : name;
    let seeking = false;
    const paint = () => {
      const d = audio.duration;
      if (!seeking && Number.isFinite(d) && d > 0) bar.value = String(Math.round((audio.currentTime / d) * 1000));
      bar.style.setProperty("--pct", `${(Number(bar.value) / 10).toFixed(1)}%`);
      time.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
    };
    audio.addEventListener("loadedmetadata", () => {
      // Recorded webm files report Infinity until scanned; nudge them.
      if (audio.duration === Infinity) {
        audio.currentTime = 1e9;
        audio.addEventListener(
          "timeupdate",
          () => {
            audio.currentTime = 0;
            paint();
          },
          { once: true }
        );
      }
      paint();
    });
    audio.addEventListener("timeupdate", paint);
    audio.addEventListener("play", () => (play.textContent = "❚❚"));
    audio.addEventListener("pause", () => (play.textContent = "▶"));
    audio.addEventListener("ended", () => {
      play.textContent = "▶";
      paint();
    });
    play.addEventListener("click", (event) => {
      event.stopPropagation();
      if (audio.paused) {
        for (const other of document.querySelectorAll(".audio-player")) {
          if (other !== box) other.dispatchEvent(new Event("pause-others"));
        }
        audio.play().catch(() => {});
      } else audio.pause();
    });
    box.addEventListener("pause-others", () => audio.pause());
    bar.addEventListener("input", () => {
      seeking = true;
      const d = audio.duration;
      bar.style.setProperty("--pct", `${(Number(bar.value) / 10).toFixed(1)}%`);
      if (Number.isFinite(d)) time.textContent = `${fmt((Number(bar.value) / 1000) * d)} / ${fmt(d)}`;
    });
    bar.addEventListener("change", () => {
      const d = audio.duration;
      if (Number.isFinite(d)) audio.currentTime = (Number(bar.value) / 1000) * d;
      seeking = false;
    });
    const controls = document.createElement("div");
    controls.className = "ap-controls";
    controls.append(play, bar, time);
    box.append(controls, label);
    return box;
  }

  // ---------- voice messages ----------
  let recorder = null;
  let recordChunks = [];
  let recordStart = 0;
  let recordTimer = null;
  let recordStream = null;

  function pickAudioType() {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showError(composeError, "This browser can't record audio.");
      return;
    }
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showError(composeError, "Microphone access was blocked.");
      return;
    }
    const type = pickAudioType();
    recorder = new MediaRecorder(recordStream, type ? { mimeType: type } : undefined);
    recordChunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) recordChunks.push(event.data);
    });
    recorder.start(250);
    recordStart = Date.now();
    $("record-bar").hidden = false;
    compose.hidden = true;
    $("record-time").textContent = "0:00";
    recordTimer = setInterval(() => {
      const secs = (Date.now() - recordStart) / 1000;
      $("record-time").textContent = fmt(secs);
      if (secs >= 300) finishRecording(true); // 5 minute limit
    }, 250);
  }

  function stopTracks() {
    recordStream?.getTracks().forEach((track) => track.stop());
    recordStream = null;
  }

  function finishRecording(send) {
    if (!recorder) return;
    clearInterval(recordTimer);
    const rec = recorder;
    recorder = null;
    $("record-bar").hidden = true;
    compose.hidden = Boolean(activeChat?.blocked);
    rec.addEventListener(
      "stop",
      async () => {
        stopTracks();
        if (!send || !recordChunks.length) return;
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "weba";
        const file = new File(recordChunks, `Voice message.${ext}`, { type: type.split(";")[0] });
        try {
          await Fx.sendFx(null, [], "", [file]);
        } catch (err) {
          showError(composeError, err.message);
        }
      },
      { once: true }
    );
    rec.stop();
  }

  $("mic-btn").addEventListener("click", () => {
    if (!activeId) return;
    startRecording();
  });
  $("record-send").addEventListener("click", () => finishRecording(true));
  $("record-cancel").addEventListener("click", () => finishRecording(false));

  // ---------- drawings ----------
  const canvas = $("draw-canvas");
  const ctx = canvas.getContext("2d");
  let strokes = [];
  let current = null;
  let tool = "pen";

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!$("draw-clearbg").checked) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    for (const stroke of strokes) drawStroke(stroke);
  }

  function drawStroke(stroke) {
    ctx.save();
    ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pts = stroke.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    ctx.restore();
    // Eraser on a white page paints white back.
    if (stroke.erase && !$("draw-clearbg").checked) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }

  function canvasPoint(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * canvas.width,
      y: ((event.clientY - box.top) / box.height) * canvas.height,
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    current = {
      color: $("draw-color").value,
      size: Number($("draw-size").value) * scale,
      erase: tool === "eraser",
      points: [canvasPoint(event)],
    };
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!current) return;
    current.points.push(canvasPoint(event));
    redraw();
  });
  const endStroke = () => {
    current = null;
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  function setTool(next) {
    tool = next;
    $("draw-pen").classList.toggle("active", next === "pen");
    $("draw-eraser").classList.toggle("active", next === "eraser");
  }

  $("draw-pen").addEventListener("click", () => setTool("pen"));
  $("draw-eraser").addEventListener("click", () => setTool("eraser"));
  $("draw-undo").addEventListener("click", () => {
    strokes.pop();
    redraw();
  });
  $("draw-clear").addEventListener("click", () => {
    strokes = [];
    redraw();
  });
  $("draw-clearbg").addEventListener("change", redraw);
  $("draw-close").addEventListener("click", () => $("draw-dialog").close());

  function openDraw() {
    if (!activeId) return;
    strokes = [];
    setTool("pen");
    redraw();
    $("draw-dialog").showModal();
  }

  $("draw-send").addEventListener("click", () => {
    if (!strokes.length) {
      $("draw-dialog").close();
      return;
    }
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], "drawing.png", { type: "image/png" });
      try {
        await Fx.sendFx(null, [], "", [file]);
        $("draw-dialog").close();
      } catch (err) {
        showError(composeError, err.message);
      }
    }, "image/png");
  });

  // ---------- polls ----------
  function pollOptionInput(value = "") {
    const row = document.createElement("div");
    row.className = "poll-option-row";
    const input = document.createElement("input");
    input.maxLength = 80;
    input.placeholder = "Option";
    input.value = value;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "bar-x";
    x.textContent = "×";
    x.addEventListener("click", () => {
      if ($("poll-options").children.length > 2) row.remove();
    });
    row.append(input, x);
    return row;
  }

  function openPoll() {
    if (!activeId) return;
    $("poll-q").value = "";
    $("poll-options").replaceChildren(pollOptionInput(), pollOptionInput());
    $("poll-multi").checked = false;
    $("poll-anon").checked = false;
    showError($("poll-error"), "");
    $("poll-dialog").showModal();
  }

  $("poll-add").addEventListener("click", () => {
    if ($("poll-options").children.length >= 10) return;
    const row = pollOptionInput();
    $("poll-options").append(row);
    row.querySelector("input").focus();
  });

  $("poll-send").addEventListener("click", async () => {
    const q = $("poll-q").value.trim();
    const options = [...$("poll-options").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    if (!q) {
      showError($("poll-error"), "Ask a question.");
      return;
    }
    if (options.length < 2) {
      showError($("poll-error"), "Add at least two options.");
      return;
    }
    try {
      await Fx.sendFx({ poll: { q, options, multi: $("poll-multi").checked, anon: $("poll-anon").checked } }, [], q);
      $("poll-dialog").close();
    } catch (err) {
      showError($("poll-error"), err.message);
    }
  });

  function renderPoll(message) {
    const poll = message.poll;
    const card = document.createElement("div");
    card.className = "poll-card";
    const q = document.createElement("div");
    q.className = "poll-q";
    q.textContent = `📊 ${poll.q}`;
    card.append(q);
    const most = Math.max(1, ...poll.options.map((o) => o.count));
    poll.options.forEach((option, index) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "poll-option" + (option.mine ? " mine" : "");
      const fill = document.createElement("span");
      fill.className = "poll-fill";
      fill.style.width = `${poll.total ? (option.count / Math.max(poll.total, most)) * 100 : 0}%`;
      const text = document.createElement("span");
      text.className = "poll-text";
      text.textContent = `${option.mine ? "✓ " : ""}${option.text}`;
      const count = document.createElement("span");
      count.className = "poll-count";
      count.textContent = String(option.count);
      b.append(fill, text, count);
      if (!poll.anon && option.voters.length) b.title = option.voters.join(", ");
      b.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          const updated = await api(`/api/messages/${message.id}/vote`, { method: "POST", body: { option: index } });
          upsertMessage(updated, true);
        } catch (err) {
          showError(composeError, err.message);
        }
      });
      card.append(b);
    });
    const foot = document.createElement("div");
    foot.className = "poll-foot";
    foot.textContent = `${poll.total} vote${poll.total === 1 ? "" : "s"}${poll.multi ? " · pick any" : ""}${
      poll.anon ? " · anonymous" : ""
    }`;
    card.append(foot);
    return card;
  }

  // ---------- shared themes ----------
  async function sendTheme() {
    if (!activeId) return;
    const theme = me?.theme || {};
    try {
      await Fx.sendFx(
        {
          theme: {
            p: theme.primary || Theme.DEFAULT_PRIMARY,
            s: theme.secondary || Theme.DEFAULT_SECONDARY,
            bg: theme.backgroundUrl ? "mine" : undefined,
          },
        },
        [],
        "🎨 Shared a theme"
      );
    } catch (err) {
      showError(composeError, err.message);
    }
  }

  function renderTheme(message) {
    const theme = message.fx.theme;
    const card = document.createElement("div");
    card.className = "theme-card";
    const preview = document.createElement("div");
    preview.className = "theme-preview";
    preview.style.background = theme.p;
    if (theme.bg) {
      preview.style.backgroundImage = `url("/api/attachments/${theme.bg}")`;
      preview.style.backgroundSize = "cover";
      preview.style.backgroundPosition = "center";
    }
    const chip = document.createElement("span");
    chip.className = "theme-chip";
    chip.style.background = theme.s;
    chip.style.color = Theme.contrast(theme.s, "#ffffff") > 3 ? "#fff" : "#111";
    chip.textContent = "Aa";
    const page = document.createElement("span");
    page.className = "theme-chip";
    page.style.background = theme.p;
    page.style.color = Theme.contrast(theme.p, "#ffffff") > 3 ? "#fff" : "#111";
    page.textContent = "Aa";
    preview.append(page, chip);
    const use = document.createElement("button");
    use.type = "button";
    use.className = "btn primary small";
    use.textContent = message.mine ? "Your theme" : "Use this theme";
    use.disabled = message.mine;
    use.addEventListener("click", async (event) => {
      event.stopPropagation();
      use.disabled = true;
      try {
        const data = await api(`/api/messages/${message.id}/apply-theme`, {
          method: "POST",
          body: { clearBackground: !theme.bg },
        });
        me = data.user;
        applyMyTheme();
        paintMe();
        use.textContent = "Applied ✓";
      } catch (err) {
        use.textContent = err.message;
      }
    });
    card.append(preview, use);
    return card;
  }

  // ---------- roulette ----------
  async function runRoulette() {
    if (!activeChat?.isGroup) return;
    try {
      const message = await api(`/api/conversations/${activeChat.id}/roulette`, { method: "POST" });
      Fx.markSeen(message.id);
      upsertMessage(message, true);
      spinRoulette(message.fx.roulette);
    } catch (err) {
      showError(composeError, err.message);
    }
  }

  let spinning = null;
  function spinRoulette(data) {
    const layer = $("roulette-layer");
    const cv = $("roulette-canvas");
    const result = $("roulette-result");
    const g = cv.getContext("2d");
    if (spinning) cancelAnimationFrame(spinning);
    const names = data.names;
    const n = names.length;
    const winnerIndex = Math.max(0, names.indexOf(data.winner));
    const slice = (Math.PI * 2) / n;
    // Land with the winner under the pointer at the top.
    const target = Math.PI * 2 * 6 + (Math.PI * 1.5 - (winnerIndex + 0.5) * slice);
    const duration = 3800;
    const start = performance.now();
    layer.hidden = false;
    result.textContent = "";
    result.classList.remove("show");
    const palette = ["#ff5f6d", "#ffc371", "#47e5bc", "#4d9dff", "#b15eff", "#ff5fd2", "#f5d90a", "#2fd67b"];
    const draw = (angle) => {
      const r = cv.width / 2 - 10;
      g.clearRect(0, 0, cv.width, cv.height);
      g.save();
      g.translate(cv.width / 2, cv.height / 2);
      for (let i = 0; i < n; i += 1) {
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, r, angle + i * slice, angle + (i + 1) * slice);
        g.closePath();
        g.fillStyle = palette[i % palette.length];
        g.fill();
        g.strokeStyle = "#fff";
        g.lineWidth = 3;
        g.stroke();
        g.save();
        g.rotate(angle + (i + 0.5) * slice);
        g.fillStyle = "#1b1b1b";
        g.font = `bold ${Math.max(16, Math.min(34, 260 / n))}px system-ui, sans-serif`;
        g.textAlign = "right";
        g.textBaseline = "middle";
        g.fillText(names[i].slice(0, 14), r - 18, 0);
        g.restore();
      }
      g.restore();
      // pointer
      g.fillStyle = "#1b1b1b";
      g.beginPath();
      g.moveTo(cv.width / 2 - 18, 2);
      g.lineTo(cv.width / 2 + 18, 2);
      g.lineTo(cv.width / 2, 40);
      g.closePath();
      g.fill();
    };
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 4);
      draw(target * ease);
      if (t < 1) spinning = requestAnimationFrame(frame);
      else {
        spinning = null;
        result.textContent = `🎉 ${data.winner}!`;
        result.classList.add("show");
        setTimeout(() => {
          layer.hidden = true;
        }, 2200);
      }
    };
    spinning = requestAnimationFrame(frame);
  }

  $("roulette-layer").addEventListener("click", () => {
    if (spinning) cancelAnimationFrame(spinning);
    spinning = null;
    $("roulette-layer").hidden = true;
  });

  function renderRoulette(message) {
    const card = document.createElement("div");
    card.className = "roulette-card";
    const title = document.createElement("div");
    title.className = "roulette-title";
    title.textContent = `🎲 Roulette picked ${message.fx.roulette.winner}`;
    const sub = document.createElement("div");
    sub.className = "poll-foot";
    sub.textContent = `From ${message.fx.roulette.names.join(", ")}`;
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn ghost small";
    again.textContent = "▶ Watch the spin";
    again.addEventListener("click", (event) => {
      event.stopPropagation();
      spinRoulette(message.fx.roulette);
    });
    card.append(title, sub, again);
    return card;
  }

  // ---------- extras inside a bubble ----------
  function renderExtras(message, content) {
    if (message.poll) content.append(renderPoll(message));
    if (message.fx?.theme) content.append(renderTheme(message));
    if (message.fx?.roulette) content.append(renderRoulette(message));
    if (message.fx?.crumb) content.append(Crumbs.renderCard(message));
  }

  // ---------- self-destructing messages ----------
  const boomObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting || document.visibilityState !== "visible") continue;
              const row = entry.target;
              boomObserver.unobserve(row);
              row.dispatchEvent(new Event("boom-start"));
            }
          },
          { threshold: 0.6 }
        )
      : null;

  const boomStarted = new Set();

  function decorateBoom(message, bubble, content) {
    const boom = message.fx?.boom;
    if (!boom) return;
    const tag = document.createElement("div");
    tag.className = "boom-tag";
    if (message.mine) {
      tag.textContent = `💣 Self-destructs after it's seen (${boom.style}) · seen by ${message.boomSeen || 0}`;
      bubble.insertBefore(tag, content);
      return;
    }
    tag.textContent = `💣 Self-destructs in ${boom.secs}s`;
    bubble.insertBefore(tag, content);
    bubble.classList.add("boom-waiting");
    const start = () => {
      if (boomStarted.has(message.id)) return;
      boomStarted.add(message.id);
      api(`/api/messages/${message.id}/viewed`, { method: "POST" }).catch(() => {});
      bubble.classList.remove("boom-waiting");
      let left = boom.secs;
      tag.textContent = `💣 ${left}s`;
      const tick = setInterval(() => {
        left -= 1;
        if (left > 0) {
          tag.textContent = `💣 ${left}s`;
          return;
        }
        clearInterval(tick);
        blowUp(bubble, boom.style, () => {
          upsertMessage({ ...message, gone: true, fx: null, reactions: [] }, true);
        });
      }, 1000);
    };
    // Starts only once it's actually on screen.
    requestAnimationFrame(() => {
      const row = bubble.closest(".row");
      if (!row) return;
      row.addEventListener("boom-start", start, { once: true });
      if (boomObserver) boomObserver.observe(row);
      else start();
    });
  }

  function blowUp(bubble, style, done) {
    const box = bubble.getBoundingClientRect();
    if (style === "melt") {
      bubble.classList.add("boom-melt");
      setTimeout(done, 1400);
      return;
    }
    // crumble / explode: break the bubble into flying pieces.
    const pieces = document.createElement("div");
    pieces.className = "boom-pieces";
    pieces.style.left = `${box.left}px`;
    pieces.style.top = `${box.top}px`;
    pieces.style.width = `${box.width}px`;
    pieces.style.height = `${box.height}px`;
    const cols = 8;
    const rows = Math.max(3, Math.round((box.height / box.width) * cols));
    const color = getComputedStyle(bubble).backgroundColor;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const p = document.createElement("span");
        p.className = "boom-piece";
        p.style.left = `${(c / cols) * 100}%`;
        p.style.top = `${(r / rows) * 100}%`;
        p.style.width = `${100 / cols + 0.5}%`;
        p.style.height = `${100 / rows + 0.5}%`;
        p.style.background = color;
        let dx;
        let dy;
        let rot;
        if (style === "explode") {
          const angle = Math.atan2(r - rows / 2, c - cols / 2) + (Math.random() - 0.5);
          const dist = 150 + Math.random() * 250;
          dx = Math.cos(angle) * dist;
          dy = Math.sin(angle) * dist;
          rot = (Math.random() - 0.5) * 720;
        } else {
          dx = (Math.random() - 0.5) * 60;
          dy = 200 + Math.random() * 300;
          rot = (Math.random() - 0.5) * 180;
        }
        p.style.setProperty("--dx", `${dx}px`);
        p.style.setProperty("--dy", `${dy}px`);
        p.style.setProperty("--rot", `${rot}deg`);
        p.style.animationDelay = style === "explode" ? "0s" : `${(rows - r) * 0.05 + Math.random() * 0.1}s`;
        pieces.append(p);
      }
    }
    pieces.classList.add(style === "explode" ? "explode" : "crumble");
    document.body.append(pieces);
    bubble.style.visibility = "hidden";
    if (style === "explode") Fx.screenPulse("shake", 0.4);
    setTimeout(() => {
      pieces.remove();
      done();
    }, 1500);
  }

  // ---------- read receipts ("seen" avatars) ----------
  let reads = [];
  let lastReadSent = "";
  let readTimer = null;

  function setReads(list) {
    reads = list;
  }

  function markRead() {
    if (!activeId || document.visibilityState !== "visible") return;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const latest = [...activeMessages.values()]
        .filter((m) => !m.scheduledFor)
        .map((m) => m.createdAt)
        .sort()
        .pop();
      if (!latest || latest === lastReadSent) return;
      lastReadSent = latest;
      api(`/api/conversations/${activeId}/read`, { method: "POST", body: { at: latest } }).catch(() => {});
    }, 400);
  }

  document.addEventListener("visibilitychange", markRead);

  function onRead(payload) {
    if (payload.conversationId !== activeId || payload.username === me?.username) return;
    reads = reads.filter((r) => r.username !== payload.username);
    reads.push({ username: payload.username, avatarUrl: payload.avatarUrl, at: payload.at });
    paintSeen();
  }

  let paintQueued = false;
  function afterRender() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      paintSeen();
    });
  }

  function paintSeen() {
    for (const el of messagesEl.querySelectorAll(".seen-by")) el.remove();
    if (!reads.length) return;
    const list = [...activeMessages.values()]
      .filter((m) => !m.scheduledFor)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const byMessage = new Map();
    for (const r of reads) {
      let target = null;
      for (const m of list) if (String(m.createdAt) <= String(r.at)) target = m;
      if (!target) continue;
      if (!byMessage.has(target.id)) byMessage.set(target.id, []);
      byMessage.get(target.id).push(r);
    }
    for (const [id, people] of byMessage) {
      const row = messagesEl.querySelector(`[data-id="${id}"]`);
      if (!row) continue;
      const strip = document.createElement("div");
      strip.className = "seen-by";
      for (const person of people) {
        const img = document.createElement("img");
        img.src = person.avatarUrl || "/assets/SmallLogo.png";
        img.alt = "";
        img.title = `Seen by ${person.username}`;
        strip.append(img);
      }
      row.after(strip);
    }
  }

  // ---------- typing indicator ----------
  const typers = new Map(); // username -> timeout
  let lastTypingSent = 0;

  function sendTyping() {
    if (!socket || !activeId) return;
    const now = Date.now();
    if (now - lastTypingSent < 2000) return;
    lastTypingSent = now;
    socket.emit("typing", { conversationId: activeId });
  }

  // Only real typing counts (not just having the cursor in the box).
  composeInput.addEventListener("input", (event) => {
    if (event.inputType && event.inputType.startsWith("delete") && !composeInput.value) return;
    sendTyping();
  });
  $("fx-editor").addEventListener("beforeinput", sendTyping);

  function paintTyping() {
    const line = $("typing-line");
    const names = [...typers.keys()];
    if (!names.length) {
      line.hidden = true;
      return;
    }
    line.hidden = false;
    line.replaceChildren();
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    const text = document.createElement("span");
    text.textContent =
      names.length === 1
        ? `${names[0]} is typing`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing`
          : "Several people are typing";
    line.append(dots, text);
  }

  function onTyping(payload) {
    if (payload.conversationId !== activeId || !payload.username) return;
    clearTimeout(typers.get(payload.username));
    typers.set(
      payload.username,
      setTimeout(() => {
        typers.delete(payload.username);
        paintTyping();
      }, 3500)
    );
    paintTyping();
  }

  function clearTyping(username) {
    if (!username || !typers.has(username)) return;
    clearTimeout(typers.get(username));
    typers.delete(username);
    paintTyping();
  }

  function resetForChat() {
    for (const t of typers.values()) clearTimeout(t);
    typers.clear();
    paintTyping();
    replyTo = null;
    $("reply-bar").hidden = true;
    lastReadSent = "";
  }

  return {
    applySendOptions,
    clearSendOptions,
    startReply,
    renderReply,
    openMessageMenu,
    audioPlayer,
    renderExtras,
    decorateBoom,
    spinRoulette,
    setReads,
    markRead,
    onRead,
    afterRender,
    onTyping,
    clearTyping,
    onStarsReceived,
    resetForChat,
    closeMenus,
  };
})();
