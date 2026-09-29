import fs from "node:fs";
import sharp from "sharp";
import { guessMime } from "./mime.js";

export async function processAvatar(inputPath, outputPath, originalName, mime) {
  const type = guessMime(originalName, mime);
  if (!type.startsWith("image/")) {
    const err = new Error("Profile picture must be an image or gif.");
    err.status = 400;
    throw err;
  }
  if (type === "image/gif") {
    if (inputPath !== outputPath) fs.renameSync(inputPath, outputPath);
    return type;
  }
  const tmp = `${outputPath}.tmp`;
  await sharp(inputPath)
    .rotate()
    .resize(500, 500, { fit: "inside", withoutEnlargement: true })
    .toFile(tmp);
  fs.renameSync(tmp, outputPath);
  if (inputPath !== outputPath) {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // already gone
    }
  }
  return type;
}

// Theme backgrounds: keep them reasonably small so they don't eat disk space.
export async function processBackground(inputPath, outputPath, originalName, mime) {
  const type = guessMime(originalName, mime);
  if (!type.startsWith("image/")) {
    const err = new Error("Theme background must be an image.");
    err.status = 400;
    throw err;
  }
  const tmp = `${outputPath}.tmp`;
  try {
    await sharp(inputPath, { animated: false })
      .rotate()
      .resize(2560, 2560, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(tmp);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing written
    }
    const err = new Error("Could not read that image.");
    err.status = 400;
    throw err;
  }
  fs.renameSync(tmp, outputPath);
  if (inputPath !== outputPath) {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // already gone
    }
  }
  return "image/webp";
}

// Custom emojis: small, keeps transparency, keeps GIF/WebP animation.
export async function processEmoji(inputPath, outputPath, originalName, mime) {
  const type = guessMime(originalName, mime);
  if (!type.startsWith("image/")) {
    const err = new Error("Emojis must be images or GIFs.");
    err.status = 400;
    throw err;
  }
  const animated = type === "image/gif" || type === "image/webp";
  const tmp = `${outputPath}.tmp`;
  let outMime = "image/png";
  try {
    let pipeline = sharp(inputPath, { animated }).resize(128, 128, {
      fit: "inside",
      withoutEnlargement: true,
    });
    const meta = await sharp(inputPath, { animated }).metadata();
    if ((meta.pages || 1) > 1) {
      pipeline = type === "image/gif" ? pipeline.gif() : pipeline.webp({ quality: 85 });
      outMime = type === "image/gif" ? "image/gif" : "image/webp";
    } else {
      pipeline = pipeline.png();
    }
    await pipeline.toFile(tmp);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing written
    }
    const err = new Error(`Could not read ${originalName}.`);
    err.status = 400;
    throw err;
  }
  fs.renameSync(tmp, outputPath);
  if (inputPath !== outputPath) {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // already gone
    }
  }
  return outMime;
}
