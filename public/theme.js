// Theme engine: turns a primary + secondary color (and an optional background
// image) into the full set of interface colors. Also holds the HSV picker.
(function () {
  const DEFAULT_PRIMARY = "#f4ecdf";
  const DEFAULT_SECONDARY = "#4f6153";
  const CACHE_KEY = "lc-theme";

  // ---------- color math ----------
  function hexToRgb(hex) {
    const n = String(hex || "").replace("#", "");
    return {
      r: parseInt(n.slice(0, 2), 16) || 0,
      g: parseInt(n.slice(2, 4), 16) || 0,
      b: parseInt(n.slice(4, 6), 16) || 0,
    };
  }

  function rgbToHex({ r, g, b }) {
    const to = (n) =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  }

  function hsvToHex(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0;
    let g = 0;
    let b = 0;
    const hh = ((h % 360) + 360) % 360;
    if (hh < 60) [r, g, b] = [c, x, 0];
    else if (hh < 120) [r, g, b] = [x, c, 0];
    else if (hh < 180) [r, g, b] = [0, c, x];
    else if (hh < 240) [r, g, b] = [0, x, c];
    else if (hh < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
  }

  function hexToHsv(hex) {
    const { r: R, g: G, b: B } = hexToRgb(hex);
    const r = R / 255;
    const g = G / 255;
    const b = B / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max ? d / max : 0, v: max };
  }

  function mix(a, b, t) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return rgbToHex({
      r: x.r + (y.r - x.r) * t,
      g: x.g + (y.g - x.g) * t,
      b: x.b + (y.b - x.b) * t,
    });
  }

  function luminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const f = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // Push `color` toward `toward` until it reaches the contrast target on `bg`.
  function ensureContrast(color, bg, toward, target) {
    let out = color;
    for (let i = 1; i <= 20 && contrast(out, bg) < target; i += 1) {
      out = mix(color, toward, i / 20);
    }
    return out;
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ---------- palette ----------
  function buildPalette(primary, secondary, hasImage) {
    const P = primary || DEFAULT_PRIMARY;
    const S = secondary || DEFAULT_SECONDARY;
    const dark = luminance(P) < 0.2;
    const hue = hexToHsv(P).h;
    const inkBase = dark ? hsvToHex(hue, 0.06, 0.96) : hsvToHex(hue, 0.35, 0.12);
    const ink = ensureContrast(inkBase, P, dark ? "#ffffff" : "#000000", 10);

    const paper = dark ? mix(P, "#ffffff", 0.06) : mix(P, "#ffffff", 0.55);
    const sidebar = dark ? mix(P, "#000000", 0.18) : mix(P, "#000000", 0.03);
    const tan = dark ? mix(mix(P, S, 0.22), "#ffffff", 0.06) : mix(mix(P, S, 0.14), "#000000", 0.04);
    const line = mix(P, ink, dark ? 0.16 : 0.13);
    const muted = ensureContrast(mix(P, ink, 0.55), P, ink, 4.2);

    const accentInk = contrast(S, "#ffffff") >= contrast(S, "#111111") ? "#ffffff" : "#111111";
    const accentStrong = mix(S, dark ? "#ffffff" : "#000000", 0.18);
    const link = ensureContrast(S, P, ink, 4.2);
    const label = ensureContrast(mix(S, ink, 0.35), paper, ink, 4.5);

    let mine = mix(P, S, dark ? 0.38 : 0.3);
    if (contrast(ink, mine) < 7) mine = mix(P, S, dark ? 0.24 : 0.18);
    const mineInk = contrast(ink, mine) >= 4.5 ? ink : dark ? "#ffffff" : "#000000";

    const them = mix(S, hsvToHex((hexToHsv(S).h + 150) % 360, 0.55, dark ? 0.8 : 0.55), 0.7);

    // With a background image the surfaces become see-through.
    const a = hasImage
      ? { cream: 0.74, paper: 0.86, sidebar: 0.84, bubble: 0.9 }
      : { cream: 1, paper: 1, sidebar: 1, bubble: 1 };

    return {
      dark,
      vars: {
        "--cream": rgba(P, a.cream),
        "--cream-solid": P,
        "--paper": rgba(paper, a.paper),
        "--paper-solid": paper,
        "--sidebar": rgba(sidebar, a.sidebar),
        "--tan": tan,
        "--line": line,
        "--ink": ink,
        "--muted": muted,
        "--accent": S,
        "--accent-ink": accentInk,
        "--accent-strong": accentStrong,
        "--link": link,
        "--label": label,
        "--mine": rgba(mine, a.bubble),
        "--mine-ink": mineInk,
        "--theirs": rgba(paper, a.bubble),
        "--you": S,
        "--them": them,
        "--error": dark ? "#ff9b85" : "#9a2f1b",
        "--highlight": rgba(S, dark ? 0.45 : 0.3),
        "--overlay": rgba(dark ? "#000000" : P, 0.55),
      },
    };
  }

  function apply(theme, options = {}) {
    const primary = theme?.primary || DEFAULT_PRIMARY;
    const secondary = theme?.secondary || DEFAULT_SECONDARY;
    const bgUrl = theme?.backgroundUrl || null;
    const palette = buildPalette(primary, secondary, Boolean(bgUrl));
    const root = document.documentElement;
    for (const [key, value] of Object.entries(palette.vars)) {
      root.style.setProperty(key, value);
    }
    root.style.colorScheme = palette.dark ? "dark" : "light";
    root.classList.toggle("has-bg", Boolean(bgUrl));
    const layer = document.getElementById("bg-layer");
    if (layer) {
      layer.hidden = !bgUrl;
      layer.style.backgroundImage = bgUrl ? `url("${bgUrl}")` : "";
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = primary;
    if (options.cache !== false) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ primary, secondary }));
      } catch {
        // storage unavailable
      }
    }
  }

  function applyCached() {
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    } catch {
      cached = null;
    }
    apply(cached || {}, { cache: false });
  }

  // ---------- colors from an image ----------
  // Buckets pixels by hue (for colorful pixels) or brightness (for greys) and
  // returns the most common bucket as primary, plus the most common colorful
  // bucket that is clearly different as secondary. No averaging across the
  // whole image, so a half-green half-purple picture won't turn brown.
  function colorsFromImage(img) {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const hex = rgbToHex({ r: data[i], g: data[i + 1], b: data[i + 2] });
      const { h, s, v } = hexToHsv(hex);
      let key;
      if (s < 0.18 || v < 0.12) key = `n${Math.min(4, Math.floor(v * 5))}`;
      else key = `h${Math.floor(h / 20)}v${v < 0.5 ? 0 : 1}`;
      const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, key };
      bucket.n += 1;
      bucket.r += data[i];
      bucket.g += data[i + 1];
      bucket.b += data[i + 2];
      buckets.set(key, bucket);
    }
    const list = [...buckets.values()]
      .map((bucket) => ({
        key: bucket.key,
        n: bucket.n,
        hex: rgbToHex({ r: bucket.r / bucket.n, g: bucket.g / bucket.n, b: bucket.b / bucket.n }),
      }))
      .sort((a, b) => b.n - a.n);
    if (!list.length) return { primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY };

    const primary = list[0].hex;
    const p = hexToHsv(primary);
    const colorful = list.filter((item) => item.key.startsWith("h"));
    let pick = colorful.find((item) => {
      const c = hexToHsv(item.hex);
      const hueGap = Math.min(Math.abs(c.h - p.h), 360 - Math.abs(c.h - p.h));
      return p.s < 0.18 || hueGap > 35 || Math.abs(c.v - p.v) > 0.35;
    });
    let secondary;
    if (pick) {
      const c = hexToHsv(pick.hex);
      secondary = hsvToHex(c.h, Math.max(0.45, c.s), Math.min(0.9, Math.max(0.45, c.v)));
    } else {
      secondary = hsvToHex((p.h + 180) % 360, 0.5, luminance(primary) < 0.2 ? 0.8 : 0.45);
    }
    return { primary, secondary };
  }

  // ---------- HSV picker ----------
  function createPicker(container, initialHex, onChange) {
    container.classList.add("hsv");
    container.replaceChildren();
    const canvas = document.createElement("canvas");
    canvas.width = 180;
    canvas.height = 140;
    canvas.className = "sv-canvas";
    const hue = document.createElement("input");
    hue.type = "range";
    hue.min = "0";
    hue.max = "360";
    hue.className = "hue-slider";
    const row = document.createElement("div");
    row.className = "swatch-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    const code = document.createElement("span");
    code.className = "swatch-code";
    row.append(swatch, code);
    container.append(canvas, hue, row);

    let hsv = hexToHsv(initialHex || "#888888");

    function draw() {
      const ctx = canvas.getContext("2d");
      const { width, height } = canvas;
      ctx.fillStyle = hsvToHex(hsv.h, 1, 1);
      ctx.fillRect(0, 0, width, height);
      const white = ctx.createLinearGradient(0, 0, width, 0);
      white.addColorStop(0, "#fff");
      white.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = white;
      ctx.fillRect(0, 0, width, height);
      const black = ctx.createLinearGradient(0, 0, 0, height);
      black.addColorStop(0, "rgba(0,0,0,0)");
      black.addColorStop(1, "#000");
      ctx.fillStyle = black;
      ctx.fillRect(0, 0, width, height);
      const x = hsv.s * width;
      const y = (1 - hsv.v) * height;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = hsv.v > 0.5 ? "#000" : "#fff";
      ctx.stroke();
      const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
      swatch.style.background = hex;
      code.textContent = hex;
    }

    function emit() {
      draw();
      onChange?.(hsvToHex(hsv.h, hsv.s, hsv.v));
    }

    hue.addEventListener("input", () => {
      hsv.h = Number(hue.value);
      emit();
    });

    canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      const pick = (ev) => {
        const box = canvas.getBoundingClientRect();
        hsv.s = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
        hsv.v = 1 - Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height));
        emit();
      };
      pick(event);
      const move = (ev) => pick(ev);
      const up = () => {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", up);
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);
    });

    function set(hex) {
      hsv = hexToHsv(hex);
      hue.value = String(Math.round(hsv.h));
      draw();
    }

    set(initialHex || "#888888");
    return {
      get: () => hsvToHex(hsv.h, hsv.s, hsv.v),
      set,
    };
  }

  window.Theme = {
    DEFAULT_PRIMARY,
    DEFAULT_SECONDARY,
    apply,
    applyCached,
    buildPalette,
    colorsFromImage,
    createPicker,
    contrast,
    ensureContrast,
    hexToHsv,
    hsvToHex,
  };

  applyCached();
})();

