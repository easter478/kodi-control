// Draws the app icon and packs build/icon.ico (16–256 px) plus build/icon.png and app/icon.png.
// Run with: npx electron scripts/icon.js
// Small sizes show the mark only; 128 px and up add the name, which is unreadable any smaller.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');

const svg = (size, withName) => {
  const mark = withName
    ? `<g transform="translate(128 98)">` // screen + play, raised to leave room for the name
    : `<g transform="translate(128 128) scale(1.32)">`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4F46E5"/><stop offset=".55" stop-color="#7C3AED"/><stop offset="1" stop-color="#C026D3"/></linearGradient>
    <linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="pl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#E0E7FF"/></linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#bg)"/>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#sh)"/>
  ${mark}
    <rect x="-62" y="-44" width="124" height="80" rx="16" fill="none" stroke="#fff" stroke-width="10"/>
    <path d="M-12 -22 L22 -4 L-12 14 Z" fill="url(#pl)" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>
    <path d="M-26 52 H26" stroke="#fff" stroke-width="10" stroke-linecap="round"/>
    <circle cx="48" cy="-58" r="0" fill="#fff"/>
  </g>
  ${withName ? `<text x="128" y="206" text-anchor="middle" font-family="Segoe UI Variable Display, Segoe UI, sans-serif" font-weight="700" font-size="33" letter-spacing="-.4" fill="#fff">Kodi Control</text>` : ''}
</svg>`;
};

function ico(images) { // ICO with PNG entries (Vista+), sizes ascending
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let off = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += png.length;
  });
  return Buffer.concat([head, ...images.map(x => x.png)]);
}

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const w = new BrowserWindow({ width: 300, height: 300, show: false });
  await w.loadURL('data:text/html,<html><body></body></html>');
  // rasterise on a canvas in the page: the SVG text renders with the system's Segoe UI
  const draw = async (size, withName) => {
    const js = 'new Promise((ok, bad) => { const img = new Image(); const n = ' + size + ';'
      + ' img.onload = () => { const c = document.createElement("canvas"); c.width = c.height = n; const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, n, n); ok(c.toDataURL("image/png")); };'
      + ' img.onerror = () => bad(new Error("svg failed"));'
      + ' img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(' + JSON.stringify(svg(size, withName)) + '); })';
    const url = await w.webContents.executeJavaScript(js);
    return Buffer.from(url.split(',')[1], 'base64');
  };
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const s of sizes) images.push({ size: s, png: await draw(s, s >= 128) });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(images));
  const big = await draw(512, true);
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), big);
  fs.writeFileSync(path.join(root, 'app', 'icon.png'), images.find(x => x.size === 256).png);
  fs.writeFileSync(path.join(root, 'app', 'logo.png'), await draw(64, false)); // sidebar: mark only, the name is written next to it
  fs.writeFileSync(path.join(root, 'build', 'icon.svg'), svg(256, true));
  fs.writeFileSync(path.join(root, 'build', 'icon-mark.svg'), svg(256, false));
  console.log('icons written');
  app.exit(0);
});
