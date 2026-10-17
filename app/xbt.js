// Read a skin's packed media/Textures.xbt (XBTF v2/v3) and turn entries back into PNG files, so an OSD moved
// to another skin keeps its icons. Frames are raw pixels, LZO1X-compressed when packed < unpacked.
const png = require('./png');

function parse(buf) {
  if (buf.slice(0, 4).toString('latin1') !== 'XBTF') throw new Error('not an XBT file');
  const n = buf.readUInt32LE(5);
  const files = new Map();
  let o = 9;
  for (let i = 0; i < n; i++) {
    const path = buf.slice(o, o + 256).toString('utf8').replace(/\0[\s\S]*$/, '');
    o += 256;
    const nf = buf.readUInt32LE(o + 4);
    o += 8;
    const frames = [];
    for (let f = 0; f < nf; f++) {
      frames.push({ w: buf.readUInt32LE(o), h: buf.readUInt32LE(o + 4), fmt: buf.readUInt32LE(o + 8),
        packed: Number(buf.readBigUInt64LE(o + 12)), unpacked: Number(buf.readBigUInt64LE(o + 20)), off: Number(buf.readBigUInt64LE(o + 32)) });
      o += 40;
    }
    files.set(path.toLowerCase().replace(/\\/g, '/'), { path, frames });
  }
  return files;
}

// LZO1X decompression (the format minilzo / lzo1x_decompress_safe reads).
function lzo1x(src, outLen) {
  const dst = Buffer.alloc(outLen);
  let ip = 0, op = 0, t = 0, m = 0;
  const lit = k => { src.copy(dst, op, ip, ip + k); op += k; ip += k; };
  const cp = (from, k) => { for (let i = 0; i < k; i++) dst[op++] = dst[from + i]; };
  const len = (base, mask) => { if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += base + src[ip++]; } };
  let state = 'start';
  for (;;) {
    if (state === 'start') {
      if (src[ip] > 17) {
        t = src[ip++] - 17;
        if (t < 4) { lit(t); t = src[ip++]; state = 'match'; continue; }
        lit(t); state = 'first'; continue;
      }
      state = 'loop'; continue;
    }
    if (state === 'loop') {
      t = src[ip++];
      if (t >= 16) { state = 'match'; continue; }
      len(15);
      lit(t + 3);
      state = 'first'; continue;
    }
    if (state === 'first') {
      t = src[ip++];
      if (t >= 16) { state = 'match'; continue; }
      m = op - (1 + 0x0800) - (t >> 2) - (src[ip++] << 2);
      cp(m, 3);
      state = 'done'; continue;
    }
    if (state === 'match') {
      if (t >= 64) {
        m = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
        cp(m, (t >> 5) - 1 + 2);
      } else if (t >= 32) {
        t &= 31; len(31);
        m = op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6)); ip += 2;
        cp(m, t + 2);
      } else if (t >= 16) {
        m = op - ((t & 8) << 11);
        t &= 7; len(7);
        m -= (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2;
        if (m === op) return dst.slice(0, op); // end of stream
        m -= 0x4000;
        cp(m, t + 2);
      } else {
        m = op - 1 - (t >> 2) - (src[ip++] << 2);
        cp(m, 2);
      }
      state = 'done'; continue;
    }
    if (state === 'done') {
      t = src[ip - 2] & 3;
      if (t === 0) { state = 'loop'; continue; }
      lit(t);
      t = src[ip++];
      state = 'match'; continue;
    }
  }
}

// Kodi KD_TEX_* format (Kodi 21+) or legacy XB_FMT_* to RGBA pixels.
function pixels(fr, data) {
  const { w, h, fmt } = fr;
  const n = w * h, out = Buffer.alloc(n * 4);
  const type = fmt & 0xff00, kd = fmt & 0xf000, swiz = fmt & 0xf00000, opaque = (fmt & 0xf0000) === 0x10000;
  const put = (i, r, g, b, a) => { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = opaque ? 255 : a; };
  const sw = (i, r, g, b, a) => {
    switch (swiz) {
      case 0x100000: return put(i, r, g, b, 255);
      case 0x200000: return put(i, r, r, r, 255);
      case 0x300000: return put(i, 255, 255, 255, r);
      case 0x400000: return put(i, r, r, r, g);
      case 0x500000: return put(i, r, r, r, r);
      default: return put(i, r, g, b, a);
    }
  };
  if (kd === 0x1000) {
    if (type === 0x1000) for (let i = 0; i < n; i++) sw(i, data[i], 0, 0, 255);                      // R8
    else if (type === 0x1100) for (let i = 0; i < n; i++) sw(i, data[i * 2], data[i * 2 + 1], 0, 255); // RG8
    else if (type === 0x1500) for (let i = 0; i < n; i++) sw(i, data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255);
    else if (type === 0x1600) for (let i = 0; i < n; i++) sw(i, data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);
    else if (type === 0x1700) for (let i = 0; i < n; i++) sw(i, data[i * 4 + 2], data[i * 4 + 1], data[i * 4], data[i * 4 + 3]);
    else return null;
  } else if (kd === 0 && (fmt & 0xffff) === 0x10) {                                                  // legacy A8R8G8B8 (BGRA bytes)
    for (let i = 0; i < n; i++) put(i, data[i * 4 + 2], data[i * 4 + 1], data[i * 4], data[i * 4 + 3]);
  } else if (kd === 0 && (fmt & 0xffff) === 0x40) {
    for (let i = 0; i < n; i++) put(i, data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);
  } else return null; // compressed GPU formats (DXT/ETC/ASTC) are not handled
  return out;
}

// PNG bytes for one entry (first frame), or null when missing / unsupported.
function toPng(buf, files, name) {
  const f = files.get(name.toLowerCase().replace(/\\/g, '/'));
  if (!f || !f.frames.length) return null;
  const fr = f.frames[0];
  let data = buf.slice(fr.off, fr.off + fr.packed);
  if (fr.packed < fr.unpacked) data = lzo1x(data, fr.unpacked);
  const px = pixels(fr, data);
  if (!px) return null;
  return png.encode(fr.w, fr.h, (x, y) => { const i = (y * fr.w + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; });
}

module.exports = { parse, toPng, lzo1x };
