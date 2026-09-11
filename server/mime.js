const EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

export function guessMime(name, fallback = "") {
  const ext = String(name || "").split(".").pop()?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext];
  if (fallback && fallback !== "application/octet-stream") return fallback;
  return fallback || "application/octet-stream";
}

export function kindFromMime(mime, name) {
  const resolved = guessMime(name, mime);
  if (resolved.startsWith("image/")) return "image";
  if (resolved.startsWith("video/")) return "video";
  if (resolved.startsWith("audio/")) return "audio";
  return "file";
}
