import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FRAME = 24;
const POSES = 8;
const OUTPUT = resolve("public/assets/pixel");

const CAST = [
  ["velvet-talon", "763d89", "f2c4ff", "3e214a"],
  ["cornfield-comet", "df9d22", "fff0a8", "784d11"],
  ["scarlet-bantam", "ce3e49", "ffd0c7", "6d1d25"],
  ["midnight-rooster", "24465f", "80d0e6", "0d222f"],
  ["buttercup-blitz", "edd34f", "fffbd0", "837321"],
  ["silver-drumstick", "aeb9bd", "f1f8f9", "4a555a"],
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

function chunk(type, data) {
  const label = Buffer.from(type, "ascii");
  return Buffer.concat([
    u32(data.length),
    label,
    data,
    u32(crc32(Buffer.concat([label, data]))),
  ]);
}

function png(width, height, pixels) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(
      Buffer.from([0]),
      Buffer.from(pixels.slice(y * width * 4, (y + 1) * width * 4)),
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function rgba(hex, alpha = 255) {
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    alpha,
  ];
}

function surface(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  const put = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    pixels.set(color, (y * width + x) * 4);
  };
  const rect = (x, y, w, h, color) => {
    for (let py = y; py < y + h; py += 1) {
      for (let px = x; px < x + w; px += 1) put(px, py, color);
    }
  };
  return { pixels, put, rect };
}

function drawChicken(surface, frame, colors, variant) {
  const offset = frame * FRAME;
  const [body, light, dark] = colors.map((value) => rgba(value));
  const white = rgba("fff4cf");
  const red = rgba("e6493f");
  const black = rgba("14101b");
  const leg = rgba("f3b53f");
  const cyan = rgba("62e6dc");
  const pose = frame;
  const hurt = pose === 5;
  const down = pose === 6;
  const recover = pose === 7;
  const guard = pose === 3;
  const cover = pose === 4;
  const peck = pose === 2;
  const bob = pose === 1 || recover ? -1 : 0;
  const x = offset + (down ? 2 : guard ? 6 : 4);
  const y = down ? 13 : 7 + bob;

  if (down) {
    surface.rect(x + 2, y, 13, 6, body);
    surface.rect(x + 12, y - 2, 6, 5, light);
    surface.rect(x + 18, y, 3, 2, leg);
    surface.rect(x, y + 1, 4, 3, dark);
    surface.put(x + 16, y - 1, black);
    return;
  }

  surface.rect(x + 2, y + 3, guard ? 9 : 11, guard ? 9 : 8, body);
  surface.rect(x + 5, y + 1, 8, 8, light);
  surface.rect(x + 12, y + (peck ? 5 : 2), peck ? 6 : 5, 5, light);
  surface.rect(x + 17, y + (peck ? 7 : 4), peck ? 5 : 3, 2, leg);
  surface.rect(x, y + 4, 4, 3, dark);
  surface.rect(x + 1, y + 2, 3, 2, body);
  surface.rect(x + 12, y, 2, 2, red);
  surface.rect(x + 14, y - 1, 2, 2, red);
  surface.put(x + 15, y + (peck ? 5 : 3), black);
  surface.rect(x + 6, y + 5, 5, 4, dark);
  surface.rect(x + 7 + (variant % 2), y + 5, 2, 2, white);
  surface.rect(x + 5, y + 11, 2, recover ? 4 : 3, leg);
  surface.rect(x + 11, y + 11, 2, recover ? 4 : 3, leg);
  surface.rect(x + 3, y + 14, 5, 1, leg);
  surface.rect(x + 9, y + 14, 5, 1, leg);

  if (guard) {
    surface.rect(x + 19, y + 3, 2, 8, cyan);
    surface.rect(x + 16, y + 2, 4, 2, cyan);
    surface.rect(x + 16, y + 10, 4, 2, cyan);
  }
  if (cover) {
    surface.rect(x - 1, y + 1, 2, 10, cyan);
    surface.rect(x, y, 12, 2, cyan);
  }
  if (hurt) {
    surface.rect(x + 19, y, 2, 2, red);
    surface.rect(x + 21, y - 2, 1, 5, red);
    surface.rect(x + 18, y - 3, 5, 1, red);
  }
  if (recover) {
    surface.rect(x + 2, y - 3, 14, 1, cyan);
    surface.put(x + 1, y - 2, cyan);
    surface.put(x + 17, y - 2, cyan);
  }
}

function writeChickenSheet(id, palette, variant) {
  const canvas = surface(FRAME * POSES, FRAME);
  for (let frame = 0; frame < POSES; frame += 1)
    drawChicken(canvas, frame, palette, variant);
  const path = resolve(OUTPUT, "chickens", `${id}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(FRAME * POSES, FRAME, canvas.pixels));
}

function writeCommentator(id, bodyHex, accentHex, glasses) {
  const canvas = surface(40, 40);
  const body = rgba(bodyHex);
  const accent = rgba(accentHex);
  const dark = rgba("17151d");
  const light = rgba("fff3c9");
  const red = rgba("d94b45");
  canvas.rect(7, 13, 22, 18, body);
  canvas.rect(12, 8, 17, 14, light);
  canvas.rect(28, 14, 7, 4, accent);
  canvas.rect(10, 6, 4, 4, red);
  canvas.rect(15, 4, 4, 5, red);
  canvas.rect(20, 5, 4, 4, red);
  canvas.rect(15, 13, 2, 2, dark);
  canvas.rect(23, 13, 2, 2, dark);
  if (glasses) {
    canvas.rect(12, 11, 7, 6, dark);
    canvas.rect(21, 11, 7, 6, dark);
    canvas.rect(19, 13, 2, 1, dark);
    canvas.rect(14, 13, 3, 2, accent);
    canvas.rect(23, 13, 3, 2, accent);
  }
  canvas.rect(16, 19, 8, 2, accent);
  canvas.rect(4, 31, 31, 4, dark);
  canvas.rect(9, 35, 4, 4, accent);
  canvas.rect(27, 35, 4, 4, accent);
  const path = resolve(OUTPUT, "commentators", `${id}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(40, 40, canvas.pixels));
}

function writeShieldIcon() {
  const canvas = surface(12, 12);
  const cyan = rgba("66e1d4");
  const light = rgba("d8fffa");
  const dark = rgba("163b3f");
  canvas.rect(2, 1, 8, 2, cyan);
  canvas.rect(1, 3, 2, 5, cyan);
  canvas.rect(9, 3, 2, 5, cyan);
  canvas.rect(3, 8, 6, 2, cyan);
  canvas.rect(5, 10, 2, 1, cyan);
  canvas.rect(3, 3, 6, 5, dark);
  canvas.rect(4, 3, 4, 1, light);
  canvas.rect(4, 4, 1, 3, light);
  const path = resolve(OUTPUT, "ui", "shield.png");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(12, 12, canvas.pixels));
}

mkdirSync(OUTPUT, { recursive: true });
CAST.forEach(([id, body, light, dark], index) =>
  writeChickenSheet(id, [body, light, dark], index),
);
writeCommentator("clive-peckham", "c98b39", "f6d463", false);
writeCommentator("henrietta-hype", "8a3f69", "66e1d4", true);
writeShieldIcon();

console.log(
  `Wrote ${CAST.length} eight-pose chicken sheets, two commentator portraits, and one shield icon to ${OUTPUT}.`,
);
