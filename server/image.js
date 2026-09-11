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
