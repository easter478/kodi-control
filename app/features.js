// Live preview, keymaps, USB posters, M3U playlists and iftop install.
// make(ctx) returns IPC handlers. ctx gives the SSH/RPC helpers from main.js plus getters for KH, HAS and cfg.
const fs = require('fs');
const path = require('path');

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
const norm = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[-_.]?(poster|fanart|folder|cover|landscape|clearlogo|banner|thumb)$/, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const yearOf = s => (/\b(19|20)\d\d\b/.exec(s) || [])[0] || '';
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Remote button names Kodi accepts inside <remote>, and common actions (the list Keymap Editor offers, trimmed).
const REMOTE_KEYS = ['play', 'pause', 'stop', 'forward', 'reverse', 'skipplus', 'skipminus', 'left', 'right', 'up', 'down', 'select', 'back', 'menu', 'contentsmenu', 'rootmenu', 'info', 'title', 'display', 'subtitle', 'language', 'playlist', 'guide', 'record', 'red', 'green', 'yellow', 'blue', 'volumeplus', 'volumeminus', 'mute', 'channelplus', 'channelminus', 'pageplus', 'pageminus', 'power', 'myvideo', 'mymusic', 'mypictures', 'mytv', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'enter', 'xbox', 'teletext'];
// Kodi's XINPUT_IR_REMOTE_* button codes (xbmc/input/remote/IRRemote.h) to keymap tag names.
const IR = { 11: 'select', 166: 'up', 167: 'down', 168: 'right', 169: 'left', 195: 'info', 213: 'display', 216: 'back', 221: 'skipminus', 223: 'skipplus', 224: 'stop', 226: 'reverse', 227: 'forward', 229: 'title', 230: 'pause', 234: 'play', 247: 'menu',
  207: 'zero', 206: 'one', 205: 'two', 204: 'three', 203: 'four', 202: 'five', 201: 'six', 200: 'seven', 199: 'eight', 198: 'nine' };
const ACTIONS = [
  ['Playback', ['PlayPause', 'Stop', 'StepForward', 'StepBack', 'BigStepForward', 'BigStepBack', 'ChapterOrBigStepForward', 'ChapterOrBigStepBack', 'SkipNext', 'SkipPrevious', 'FastForward', 'Rewind', 'Playlist']],
  ['Video', ['OSD', 'ShowSubtitles', 'NextSubtitle', 'SubtitleDelay', 'AudioNextLanguage', 'AudioDelay', 'AspectRatio', 'ZoomIn', 'ZoomOut', 'CodecInfo', 'PlayerProcessInfo', 'PlayerDebug', 'ShowVideoMenu', 'NextScene', 'PreviousScene']],
  ['Navigation', ['Select', 'Back', 'ContextMenu', 'Info', 'FullScreen', 'PreviousMenu', 'Menu', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'FirstPage', 'LastPage', 'Queue', 'Delete', 'Rename']],
  ['Volume', ['VolumeUp', 'VolumeDown', 'Mute']],
  ['Windows', ['ActivateWindow(Home)', 'ActivateWindow(Videos,MovieTitles)', 'ActivateWindow(Videos,TvShowTitles)', 'ActivateWindow(TVChannels)', 'ActivateWindow(TVGuide)', 'ActivateWindow(Favourites)', 'ActivateWindow(Settings)', 'ActivateWindow(AddonBrowser)', 'ActivateWindow(FileManager)', 'ActivateWindow(SystemInfo)', 'ActivateWindow(ShutdownMenu)', 'ActivateWindow(EventLog)']],
  ['System', ['ReloadKeymaps', 'ReloadSkin()', 'TakeScreenshot', 'ToggleDebug', 'UpdateLibrary(video)', 'Notification(Kodi Control,Key works,3000)', 'noop']],
];
const WINDOWS = ['global', 'Home', 'FullscreenVideo', 'VideoOSD', 'VideoMenu', 'OSDVideoSettings', 'OSDAudioSettings', 'OSDSubtitleSettings', 'VideoBookmarks', 'SeekBar', 'Videos', 'MyVideoNav', 'MyVideoPlaylist', 'Music', 'MyMusicNav', 'MusicPlaylist', 'MusicOSD', 'Visualisation', 'Pictures', 'SlideShow', 'TVChannels', 'TVGuide', 'TVRecordings', 'TVTimers', 'TVSearch', 'FullscreenLiveTV', 'FullscreenRadio', 'RadioChannels', 'RadioGuide', 'PVROSDChannels', 'PVROSDGuide', 'Programs', 'AddonBrowser', 'Favourites', 'FileManager', 'Settings', 'SystemSettings', 'SystemInfo', 'Weather', 'Screensaver', 'ShutdownMenu', 'EventLog', 'VirtualKeyboard', 'NumericInput', 'ContextMenu', 'SelectDialog', 'YesNoDialog', 'OkDialog', 'ProgressDialog', 'DialogVideoInfo', 'DialogMusicInfo', 'DialogPVRInfo', 'FullscreenInfo', 'PlayerProcessInfo', 'PlayerControls', 'Teletext', 'Login', 'Startup'];

