// Validates the "fx" data a client sends with a message: styled text spans,
// screen overlays (images/GIFs), a music clip, or a shared emoji pack.
// Anything unexpected is dropped, so stored fx is always safe to render.

const HEX = /^#[0-9a-fA-F]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YT = /^[A-Za-z0-9_-]{11}$/;
const EMOJI_NAME = /^[A-Za-z0-9_]{1,32}$/;

export const MAX_EFFECT_SECONDS = 10;
const MAX_SPANS = 400;
const MAX_TEXT = 2000;
const MAX_OVERLAYS = 12;

function num(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanSpan(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.e && typeof raw.e === "object") {
    const f = String(raw.e.f || "");
    const n = String(raw.e.n || "");
    if (!UUID.test(f) || !EMOJI_NAME.test(n)) return null;
    return { e: { f, n } };
  }
  const t = typeof raw.t === "string" ? raw.t : "";
  if (!t) return null;
  const span = { t };
  if (raw.b) span.b = 1;
  if (raw.i) span.i = 1;
  if (raw.u) span.u = 1;
  if (raw.s) span.s = 1;
  if (typeof raw.c === "string" && HEX.test(raw.c)) span.c = raw.c.toLowerCase();
  if (Array.isArray(raw.g)) {
    const g = raw.g.filter((c) => typeof c === "string" && HEX.test(c)).slice(0, 8);
    if (g.length >= 2) span.g = g.map((c) => c.toLowerCase());
  }
  if (raw.rb) span.rb = 1;
  if (raw.w) span.w = 1;
  if (raw.sh) span.sh = 1;
  if (raw.gl) span.gl = 1;
  if (raw.sz !== undefined) span.sz = Math.round(num(raw.sz, 10, 64, 16));
  if (span.c) {
    delete span.g;
    delete span.rb;
  } else if (span.g) {
    delete span.rb;
  }
  return span;
}

export function spansToText(spans) {
  return spans.map((span) => (span.e ? `:${span.e.n}:` : span.t)).join("");
}

// assetIds: attachment ids uploaded with this message as fx assets, in order.
// existingIds: fx asset ids already on the message (when editing).
export function sanitizeFx(raw, assetIds, existingIds = new Set()) {
  if (!raw || typeof raw !== "object") return null;
  const fx = {};

  if (Array.isArray(raw.spans)) {
    const spans = [];
    let length = 0;
    for (const item of raw.spans.slice(0, MAX_SPANS)) {
      const span = cleanSpan(item);
      if (!span) continue;
      if (span.t) {
        const room = MAX_TEXT - length;
        if (room <= 0) break;
        if (span.t.length > room) span.t = span.t.slice(0, room);
        length += span.t.length;
      }
      spans.push(span);
    }
    const styled = spans.some((span) => span.e || Object.keys(span).length > 1);
    if (spans.length && styled) fx.spans = spans;
  }

  const effect = raw.effect && typeof raw.effect === "object" ? raw.effect : null;
  if (effect) {
    const out = {};
    const assetFor = (value) => {
      if (typeof value === "string" && existingIds.has(value)) return value;
      const index = typeof value === "number" ? value : NaN;
      return Number.isInteger(index) && assetIds[index] ? assetIds[index] : null;
    };
    if (Array.isArray(effect.overlays)) {
      const overlays = [];
      for (const item of effect.overlays.slice(0, MAX_OVERLAYS)) {
        const a = assetFor(item?.a);
        if (!a) continue;
        const start = num(item.s, 0, MAX_EFFECT_SECONDS - 0.5, 0);
        const end = num(item.e, start + 0.5, MAX_EFFECT_SECONDS, MAX_EFFECT_SECONDS);
        overlays.push({
          a,
          x: num(item.x, 0, 100, 50),
          y: num(item.y, 0, 100, 50),
          w: num(item.w, 2, 150, 40),
          r: Math.round(num(item.r, -180, 180, 0)),
          s: start,
          e: end,
        });
      }
      if (overlays.length) out.overlays = overlays;
    }
    const music = effect.music && typeof effect.music === "object" ? effect.music : null;
    if (music) {
      const start = num(music.s, 0, 60 * 60 * 6, 0);
      const end = num(music.e, start + 0.5, start + MAX_EFFECT_SECONDS, start + MAX_EFFECT_SECONDS);
      const volume = num(music.v, 0, 1, 0.8);
      if (typeof music.yt === "string" && YT.test(music.yt)) {
        out.music = { yt: music.yt, s: start, e: end, v: volume };
      } else {
        const a = assetFor(music.a);
        if (a) out.music = { a, s: start, e: end, v: volume };
      }
    }
    if (out.overlays || out.music) fx.effect = out;
  }

  if (raw.pack && typeof raw.pack === "object" && UUID.test(String(raw.pack.id || ""))) {
    fx.pack = { id: String(raw.pack.id), name: String(raw.pack.name || "Emoji pack").slice(0, 40) };
  }

  return Object.keys(fx).length ? fx : null;
}

// Which attachment ids the fx actually uses (unused uploads get deleted).
export function fxAssetIds(fx) {
  const ids = new Set();
  for (const overlay of fx?.effect?.overlays || []) ids.add(overlay.a);
  if (fx?.effect?.music?.a) ids.add(fx.effect.music.a);
  return ids;
}
