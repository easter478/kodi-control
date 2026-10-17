// Tiny RGBA PNG encoder for the rounded-poster mask and the dim overlay texture.
const zlib = require('zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encode(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (w * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// White rounded rectangle with anti-aliased transparent corners (poster 2:3).
function roundedMask(radius, w = 400, h = 600) {
  const r = Math.max(0, radius) * (w / 200);
  return encode(w, h, (x, y) => {
    const cx = x < r ? r : x > w - 1 - r ? w - 1 - r : x;
    const cy = y < r ? r : y > h - 1 - r ? h - 1 - r : y;
    const d = Math.hypot(x - cx, y - cy);
    const a = r === 0 ? 255 : Math.round(255 * Math.min(1, Math.max(0, r - d + 0.5)));
    return [255, 255, 255, a];
  });
}
const white = () => encode(8, 8, () => [255, 255, 255, 255]);

// Rounded "glass" panel: slightly see-through fill with a brighter 2px rim. Tinted with colordiffuse.
function glass(radius = 28, s = 96) {
  return encode(s, s, (x, y) => {
    const cx = x < radius ? radius : x > s - 1 - radius ? s - 1 - radius : x;
    const cy = y < radius ? radius : y > s - 1 - radius ? s - 1 - radius : y;
    const d = Math.hypot(x - cx, y - cy);
    const edge = Math.min(1, Math.max(0, radius - d + 0.5));
    const inner = Math.min(x, y, s - 1 - x, s - 1 - y) < 2 || d > radius - 2.5;
    return [255, 255, 255, Math.round(edge * (inner ? 255 : 205))];
  });
}

// vertical fade: transparent at the top to opaque white at the bottom (eased), tinted by colordiffuse in the skin
const fadeV = (h = 256) => encode(4, h, (x, y) => [255, 255, 255, Math.round(255 * Math.pow(y / (h - 1), 1.6))]);
module.exports = { roundedMask, white, glass, encode, fadeV };