// Kodi only logs key presses with debug logging on. Lines we understand:
//   CInputManager::OnKey: up (0xf080) pressed, window 10000, action is Up      (Kodi 19-22)
//   OnKey: 61568 (0xf080) pressed, action is Up / HandleKey: ...                 (older)
//   Keyboard: scancode: 0x67, sym: 0x0111, unicode: 0x0000, modifier: 0x0       (raw keyboard)
//   LIRC: ... KEY_UP ...   /   CEC ... key pressed: up (1)                      (IR / HDMI-CEC remotes)
const timeOf = l => (/^\S+\s+(\d\d:\d\d:\d\d(?:\.\d+)?)/.exec(l) || [])[1] || '';
function parseKeyLine(l) {
  let m = /(?:OnKey|HandleKey)(?:\([^)]*\))?\s*:\s*(?:long-\s*)?([^\s(]+)\s*\((0x[0-9a-f]+)\)\s*pressed(?:,\s*window\s*(\d+))?(?:,\s*action is\s*([^\s,]+))?/i.exec(l);
  if (m) {
    const id = parseInt(m[2], 16);
    // keyboard keys carry the 0xF000 vkey/ascii/unicode flags; IR/CEC remote buttons are below 256; gamepads above
    const device = id >= 0xf000 ? 'keyboard' : id < 256 ? 'remote' : 'gamepad';
    const named = /^[a-z][a-z0-9_]*$/i.test(m[1]) ? m[1].toLowerCase() : '';
    const key = device === 'remote' ? (IR[id] || named) : named || String(id);
    return { kind: 'key', key, id: String(id), hex: m[2], device, window: m[3] || '', current: m[4] || '', long: /(?:OnKey|HandleKey)(?:\([^)]*\))?\s*:\s*long-/i.test(l) };
  }
  if ((m = /Keyboard:\s*scancode:\s*(0x[0-9a-f]+),\s*sym:\s*(0x[0-9a-f]+)(?:,\s*unicode:\s*(0x[0-9a-f]+))?/i.exec(l))) {
    const u = parseInt(m[3] || '0', 16);
    return { kind: 'raw', device: 'keyboard', key: u > 32 && u < 127 ? String.fromCharCode(u).toLowerCase() : '', id: String(parseInt(m[2], 16)), hex: m[2], window: '', current: '' };
  }
  if ((m = /LIRC.*?\b(KEY_[A-Z0-9_]+|BTN_[A-Z0-9_]+)/.exec(l))) return { kind: 'raw', device: 'remote', key: m[1].replace(/^KEY_/, '').toLowerCase(), id: '', hex: '', window: '', current: '' };
  if ((m = /CEC.*?key pressed:?\s*([a-z][\w ]*?)\s*\((\d+)\)/i.exec(l))) return { kind: 'raw', device: 'remote', key: m[1].trim().toLowerCase().replace(/\s+/g, ''), id: m[2], hex: '0x' + (+m[2]).toString(16), window: '', current: '' };
  return null;
}
const msOf = t => { const m = /(\d\d):(\d\d):(\d\d)(?:\.(\d+))?/.exec(t || ''); return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +((m[4] || '0') + '00').slice(0, 3) : NaN; };
function parseKeys(text) {
  const all = [];
  for (const l of String(text).split('\n')) { const k = parseKeyLine(l); if (k) all.push({ ...k, time: timeOf(l), line: l.trim().slice(0, 300) }); }
  // Each press logs "Keyboard: scancode ..." on key down AND key up around its one OnKey/HandleKey line. Those raw
  // lines carry SDL codes (sym 0x112), not Kodi's button code (0xf081) that Keymap Editor shows, so drop them when
  // a real key line is within 1.5 s; raw lines stay only for presses Kodi never mapped.
  const keyAt = all.filter(k => k.kind === 'key').map(k => msOf(k.time));
  return all.filter(k => k.kind === 'key' || k.device !== 'keyboard' || !keyAt.some(t => Math.abs(t - msOf(k.time)) <= 1500));
}
// Kodi keyboard button code (what Keymap Editor writes as <key id="61526">) to a keymap name: 0xF000 | mods | key.
const VK = { 0x08: 'backspace', 0x09: 'tab', 0x0d: 'return', 0x1b: 'escape', 0x20: 'space', 0x65: 'enter', 0x80: 'up', 0x81: 'down', 0x82: 'left', 0x83: 'right', 0x84: 'pageup', 0x85: 'pagedown', 0x86: 'insert', 0x87: 'delete', 0x88: 'home', 0x89: 'end',
  0x90: 'f1', 0x91: 'f2', 0x92: 'f3', 0x93: 'f4', 0x94: 'f5', 0x95: 'f6', 0x96: 'f7', 0x97: 'f8', 0x98: 'f9', 0x99: 'f10', 0x9a: 'f11', 0x9b: 'f12',
  0xb0: 'browser_back', 0xb1: 'browser_forward', 0xb2: 'browser_refresh', 0xb3: 'browser_stop', 0xb4: 'browser_search', 0xb5: 'browser_favorites', 0xb6: 'browser_home',
  0xb7: 'volume_mute', 0xb8: 'volume_down', 0xb9: 'volume_up', 0xba: 'next_track', 0xbb: 'prev_track', 0xbc: 'stop', 0xbd: 'play_pause_media', 0xbe: 'launch_mail', 0xbf: 'launch_media_select' };
function keyName(id) {
  const n = +id;
  if (!Number.isInteger(n) || n < 0xf000) return '';
  const mods = [n & 0x10000 && 'ctrl', n & 0x20000 && 'shift', (n & 0xc0000) && 'alt', n & 0x100000 && 'super'].filter(Boolean);
  const c = n & 0xff;
  const base = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) ? String.fromCharCode(c).toLowerCase() : VK[c] || '';
  return base ? [...mods, base].join('+') : '';
}

