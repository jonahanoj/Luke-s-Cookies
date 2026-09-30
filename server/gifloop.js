import fs from "node:fs";

// Makes a GIF loop forever by setting (or adding) its NETSCAPE2.0 loop block.
// Lossless: only a few bytes change, the image data is untouched.
const MAX_BYTES = 60 * 1024 * 1024;
const NETSCAPE = Buffer.from("NETSCAPE2.0", "ascii");

export function makeGifLoop(filePath) {
  try {
    const { size } = fs.statSync(filePath);
    if (size < 14 || size > MAX_BYTES) return false;
    const data = fs.readFileSync(filePath);
    if (data.toString("ascii", 0, 3) !== "GIF") return false;
    const found = data.indexOf(NETSCAPE, 13);
    if (found !== -1 && found < 4096 && data[found + 11] === 0x03 && data[found + 12] === 0x01) {
      if (data[found + 13] === 0 && data[found + 14] === 0) return true;
      data[found + 13] = 0;
      data[found + 14] = 0;
      fs.writeFileSync(filePath, data);
      return true;
    }
    const flags = data[10];
    const table = flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;
    const at = 13 + table;
    if (at > data.length) return false;
    const block = Buffer.concat([
      Buffer.from([0x21, 0xff, 0x0b]),
      NETSCAPE,
      Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
    ]);
    const tmp = `${filePath}.loop`;
    fs.writeFileSync(tmp, Buffer.concat([data.subarray(0, at), block, data.subarray(at)]));
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}