// Touch sliding for every <input type="range">: press anywhere on the slider
// and drag, and the value follows your finger all the way to both ends.
// (Some phones only jump on tap, or treat the drag as scrolling.)
(function () {
  function valueAt(input, clientX) {
    const box = input.getBoundingClientRect();
    const min = Number(input.min || 0);
    const max = Number(input.max === "" ? 100 : input.max);
    const thumb = Math.min(24, box.width / 4);
    let t = (clientX - box.left - thumb / 2) / Math.max(1, box.width - thumb);
    t = Math.max(0, Math.min(1, t));
    const stepAttr = input.step;
    let v = min + t * (max - min);
    if (stepAttr !== "any") {
      const step = Number(stepAttr) || 1;
      v = min + Math.round((v - min) / step) * step;
      const decimals = (String(step).split(".")[1] || "").length;
      v = Number(v.toFixed(decimals));
    }
    return Math.max(min, Math.min(max, v));
  }

  function setValue(input, clientX) {
    const next = String(valueAt(input, clientX));
    if (input.value === next) return false;
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "range" || input.disabled) return;
      if (event.pointerType === "mouse") return; // mice already slide fine
      event.preventDefault();
      let changed = setValue(input, event.clientX);
      try {
        input.setPointerCapture(event.pointerId);
      } catch {}
      const move = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        ev.preventDefault();
        if (setValue(input, ev.clientX)) changed = true;
      };
      const end = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        input.removeEventListener("pointermove", move);
        input.removeEventListener("pointerup", end);
        input.removeEventListener("pointercancel", end);
        if (changed) input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      input.addEventListener("pointermove", move);
      input.addEventListener("pointerup", end);
      input.addEventListener("pointercancel", end);
    },
    { capture: true, passive: false }
  );
})();