function make(ctx) {
  const { exec, sh, stream, q, rpc, builtin, cfg, saveCfg, kh, has, dialog, win, app, send = () => {} } = ctx;

  // ---------- live preview ----------
  // A fresh file name per shot means no "rm first" round trip; the poll loop deletes it after reading.
  let shotN = 0;
  async function screenshot() {
    const SHOT = `/tmp/kodicontrol-shot-${process.pid}-${++shotN % 1000}.png`;
    // Kodi 22 dropped the 'sync' flag (it logs an error each time); the IEND poll below waits for the file anyway
    await builtin(`TakeScreenshot(${SHOT})`);
    // done when the PNG ends with its IEND chunk (last 8 bytes = "IEND" + CRC); size-stable for 3 polls as a fallback
    const r = await exec(`i=0; last=-1; same=0; while [ $i -lt 160 ]; do s=$(stat -c %s ${SHOT} 2>/dev/null || echo 0); if [ "$s" -gt 0 ]; then [ "$(tail -c 8 ${SHOT} | head -c 4)" = IEND ] && break; if [ "$s" = "$last" ]; then same=$((same+1)); [ $same -ge 3 ] && break; else same=0; fi; fi; last=$s; i=$((i+1)); sleep 0.03; done; cat ${SHOT}; rm -f ${SHOT}`, { timeout: 12000 });
    if (r.out.length < 100) throw new Error('Kodi did not write a screenshot');
    return 'data:image/png;base64,' + r.out.toString('base64');
  }
  // ---------- live video layer (Amlogic) ----------
  // Kodi's screenshots hold only the GUI: on Amlogic the video sits on its own hardware plane. /dev/amvideocap0
  // hands out that plane's current frame (BGR, scaled to the size asked for) in ~15 ms, so a small Python loop on
  // the box streams frames: "KCVF" + width, height, byte count (big-endian) + zlib data; byte count 0 = no video.
  const VCAP_PY = String.raw`import os, sys, time, zlib, fcntl, struct
W, H, FPS = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
out = sys.stdout.buffer
end = time.time() + 3600
while time.time() < end:
    t = time.time()
    d = b''
    try:
        fd = os.open('/dev/amvideocap0', os.O_RDWR)
        try:
            fcntl.ioctl(fd, 0x40045602, W); fcntl.ioctl(fd, 0x40045603, H)
            d = os.read(fd, W * H * 3)
        finally:
            os.close(fd)
    except Exception:
        d = b''
    z = zlib.compress(d, 1) if len(d) == W * H * 3 else b''
    out.write(b'KCVF' + struct.pack('>III', W, H, len(z)) + z); out.flush()
    time.sleep(max(0.0, (1.0 / FPS if z else 0.5) - (time.time() - t)))
`;
  let vcap = null;
  function videoStart({ w = 640, fps = 10 } = {}) {
    videoStop();
    w = Math.max(160, Math.min(1920, Math.round(+w / 16) * 16)); const h = Math.round(w * 9 / 16 / 2) * 2;
    fps = Math.max(1, Math.min(30, +fps || 10));
    let buf = Buffer.alloc(0), frames = 0, t0 = Date.now(), dar = 0, darAt = 0;
    const me = vcap = {
      s: stream(`[ -e /dev/amvideocap0 ] || { echo 'No /dev/amvideocap0 on this box: the video layer needs an Amlogic device (CoreELEC)' >&2; exit 3; }; python3 - ${w} ${h} ${fps}`, {
        stdin: VCAP_PY,
        onData: d => {
          buf = buf.length ? Buffer.concat([buf, d]) : d;
          for (;;) {
            const i = buf.indexOf('KCVF');
            if (i < 0 || buf.length < i + 16) break;
            const n = buf.readUInt32BE(i + 12);
            if (buf.length < i + 16 + n) break;
            const fw = buf.readUInt32BE(i + 4), fh = buf.readUInt32BE(i + 8), z = buf.subarray(i + 16, i + 16 + n);
            buf = buf.subarray(i + 16 + n);
            if (vcap !== me) return;
            frames++;
            // the frame comes scaled to 16:9; the film's own shape (2.39:1 etc.) is asked from Kodi every few seconds
            if (Date.now() - darAt > 4000) { darAt = Date.now(); rpc('XBMC.GetInfoLabels', { labels: ['Player.Process(videodar)'] }).then(r => { dar = parseFloat(r['Player.Process(videodar)']) || 0; }).catch(() => {}); }
            let data = null;
            try { if (n) data = require('zlib').inflateSync(z); } catch {}
            send('preview:frame', { w: fw, h: fh, data, dar, fps: frames / Math.max(1, (Date.now() - t0) / 1000) });
          }
        },
        onClose: err => { if (vcap === me) { vcap = null; send('preview:frame', { stopped: true, error: err || '' }); } },
      }),
    };
    return { w, h, fps };
  }
  function videoStop() { if (vcap) { const v = vcap; vcap = null; v.s.close(); } return true; }

  const KEYS = { up: 'Input.Up', down: 'Input.Down', left: 'Input.Left', right: 'Input.Right', select: 'Input.Select', back: 'Input.Back', home: 'Input.Home', menu: 'Input.ContextMenu', info: 'Input.Info', osd: 'Input.ShowOSD' };
  async function remote(k) {
    if (KEYS[k]) return rpc(KEYS[k]);
    const act = { playpause: 'playpause', stop: 'stop', volup: 'volumeup', voldown: 'volumedown', mute: 'mute', fwd: 'stepforward', rew: 'stepback', ppi: 'playerprocessinfo', codec: 'codecinfo', fullscreen: 'fullscreen' }[k];
    if (!act) throw new Error('Unknown key ' + k);
    return rpc('Input.ExecuteAction', { action: act });
  }

  // ---------- keymaps ----------
  const KM_DIR = () => `${kh()}/userdata/keymaps`;
  const KM_FILE = () => `${KM_DIR()}/kodicontrol.xml`;
  function keymapXml(list) {
    const byWin = {};
    for (const b of list) {
      if (!b.key || !b.action) continue;
      ((byWin[b.window || 'global'] ||= {})[b.device || 'keyboard'] ||= []).push(b);
    }
    const tag = b => {
      const mods = [b.mod, b.longpress && 'longpress'].filter(Boolean).join(',');
      const attrs = mods ? ` mod="${xmlEsc(mods)}"` : '';
      if (/^\d+$/.test(b.key) || /^0x[0-9a-f]+$/i.test(b.key)) return `      <key id="${b.key}"${attrs}>${xmlEsc(b.action)}</key>`;
      const name = b.key.toLowerCase().replace(/[^a-z0-9_]/g, '');
      return `      <${name}${attrs}>${xmlEsc(b.action)}</${name}>`;
    };
    let x = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Written by Kodi Control. Edit in the app; changes here are overwritten. -->\n<keymap>\n';
    for (const [w, devs] of Object.entries(byWin)) {
      x += `  <${w}>\n`;
      for (const [d, binds] of Object.entries(devs)) x += `    <${d}>\n${binds.map(tag).join('\n')}\n    </${d}>\n`;
      x += `  </${w}>\n`;
    }
    return x + '</keymap>\n';
  }
  function parseKeymap(xml, file) {
    const out = [];
    const body = xml.replace(/<!--[\s\S]*?-->/g, '');
    for (const w of body.matchAll(/<(\w+)>\s*([\s\S]*?)<\/\1>/g)) {
      if (w[1] === 'keymap') return parseKeymap(w[2], file);
      for (const d of w[2].matchAll(/<(keyboard|remote|gamepad|mouse|joystick|universalremote)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
        for (const k of d[2].matchAll(/<(\w+)([^>]*)>([^<]*)<\/\1>/g)) {
          const id = (/\bid="([^"]+)"/.exec(k[2]) || [])[1];
          const mods = ((/\bmod="([^"]+)"/.exec(k[2]) || [])[1] || '').split(',').map(s => s.trim()).filter(Boolean);
          out.push({ window: w[1], device: d[1], key: k[1] === 'key' && id ? id : k[1], mod: mods.filter(x => x !== 'longpress').join(','), longpress: mods.includes('longpress'), action: k[3].trim() || 'noop', file });
        }
      }
    }
    return out;
  }
  async function keymapList() {
    // userdata/keymaps (this app's file, the Keymap Editor add-on's gen.xml, any others) and Kodi's own
    // system keymaps, which load first: Kodi reads system then user files, each folder in name order
    const raw = await sh(`cd ${q(KM_DIR())} 2>/dev/null && for f in *.xml; do [ -f "$f" ] && { echo "==FILE $f"; cat "$f"; }; done; ` +
      `for d in /usr/share/kodi/system/keymaps /usr/local/share/kodi/system/keymaps /usr/lib/kodi/system/keymaps; do [ -d "$d" ] && { cd "$d" && for f in *.xml; do [ -f "$f" ] && { echo "==SYS $f"; cat "$f"; }; done; break; }; done; true`, { timeout: 30000 });
    const files = [];
    for (const part of raw.split(/==(?=FILE |SYS )/).slice(1)) {
      const sys = part.startsWith('SYS '), i = part.indexOf('\n'), name = part.slice(sys ? 4 : 5, i).trim();
      files.push({ name, system: sys, binds: parseKeymap(part.slice(i + 1), name).map(b => ({ ...b, label: keyName(b.key), system: sys })) });
    }
    // the Keymap Editor add-on's own action and window lists, read from the box (falls back to the short built-in list)
    const ke = await keymapEditorLists().catch(() => null);
    const full = ke ? ke.actions : ACTIONS.map(([c, a]) => [c, a.map(x => [x, ''])]);
    const windows = ke ? [...new Set([...ke.windows.map(w => w[0]), ...WINDOWS.map(w => w.toLowerCase())])] : WINDOWS;
    return { files, ours: cfg().keymaps || [], actions: full.map(([c, a]) => [c, a.map(x => x[0])]), actionsFull: full, windowNames: ke ? ke.windows : [], fromEditor: !!ke, windows, remoteKeys: REMOTE_KEYS, dir: KM_DIR() };
  }
  async function keymapEditorLists() {
    const dir = `${kh()}/addons/script.keymap/resources`;
    const raw = await sh(`cat ${q(dir + '/lib/actions.py')} && echo ==PO && cat ${q(dir + '/language/resource.language.en_gb/strings.po')}`);
    const [py, po = ''] = raw.split('==PO');
    if (!/_actions\s*=/.test(py)) throw new Error('no Keymap Editor');
    const tr = {};
    for (const m of po.matchAll(/msgctxt\s+"#(\d+)"\s*\r?\nmsgid\s+"((?:[^"\\]|\\.)*)"/g)) tr[m[1]] = m[2].replace(/\\"/g, '"');
    const pairs = body => [...body.matchAll(/"([^"]+)"\s*,\s*tr\((\d+)\)/g)].map(m => [m[1].trim(), tr[m[2]] || m[1].trim()]);
    const block = name => { const m = new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\n\\]').exec(py); return m ? m[1] : ''; };
    const actions = [];
    for (const m of block('_actions').matchAll(/\["([^"]+)",\s*\[([\s\S]*?)\]\]/g)) actions.push([m[1], pairs(m[2])]);
    const windows = pairs(block('_windows'));
    const openable = [...pairs(block('_activate_window')), ...windows.slice(1)];
    actions.push(['Windows', openable.map(([w, n]) => [`activatewindow(${w})`, 'Open ' + n]).sort((a, b) => a[1].localeCompare(b[1]))]);
    const ad = [];
    for (const type of ['xbmc.python.pluginsource', 'xbmc.python.script']) {
      const r = await rpc('Addons.GetAddons', { type, properties: ['name', 'enabled'] }).catch(() => ({}));
      for (const a of r.addons || []) if (a.enabled) ad.push([`runaddon(${a.addonid})`, 'Launch ' + a.name]);
    }
    actions.push(['Add-ons', ad.sort((a, b) => a[1].localeCompare(b[1]))]);
    return actions.some(([, a]) => a.length) ? { actions, windows } : Promise.reject(new Error('empty'));
  }
  async function keymapSave(list) {
    cfg().keymaps = list; saveCfg();
    await exec(`mkdir -p ${q(KM_DIR())} && cat > ${q(KM_FILE())}`, { stdin: keymapXml(list) });
    await builtin('Action(reloadkeymaps)');
    return { file: KM_FILE(), count: list.length };
  }
  // ---------- USB posters ----------
  async function usbList() {
    const raw = await sh(`for d in /var/media/* /media/* /run/media/*/* /mnt/* /storage/usb* ; do [ -d "$d" ] && grep -q " $d " /proc/mounts && echo "$d|$(df -h "$d" | awk 'NR==2{print $2" "$4}')"; done; true`);
    return raw.split('\n').filter(Boolean).map(l => { const [p, sz] = l.split('|'); const [size, free] = (sz || '').split(' '); return { path: p, size, free }; });
  }
  async function usbScan(dir) {
    const imgs = (await sh(`find ${q(dir)} -maxdepth 4 -type f \\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \\) 2>/dev/null | head -5000`, { timeout: 60000 })).split('\n').filter(Boolean);
    const [mv, tv] = await Promise.all([
      rpc('VideoLibrary.GetMovies', { properties: ['title', 'year', 'art', 'file'] }).catch(() => ({})),
      rpc('VideoLibrary.GetTVShows', { properties: ['title', 'year', 'art', 'file'] }).catch(() => ({})),
    ]);
    const lib = [...(mv.movies || []).map(m => ({ kind: 'movie', id: m.movieid, ...m })), ...(tv.tvshows || []).map(t => ({ kind: 'tvshow', id: t.tvshowid, ...t }))];
    const index = new Map();
    for (const it of lib) {
      const n = norm(it.title);
      index.set(n + '|' + (it.year || ''), it);
      if (!index.has(n)) index.set(n, it);
      const folder = norm(path.posix.basename(path.posix.dirname(it.file || '')));
      if (folder && !index.has(folder)) index.set(folder, it);
    }
    const matches = [], unmatched = [];
    for (const img of imgs) {
      const file = path.posix.basename(img), parent = path.posix.basename(path.posix.dirname(img));
      const type = /fanart|landscape|backdrop/i.test(file) ? 'fanart' : /clearlogo|logo/i.test(file) ? 'clearlogo' : 'poster';
      const generic = /^(poster|folder|cover|fanart|landscape|clearlogo|logo)\.\w+$/i.test(file);
      const name = generic ? parent : file;
      const n = norm(name.replace(/\(?\b(19|20)\d\d\b\)?/, '')), y = yearOf(name);
      const it = (y && index.get(n + '|' + y)) || index.get(n) || index.get(norm(name));
      if (it) matches.push({ img, type, kind: it.kind, id: it.id, title: it.title, year: it.year, current: (it.art || {})[type] || '' });
      else unmatched.push(img);
    }
    return { matches, unmatched: unmatched.slice(0, 200), images: imgs.length, library: lib.length };
  }
  async function usbApply({ matches, copy }) {
    const dest = `${kh()}/userdata/kodicontrol-art`;
    if (copy) await exec(`mkdir -p ${q(dest)}`);
    let ok = 0; const fail = [];
    for (const m of matches) {
      try {
        let src = m.img;
        if (copy) {
          src = `${dest}/${m.kind}-${m.id}-${m.type}${path.posix.extname(m.img).toLowerCase()}`;
          await exec(`cp -f ${q(m.img)} ${q(src)}`);
        }
        // remember the artwork Kodi had before the first change, for Media → Undo artwork changes
        const undo = (cfg().artUndo ||= []);
        if (!undo.some(u => u.kind === m.kind && u.id === m.id && u.type === m.type)) {
          const d = m.kind === 'movie' ? await rpc('VideoLibrary.GetMovieDetails', { movieid: m.id, properties: ['art'] }).then(r => r.moviedetails).catch(() => null) : await rpc('VideoLibrary.GetTVShowDetails', { tvshowid: m.id, properties: ['art'] }).then(r => r.tvshowdetails).catch(() => null);
          if (d) { undo.push({ kind: m.kind, id: m.id, type: m.type, old: (d.art || {})[m.type] || '' }); saveCfg(); }
        }
        const art = { [m.type]: src };
        if (m.kind === 'movie') await rpc('VideoLibrary.SetMovieDetails', { movieid: m.id, art });
        else await rpc('VideoLibrary.SetTVShowDetails', { tvshowid: m.id, art });
        ok++;
      } catch (e) { fail.push(`${m.title}: ${e.message}`); }
    }
    return { ok, fail, copied: !!copy, dest };
  }

  // ---------- M3U / IPTV Simple ----------
  const IPTV = () => `${kh()}/userdata/iptv`;
  const PVR = () => `${kh()}/userdata/addon_data/pvr.iptvsimple`;
  const pcDir = () => { const d = path.join(cfg().backupDir || app.getPath('documents'), 'm3u'); fs.mkdirSync(d, { recursive: true }); return d; };
  const safeName = s => (String(s || 'playlist').replace(/\.m3u8?$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'playlist') + '.m3u';
  async function settingsFile() {
    const f = (await sh(`cd ${q(PVR())} 2>/dev/null && ls instance-settings-*.xml settings.xml 2>/dev/null | head -1`)).trim();
    return f ? `${PVR()}/${f}` : '';
  }
  function getSetting(xml, id) {
    const m = new RegExp(`<setting id="${id}"[^>]*?(?:/>|>([^<]*)</setting>)`).exec(xml);
    return m ? (m[1] || '').replace(/&amp;/g, '&') : '';
  }
  function setSetting(xml, id, val) {
    const tag = `<setting id="${id}">${xmlEsc(val)}</setting>`;
    const re = new RegExp(`<setting id="${id}"[^>]*?(?:/>|>[^<]*</setting>)`);
    return re.test(xml) ? xml.replace(re, tag) : xml.replace(/<\/settings>/, `    ${tag}\n</settings>`);
  }
  async function m3uStatus() {
    const installed = (await sh(`[ -d ${q(kh() + '/addons/pvr.iptvsimple')} ] || ls /usr/lib/kodi/addons /usr/share/kodi/addons 2>/dev/null | grep -q pvr.iptvsimple && echo y`)).trim() === 'y';
    const files = (await sh(`cd ${q(IPTV())} 2>/dev/null && for f in *.m3u *.m3u8; do [ -f "$f" ] && echo "$f|$(stat -c '%s|%Y' "$f")|$(grep -c '#EXTINF' "$f")"; done; true`))
      .split('\n').filter(Boolean).map(l => { const [name, size, mtime, channels] = l.split('|'); return { name, size: +size, mtime: +mtime * 1000, channels: +channels }; });
    const backups = (await sh(`ls -1t ${q(IPTV() + '/backup')} 2>/dev/null | head -30`)).split('\n').filter(Boolean);
    const sf = await settingsFile();
    const xml = sf ? await sh(`cat ${q(sf)}`) : '';
    const g = id => getSetting(xml, id);
    return {
      installed, dir: IPTV(), files, backups, settingsFile: sf, pcDir: pcDir(),
      settings: { pathType: g('m3uPathType'), path: g('m3uPath'), url: g('m3uUrl'), cache: g('m3uCache'), startNum: g('startNum'), refreshMode: g('m3uRefreshMode'), refreshMins: g('m3uRefreshIntervalMins'), epgUrl: g('epgUrl'), epgPathType: g('epgPathType'), logoFromEpg: g('logoFromEpg') },
    };
  }
  async function push(name, text) {
    await exec(`mkdir -p ${q(IPTV())} && cat > ${q(IPTV() + '/' + name)}`, { stdin: text });
    return `${IPTV()}/${name}`;
  }
  async function m3uDownload({ url, name }) {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('Enter an http(s) playlist URL');
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const text = await res.text();
    if (!/^﻿?#EXTM3U/.test(text.trimStart())) throw new Error('That URL did not return an M3U playlist (no #EXTM3U header)');
    const file = safeName(name || new URL(url).pathname.split('/').pop());
    const local = path.join(pcDir(), file);
    fs.writeFileSync(local, text);
    return { local, file, channels: (text.match(/#EXTINF/g) || []).length, size: Buffer.byteLength(text) };
  }
  async function m3uPush({ local, name }) {
    const text = fs.readFileSync(local, 'utf8');
    if (!/^﻿?#EXTM3U/.test(text.trimStart())) throw new Error('Not an M3U playlist (no #EXTM3U header)');
    const file = safeName(name || path.basename(local));
    return { remote: await push(file, text), file, channels: (text.match(/#EXTINF/g) || []).length };
  }
  // A playlist already somewhere on the box (USB stick, Downloads, an add-on folder): copied into the iptv folder.
  async function m3uImport(src) {
    src = String(src || '');
    const head = (await sh(`head -c 512 ${q(src)} 2>/dev/null`)).trimStart();
    if (!/^﻿?#EXTM3U/.test(head)) throw new Error('Not an M3U playlist (no #EXTM3U header)');
    const file = safeName(path.posix.basename(src));
    const dst = `${IPTV()}/${file}`;
    if (dst !== src) await exec(`mkdir -p ${q(IPTV())} && cp -f ${q(src)} ${q(dst)}`);
    const channels = +(await sh(`grep -c '#EXTINF' ${q(dst)}`)).trim() || 0;
    return { remote: dst, file, channels };
  }
  async function m3uBackup(name) {
    const src = `${IPTV()}/${name}`, dst = `${IPTV()}/backup/${name.replace(/\.m3u8?$/i, '')}-${stamp()}.m3u`;
    await exec(`mkdir -p ${q(IPTV() + '/backup')} && cp -f ${q(src)} ${q(dst)}`);
    const data = (await exec(`cat ${q(src)}`, { timeout: 60000 })).out;
    const local = path.join(pcDir(), path.posix.basename(dst));
    fs.writeFileSync(local, data);
    return { remote: dst, local };
  }
  async function m3uRestore(backup) {
    const name = backup.replace(/-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.m3u$/, '') + '.m3u';
    await exec(`cp -f ${q(IPTV() + '/backup/' + backup)} ${q(IPTV() + '/' + name)}`);
    return name;
  }
  async function m3uDelete(name) { await exec(`rm -f ${q(IPTV() + '/' + path.posix.basename(name))}`); return true; }
  async function m3uApply(s) {
    let sf = await settingsFile();
    if (!sf) { sf = `${PVR()}/instance-settings-1.xml`; await exec(`mkdir -p ${q(PVR())} && printf '%s' ${q('<settings version="2">\n</settings>\n')} > ${q(sf)}`); }
    let xml = await sh(`cat ${q(sf)}`);
    const set = (id, v) => { if (v !== undefined && v !== null) xml = setSetting(xml, id, String(v)); };
    if (s.source === 'url') { set('m3uPathType', 1); set('m3uUrl', s.url); }
    else { set('m3uPathType', 0); set('m3uPath', `${IPTV()}/${s.file}`); }
    set('m3uCache', s.cache ? 'true' : 'false');
    set('startNum', s.startNum || 1);
    set('m3uRefreshMode', s.refreshMins ? 1 : 0);
    if (s.refreshMins) set('m3uRefreshIntervalMins', s.refreshMins);
    if (s.epgUrl !== undefined) { set('epgPathType', 1); set('epgUrl', s.epgUrl); }
    if (s.logoFromEpg !== undefined) set('logoFromEpg', s.logoFromEpg);
    await exec(`cp -f ${q(sf)} ${q(sf + '.kcbak')} 2>/dev/null; [ -f ${q(sf + '.kcorig')} ] || cp -f ${q(sf)} ${q(sf + '.kcorig')} 2>/dev/null; cat > ${q(sf)}`, { stdin: xml });
    // Disable and re-enable the add-on so it re-reads its settings and reloads channels.
    let restarted = false;
    try {
      await rpc('Addons.SetAddonEnabled', { addonid: 'pvr.iptvsimple', enabled: false });
      await new Promise(r => setTimeout(r, 1500));
      await rpc('Addons.SetAddonEnabled', { addonid: 'pvr.iptvsimple', enabled: true });
      restarted = true;
    } catch {}
    return { settingsFile: sf, restarted };
  }

  // ---------- iftop ----------
  async function iftopInstall() {
    const found = (await sh(`command -v iftop || ls ${q(kh() + '/addons/virtual.system-tools/bin/iftop')} 2>/dev/null`)).trim();
    if (found) return { done: true, path: found, how: 'already installed' };
    const os = await sh(`cat /etc/os-release 2>/dev/null; for c in opkg apt-get dnf yum pacman apk zypper; do command -v $c >/dev/null 2>&1 && echo "PM=$c"; done`);
    if (/coreelec|libreelec|osmc-?elec/i.test(os) && !/PM=(apt-get)/.test(os)) {
      await builtin('InstallAddon(virtual.system-tools)');
      return { done: false, how: 'System Tools add-on', note: 'Kodi is asking on the TV to install "System Tools". Confirm there; iftop is included and Kodi Control finds it automatically.' };
    }
    const pm = (/PM=(\S+)/.exec(os) || [])[1];
    const cmd = { opkg: 'opkg update && opkg install iftop', 'apt-get': 'DEBIAN_FRONTEND=noninteractive apt-get install -y iftop', dnf: 'dnf install -y iftop', yum: 'yum install -y iftop', pacman: 'pacman -S --noconfirm iftop', apk: 'apk add iftop', zypper: 'zypper -n install iftop' }[pm];
    if (!cmd) throw new Error('No supported package manager found on the device');
    const r = await exec(`${cmd} 2>&1 || sudo -n sh -c ${q(cmd)} 2>&1`, { timeout: 300000 });
    const ok = (await sh('command -v iftop')).trim();
    if (!ok) throw new Error(`Install failed (${pm}): ${r.out.toString().slice(-400)}`);
    return { done: true, path: ok, how: pm };
  }

  const pickM3u = async () => (await dialog.showOpenDialog(win(), { title: 'Playlist', properties: ['openFile'], filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }] })).filePaths[0] || '';

  // ---------- pull files ----------
  // Shell only uses stat/find/tail/head/cat, which GNU and busybox (CoreELEC/LibreELEC) both have. No grep flags, no find -printf.
  async function filesList(dir) {
    dir = String(dir || kh()).replace(/\/+$/, '') || '/';
    const raw = await exec(`cd ${q(dir)} || exit 3; for f in * .[!.]*; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ -d "$f" ]; then echo "d|0|$f"; else echo "f|$(stat -c %s "$f" 2>/dev/null || echo 0)|$f"; fi; done`);
    if (raw.code === 3) throw new Error('Cannot open ' + dir);
    const items = raw.out.toString().split('\n').filter(Boolean).map(l => { const [t, s, ...n] = l.split('|'); return { dir: t === 'd', size: +s || 0, name: n.join('|') }; })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { dir, items };
  }
  async function filesFind({ dir, ext, depth = 6 } = {}) {
    dir = String(dir || kh()).replace(/\/+$/, '') || '/';
    const exts = String(ext || '').split(/[\s,;]+/).map(e => e.replace(/^\*?\.?/, '').replace(/[^A-Za-z0-9_-]/g, '')).filter(Boolean);
    if (!exts.length) throw new Error('Type at least one extension, e.g. xml or log,txt');
    const names = exts.map(e => `-iname ${q('*.' + e)}`).join(' -o ');
    const raw = await sh(`find ${q(dir)} -maxdepth ${Math.max(1, Math.min(20, +depth || 6))} -type f \\( ${names} \\) 2>/dev/null | head -3000 | while IFS= read -r f; do echo "$(stat -c %s "$f" 2>/dev/null || echo 0)|$f"; done`, { timeout: 90000 });
    const items = raw.split('\n').filter(Boolean).map(l => { const i = l.indexOf('|'); return { size: +l.slice(0, i) || 0, path: l.slice(i + 1) }; });
    return { dir, exts, items, capped: items.length >= 3000 };
  }
  // paths are absolute on the box; with base, sub-folders under it are kept in the destination
  async function filesPull({ paths, base } = {}) {
    if (!paths || !paths.length) throw new Error('Nothing selected');
    const r = await dialog.showOpenDialog(win(), { title: 'Pull files into this folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const dest = r.filePaths[0];
    const b = base ? String(base).replace(/\/+$/, '') + '/' : '';
    let bytes = 0, done = 0; const failed = [];
    for (const p of paths) {
      const rel = (b && p.startsWith(b) ? p.slice(b.length) : path.posix.basename(p)).split('/').filter(x => x && x !== '..' && x !== '.');
      const out = path.join(dest, ...rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const ws = fs.createWriteStream(out);
      try {
        const res = await exec(`cat ${q(p)}`, { timeout: 0, onData: c => { ws.write(c); bytes += c.length; } });
        await new Promise(ok => ws.end(ok));
        if (res.code) { failed.push(p + ': ' + (res.err.trim() || 'read error')); fs.rmSync(out, { force: true }); } else done++;
      } catch (e) { ws.destroy(); failed.push(p + ': ' + e.message); }
      send('progress', { op: 'pull', done: done + failed.length, total: paths.length, bytes });
    }
    return { dest, done, failed, bytes };
  }

  // ---------- key presses (Learn + live "last key" monitor) ----------
  // Log is read with stat + tail -c and parsed here, so it works without GNU grep (busybox grep has no -a/--line-buffered).
  const KODI_LOG = () => `${kh()}/temp/kodi.log`;
  const logSize = async () => +(await sh(`stat -c %s ${q(KODI_LOG())} 2>/dev/null || echo 0`)).trim() || 0;
  // bytes added to kodi.log since off (last 64 KB at most); a smaller file means Kodi restarted and rotated it
  async function logSince(off) {
    const size = await logSize();
    if (size < off) off = 0;
    if (size === off) return { off, text: '' };
    const from = Math.max(off, size - 65536);
    const text = (await exec(`tail -c +${from + 1} ${q(KODI_LOG())} 2>/dev/null | head -c ${size - from}`)).out.toString('utf8');
    return { off: size, text };
  }
  let debugWas = null, debugUsers = 0;
  async function debugOn() {
    if (debugUsers++ > 0) return;
    // if the read fails assume off so it still gets switched on (the old code assumed on and so never logged a key)
    debugWas = (await rpc('Settings.GetSettingValue', { setting: 'debug.showloginfo' }).catch(() => ({ value: false }))).value === true;
    if (!debugWas) await rpc('Settings.SetSettingValue', { setting: 'debug.showloginfo', value: true }).catch(() => builtin('ToggleDebug'));
  }
  async function debugOff() {
    if (--debugUsers > 0) return;
    debugUsers = 0;
    if (debugWas === false) await rpc('Settings.SetSettingValue', { setting: 'debug.showloginfo', value: false }).catch(() => {});
    debugWas = null;
  }
  async function keymapLearn() {
    await debugOn();
    try {
      let off = await logSize(), raw = null;
      const until = Date.now() + 12000;
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 200));
        const r = await logSince(off); off = r.off;
        const ks = parseKeys(r.text);
        const k = ks.find(x => x.kind === 'key');
        if (k) return k;
        raw = ks.pop() || raw;
      }
      // a raw line means the key reached Kodi but no OnKey line followed (an unmapped CEC/LIRC key); still usable
      if (raw && raw.key) return raw;
      throw new Error(`No key press seen in 12 s. Press a key on the remote or keyboard while learning. (Watched ${KODI_LOG()}.)`);
    } finally { await debugOff(); }
  }
  // Live "last key" monitor for the Keymaps page: watch(true) → {off}, poll(off) → {off, keys}, watch(false).
  let watching = false;
  async function keysWatch(on) {
    if (on && !watching) { watching = true; await debugOn(); }
    else if (on) await rpc('Settings.SetSettingValue', { setting: 'debug.showloginfo', value: true }).catch(() => {}); // after a reconnect
    if (!on && watching) { watching = false; await debugOff(); }
    return { off: on ? await logSize() : 0, log: KODI_LOG() };
  }
  async function keysPoll(off) {
    const r = await logSince(+off || 0);
    return { off: r.off, keys: parseKeys(r.text) };
  }

  // ---------- Keymap Editor add-on (script.keymap) settings ----------
  const KMA = 'script.keymap';
  const KMA_FILE = () => `${kh()}/userdata/addon_data/${KMA}/settings.xml`;
  async function kmAddonGet() {
    let info = null;
    try { info = (await rpc('Addons.GetAddonDetails', { addonid: KMA, properties: ['enabled', 'version', 'broken'] })).addon; } catch {}
    if (!info) return { installed: false };
    const xml = await sh(`cat ${q(KMA_FILE())} 2>/dev/null`);
    const g = (id, d) => { const v = getSetting(xml, id); return v === '' && !new RegExp(`id="${id}"`).test(xml) ? d : v; };
    return {
      installed: true, enabled: info.enabled, version: info.version, broken: info.broken, file: KMA_FILE(),
      settings: { longpress: g('longpress', 'false') === 'true', multifile: g('enable_multifile', 'false') === 'true', filename: g('keymap_editor_filename', 'gen') || 'gen' },
    };
  }
  async function kmAddonSet(s) {
    const name = String(s.filename || 'gen').replace(/\.xml$/i, '').trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error('File name: letters, numbers, dot, dash or underscore only');
    if (name.toLowerCase() === 'kodicontrol') throw new Error('kodicontrol is the file this app writes. Pick another name for the Keymap Editor.');
    let xml = await sh(`cat ${q(KMA_FILE())} 2>/dev/null`);
    if (!/<settings/.test(xml)) xml = '<settings version="2">\n</settings>\n';
    xml = setSetting(xml, 'longpress', s.longpress ? 'true' : 'false');
    xml = setSetting(xml, 'enable_multifile', s.multifile ? 'true' : 'false');
    xml = setSetting(xml, 'keymap_editor_filename', name);
    await exec(`mkdir -p ${q(path.posix.dirname(KMA_FILE()))} && { cp -f ${q(KMA_FILE())} ${q(KMA_FILE() + '.kcbak')} 2>/dev/null; cat > ${q(KMA_FILE())}; }`, { stdin: xml });
    // Kodi caches add-on settings in memory; disable/enable makes it re-read the file.
    let reloaded = false;
    try {
      await rpc('Addons.SetAddonEnabled', { addonid: KMA, enabled: false });
      await new Promise(r => setTimeout(r, 800));
      await rpc('Addons.SetAddonEnabled', { addonid: KMA, enabled: true });
      reloaded = true;
    } catch {}
    return { ...(await kmAddonGet()), reloaded };
  }
  async function kmAddonOpen(what) {
    if (what === 'enable') { await rpc('Addons.SetAddonEnabled', { addonid: KMA, enabled: true }); return kmAddonGet(); }
    if (what === 'install') return builtin(`InstallAddon(${KMA})`);
    return builtin(what === 'run' ? `RunAddon(${KMA})` : `Addon.OpenSettings(${KMA})`);
  }

  return {
    'kmaddon:get': kmAddonGet,
    'kmaddon:set': kmAddonSet,
    'kmaddon:open': kmAddonOpen,
    'preview:shot': screenshot,
    'preview:videoStart': videoStart,
    'preview:videoStop': videoStop,
    'preview:key': remote,
    'keymap:list': keymapList,
    'keymap:save': keymapSave,
    'keymap:learn': keymapLearn,
    'keymap:preview': list => keymapXml(list),
    'usb:list': usbList,
    'usb:scan': usbScan,
    'usb:apply': usbApply,
    'm3u:status': m3uStatus,
    'm3u:download': m3uDownload,
    'm3u:push': m3uPush,
    'm3u:import': m3uImport,
    'm3u:backup': m3uBackup,
    'm3u:restore': m3uRestore,
    'm3u:delete': m3uDelete,
    'm3u:apply': m3uApply,
    'pick:m3u': pickM3u,
    'iftop:install': iftopInstall,
    'files:list': filesList,
    'files:find': filesFind,
    'files:pull': filesPull,
    'keys:watch': keysWatch,
    'keys:poll': keysPoll,
  };
}

module.exports = { make, parseKeys, parseKeyLine, keyName };
