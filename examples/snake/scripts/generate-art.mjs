// Tiny, reproducible nearest-neighbor sprite art for the npm consumer game.
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const size = 20;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
  const kind = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}

function png(kind) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const palettes = {
    head: [
      [26, 70, 58, 255],
      [139, 240, 146, 255],
      [39, 130, 92, 255],
    ],
    body: [
      [21, 65, 62, 255],
      [53, 172, 118, 255],
      [34, 117, 94, 255],
    ],
    food: [
      [105, 43, 65, 255],
      [255, 114, 103, 255],
      [208, 71, 91, 255],
    ],
  };
  const colors = palettes[kind];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < 2 || x >= size - 2 || y < 2 || y >= size - 2;
      const shade = x + y > 20 || (kind === "food" && (x - 10) ** 2 + (y - 10) ** 2 > 52);
      const color = colors[edge ? 0 : shade ? 2 : 1];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let channel = 0; channel < 4; channel++) rows[offset + channel] = color[channel];
    }
  }
  if (kind === "head") {
    for (const x of [13, 16])
      for (const y of [5, 6]) {
        const offset = y * (size * 4 + 1) + 1 + x * 4;
        rows.set([17, 39, 49, 255], offset);
      }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(path.join(root, "assets"), { recursive: true });
await Promise.all(
  ["head", "body", "food"].map((kind) => writeFile(path.join(root, "assets", `${kind}.png`), png(kind))),
);
