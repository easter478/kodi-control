const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const { Client } = require('ssh2');
const { parseTar, buildTar } = require('./tar');
const png = require('./png');
const xbt = require('./xbt');
const skin = require('./skin');
const features = require('./features');
const helpersvc = require('./helpersvc');

// ---------- config ----------
const CFG = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { conn: {}, skins: {}, saved: [], backupDir: '' };
function loadCfg() { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG(), 'utf8')) }; } catch {} }
function saveCfg() { fs.mkdirSync(path.dirname(CFG()), { recursive: true }); fs.writeFileSync(CFG(), JSON.stringify(cfg, null, 2)); }
const seal = s => (s && safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s || '');
const unseal = s => (s && s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s || '');
function defaultBackupDir() {
  return fs.existsSync('D:\\') ? 'D:\\KodiBackups' : path.join(app.getPath('documents'), 'KodiBackups');
}

// ---------- ssh ----------
let ssh = null, KH = '', HAS = {}, win = null, IFTOP = 'iftop';
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

function connect(c) {
  return new Promise((resolve, reject) => {
    if (ssh) { try { ssh.end(); } catch {} ssh = null; }
    const cl = new Client();
    const opts = { host: c.host, port: +c.port || 22, username: c.user || 'root', readyTimeout: 10000, keepaliveInterval: 15000 };
    if (c.auth === 'key') {
      try { opts.privateKey = fs.readFileSync(c.keyPath); } catch (e) { return reject(new Error('Cannot read key file: ' + c.keyPath)); }
      if (c.passphrase) opts.passphrase = unseal(c.passphrase);
    } else {
      opts.password = unseal(c.password);
      opts.tryKeyboard = true;
      cl.on('keyboard-interactive', (n, i, l, p, finish) => finish(p.map(() => opts.password)));
    }
    cl.on('ready', () => { ssh = cl; resolve(); });
    cl.on('error', e => { if (ssh !== cl) reject(e); else send('conn', { ok: false, error: e.message }); });
    cl.on('close', () => { if (ssh === cl) { ssh = null; send('conn', { ok: false, error: 'Connection closed' }); } });
    cl.connect(opts);
  });
}

// Run a shell command. Returns { code, out (Buffer), err }.
function exec(cmd, { stdin, timeout = 30000, onData } = {}) {
  return new Promise((resolve, reject) => {
    if (!ssh) return reject(new Error('Not connected'));
    ssh.exec(cmd, (e, st) => {
      if (e) return reject(e);
      const out = [], err = [];
      const t = timeout ? setTimeout(() => { try { st.close(); } catch {} reject(new Error('Timed out: ' + cmd.slice(0, 60))); }, timeout) : null;
      st.on('data', d => { if (onData) onData(d); else out.push(d); });
      st.stderr.on('data', d => err.push(d));
      st.on('close', code => { if (t) clearTimeout(t); resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }); });
      if (stdin != null) st.end(stdin); else st.end();
    });
  });
}
const sh = async (cmd, o) => (await exec(cmd, o)).out.toString();
// A long-running command whose output streams in (live video frames). Returns { close } straight away.
function stream(cmd, { stdin, onData, onClose } = {}) {
  if (!ssh) throw new Error('Not connected');
  let ch = null, closed = false;
  ssh.exec(cmd, (e, st) => {
    if (e) { closed = true; return onClose && onClose(e.message); }
    ch = st;
    const err = [];
    st.on('data', d => onData && onData(d));
    st.stderr.on('data', d => err.push(d));
    st.on('close', () => { closed = true; onClose && onClose(Buffer.concat(err).toString().trim()); });
    if (closed) { try { st.close(); } catch {} return; }
    if (stdin != null) st.end(stdin); else st.end();
  });
  return { close: () => { closed = true; try { ch && ch.close(); } catch {} } };
}

async function probe() {
  KH = (await sh('for d in /storage/.kodi "$HOME/.kodi" /root/.kodi /home/*/.kodi; do [ -d "$d/userdata" ] && echo "$d" && break; done')).trim();
  const has = await sh('for c in kodi-send iftop curl nc systemctl tar; do command -v $c >/dev/null 2>&1 && echo $c; done');
  HAS = Object.fromEntries(has.split(/\s+/).filter(Boolean).map(c => [c, true]));
  IFTOP = 'iftop';
  if (!HAS.iftop && KH && (await sh(`[ -x ${q(KH + '/addons/virtual.system-tools/bin/iftop')} ] && echo y`)).trim() === 'y') { HAS.iftop = true; IFTOP = `${KH}/addons/virtual.system-tools/bin/iftop`; }
  if (!KH) throw new Error('Connected, but no Kodi profile folder (.kodi/userdata) was found on this device');
}

// ---------- JSON-RPC ----------
let rpcId = 1, rpcMode = null;
function splitJson(s) {
  const objs = []; let depth = 0, start = -1, str = false, escp = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') { if (!depth++) start = i; }
    else if (c === '}' && depth && !--depth) { try { objs.push(JSON.parse(s.slice(start, i + 1))); } catch {} }
  }
  return objs;
}
// One JSON-RPC socket to Kodi's TCP port (9090) tunnelled through the SSH connection and kept open: a call
// is a write plus the reply (tens of ms), where starting nc over SSH per call took about a second.
let rpcSock = null, rpcSockP = null, rpcBuf = '';
const rpcWait = new Map();
function rpcTunnel() {
  if (rpcSock) return Promise.resolve(rpcSock);
  if (rpcSockP) return rpcSockP;
  rpcSockP = new Promise((resolve, reject) => {
    if (!ssh) return reject(new Error('Not connected'));
    const conn = ssh;
    ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', +cfg.conn.rpcTcpPort || 9090, (e, st) => {
      rpcSockP = null;
      if (e) return reject(e);
      rpcSock = st; rpcBuf = '';
      st.on('data', d => {
        rpcBuf += d.toString();
        // pull out complete top-level objects; keep a partial one for the next chunk
        let depth = 0, start = -1, str = false, escp = false, cut = 0;
        for (let i = 0; i < rpcBuf.length; i++) {
          const c = rpcBuf[i];
          if (str) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') str = false; continue; }
          if (c === '"') str = true;
          else if (c === '{') { if (!depth++) start = i; }
          else if (c === '}' && depth && !--depth) {
            cut = i + 1;
            try {
              const o = JSON.parse(rpcBuf.slice(start, i + 1));
              // notifications (no id): the keyboard opening / closing goes to Live view's text box
              if (o.method && o.id === undefined) { if (/^Input\.OnInput(Requested|Finished)$/.test(o.method) && win && !win.isDestroyed()) win.webContents.send('kodi:input', { open: o.method === 'Input.OnInputRequested', ...(o.params && o.params.data || {}) }); }
              else { const w = rpcWait.get(o.id); if (w) { rpcWait.delete(o.id); w(o); } }
            } catch {}
          }
        }
        rpcBuf = rpcBuf.slice(cut);
      });
      const drop = () => { if (rpcSock === st) rpcSock = null; for (const [id, w] of rpcWait) { rpcWait.delete(id); w(null); } };
      st.on('close', drop); st.on('error', drop);
      conn.once('close', drop);
      resolve(st);
    });
  });
  return rpcSockP;
}
// keep the tunnel open while connected, whatever the dashboard route: Kodi only sends its notifications
// (the on-screen keyboard opening) down an open JSON-RPC TCP connection
setInterval(() => { if (ssh && !rpcSock && !rpcSockP) rpcTunnel().catch(() => {}); }, 5000);
function rpcTunnelCall(id, body, ms = 8000) {
  return rpcTunnel().then(st => new Promise(resolve => {
    const t = setTimeout(() => { rpcWait.delete(id); resolve(null); }, ms);
    rpcWait.set(id, o => { clearTimeout(t); resolve(o); });
    st.write(body);
  }));
}
// Kodi's web server straight from this PC (Connection → "Use Kodi's web server"): no SSH round trip at all.
async function rpcDirect(id, body) {
  const c = cfg.conn;
  const headers = { 'Content-Type': 'application/json' };
  if (c.rpcUser) headers.Authorization = 'Basic ' + Buffer.from(c.rpcUser + ':' + unseal(c.rpcPass)).toString('base64');
  const r = await fetch(`http://${c.host}:${+c.rpcPort || 8080}/jsonrpc`, { method: 'POST', headers, body, signal: AbortSignal.timeout(6000) });
  if (r.status === 401) throw new Error('Kodi web server asked for a user name and password (set them in Connection)');
  return splitJson(await r.text()).find(o => o.id === id) || null;
}
async function rpc(method, params = {}, ms = 8000) {
  const id = rpcId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const c = cfg.conn;
  if (helperOn()) {
    const r = await helperFetch('/rpc', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }).then(t => splitJson(t)[0] || null).catch(() => null);
    if (r) { if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result; }
  }
  if (c.via === 'web') {
    const r = await rpcDirect(id, body).catch(e => { if (/user name/.test(e.message)) throw e; return null; });
    if (r) { rpcMode = 'web'; if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result; }
  }
  if (rpcMode !== 'http' && rpcMode !== 'tcp') {
    const r = await rpcTunnelCall(id, body, ms).catch(() => null);
    if (r) {
      rpcMode = 'tunnel';
      if (r.error) throw new Error(`${method}: ${r.error.message}${r.error.data ? ' (' + JSON.stringify(r.error.data).slice(0, 200) + ')' : ''}`);
      return r.result;
    }
    if (rpcMode === 'tunnel') rpcMode = null; // socket died: next call reconnects, this one falls through
  }
  const http = async () => {
    if (!HAS.curl) return null;
    const auth = c.rpcUser ? `-u ${q(c.rpcUser + ':' + unseal(c.rpcPass))}` : '';
    const out = await sh(`curl -s -m 6 ${auth} -H 'Content-Type: application/json' -d @- http://127.0.0.1:${+c.rpcPort || 8080}/jsonrpc`, { stdin: body, timeout: 10000 });
    return splitJson(out).find(o => o.id === id) || null;
  };
  const tcp = async () => {
    if (!HAS.nc) return null;
    const out = await sh('{ cat; sleep 0.8; } | nc -w 2 127.0.0.1 9090', { stdin: body, timeout: 10000 });
    return splitJson(out).find(o => o.id === id) || null;
  };
  const order = rpcMode === 'tcp' ? [tcp, http] : [http, tcp];
  for (const f of order) {
    const r = await f().catch(() => null);
    if (r) {
      rpcMode = f === tcp ? 'tcp' : 'http';
      if (r.error) throw new Error(`${method}: ${r.error.message}${r.error.data ? ' (' + JSON.stringify(r.error.data).slice(0, 200) + ')' : ''}`);
      return r.result;
    }
  }
  throw new Error('Kodi JSON-RPC did not answer. Enable Settings → Services → Control → "Allow remote control via HTTP" (and set the user/password here), or "Allow remote control from applications on this system".');
}

// Builtins: kodi-send if present, else our helper add-on.
async function builtin(cmd) {
  if (HAS['kodi-send']) {
    const r = await exec(`kodi-send -a ${q(cmd)}`);
    if (r.code === 0) return 'kodi-send';
  }
  await rpc('Addons.ExecuteAddon', { addonid: 'script.kodicontrol', params: ['builtin', cmd], wait: false });
  return 'helper add-on';
}

// ---------- helper add-on ----------
const HELPER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<addon id="script.kodicontrol" name="Kodi Control helper" version="1.2.0" provider-name="Kodi Control">
  <requires><import addon="xbmc.python" version="3.0.0"/></requires>
  <extension point="xbmc.python.script" library="default.py"/>
  <extension point="xbmc.service" library="service.py" start="login"/>
  <extension point="xbmc.addon.metadata">
    <summary lang="en_GB">Zoom presets, seek preview and helpers used by Kodi Control</summary>
    <platform>all</platform>
  </extension>
</addon>
`;
// zoom presets as the user sees them (0 = off, 0.20 = Kodi zoom 1.2); edited on the OSD page, baked into the helper
const zoomList = () => { const z = (Array.isArray(cfg.zoom) ? cfg.zoom : [0, 0.2, 0.35]).map(Number).filter(v => isFinite(v) && v >= 0 && v <= 1); return z.length ? z : [0]; };
const zoomName = v => v === 0 ? '0' : v.toFixed(2);
const helperPy = () => `import sys, json, xbmc, xbmcgui
PRESETS = [${zoomList().map(v => (1 + v).toFixed(3)).join(', ')}]
NAMES = [${zoomList().map(v => `'${zoomName(v)}'`).join(', ')}]
home = xbmcgui.Window(10000)

def rpc(method, params):
    return json.loads(xbmc.executeJSONRPC(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))).get('result')

def current():
    # nearest preset to the zoom actually in use (Kodi resets it per video, so a stored counter drifts)
    try:
        z = float((rpc("Player.GetViewMode", {}) or {}).get('zoom', 1.0))
    except Exception:
        z = 1.0
    return min(range(len(PRESETS)), key=lambda i: abs(PRESETS[i] - z))

def setzoom(i):
    if PRESETS[i] == 1.0:
        rpc("Player.SetViewMode", {"viewmode": "normal"})
    else:
        rpc("Player.SetViewMode", {"viewmode": {"zoom": PRESETS[i]}})
    home.setProperty('kodicontrol.zoom', str(i))
    xbmcgui.Dialog().notification('Zoom', NAMES[i], xbmcgui.NOTIFICATION_INFO, 1200, False)

args = sys.argv[1:]
cmd = args[0] if args else 'zoom'
if cmd == 'zoom':
    setzoom((current() + 1) % len(PRESETS))
elif cmd.startswith('zoom='):
    setzoom(max(0, min(len(PRESETS) - 1, int(cmd[5:]))))
elif cmd == 'builtin' and len(args) > 1:
    xbmc.executebuiltin(','.join(args[1:]))
`;
// Seek preview service: while Kodi is seeking (Player.Seeking, during the seek delay) it shows the frame at
// Player.SeekTime. Frames come from ffmpeg (CoreELEC's "FFmpeg Tools" add-on) at fixed steps, cached in
// special://temp/kcseek/<file hash>/, the asked-for one first, then the ones around where you're watching.
const SEEK_PY = String.raw`import os, re, json, time, shutil, hashlib, threading, subprocess
import xbmc, xbmcgui, xbmcvfs
home = xbmcgui.Window(10000)
CFG = xbmcvfs.translatePath('special://profile/addon_data/script.kodicontrol/seek.json')
DISK = xbmcvfs.translatePath('special://temp/kcseek')
RAM = '/tmp/kcseek'
TMP = DISK
SLOTS = 40
def conf():
    try:
        with open(CFG) as f: return json.load(f)
    except Exception: return {}
def ffmpeg():
    for p in (xbmcvfs.translatePath('special://home/addons/tools.ffmpeg-tools/bin/ffmpeg'), shutil.which('ffmpeg') or ''):
        if p and os.path.exists(p): return p
    return ''
def secs(s):
    try:
        n = 0
        for part in s.strip().split(':'): n = n * 60 + int(part)
        return n
    except Exception: return -1
PROXY = {'port': 0, 'files': {}}
def proxy():
    # ffmpeg here can't open smb:// or nfs://, Kodi can: a tiny HTTP server on 127.0.0.1 serves the file
    # through xbmcvfs with Range support, so ffmpeg seeks in it without any share password leaving Kodi
    if PROXY['port']: return PROXY['port']
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            path = PROXY['files'].get(self.path.strip('/'))
            if not path: self.send_error(404); return
            f = xbmcvfs.File(path)
            try:
                size = f.size()
                m = re.match(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
                a = int(m.group(1)) if m else 0
                b = int(m.group(2)) if m and m.group(2) else size - 1
                self.send_response(206 if m else 200)
                self.send_header('Accept-Ranges', 'bytes'); self.send_header('Content-Length', str(b - a + 1))
                if m: self.send_header('Content-Range', 'bytes %d-%d/%d' % (a, b, size))
                self.end_headers()
                f.seek(a, 0); left = b - a + 1
                while left > 0:
                    d = f.readBytes(min(262144, left))
                    if not d: break
                    self.wfile.write(d); left -= len(d)
            except Exception: pass
            finally: f.close()
    srv = ThreadingHTTPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    PROXY['port'] = srv.server_address[1]
    return PROXY['port']
def source(f):
    # Kodi's "url|Header=value&..." form -> ffmpeg input + headers; local paths and http(s) go straight in,
    # anything else Kodi can open (smb://, nfs://, ...) goes through the local proxy
    url, _, hdr = f.partition('|')
    if url.startswith('/') or re.match(r'https?://', url):
        h = ''.join('%s: %s\r\n' % tuple(x.split('=', 1)) for x in hdr.split('&') if '=' in x)
        return url, h
    if re.match(r'(smb|nfs|ftp|sftp|dav|davs|upnp|special)://', url) and xbmcvfs.exists(url):
        tok = hashlib.md5(url.encode('utf8', 'replace')).hexdigest()
        PROXY['files'][tok] = url
        return 'http://127.0.0.1:%d/%s' % (proxy(), tok), ''
    return None, ''
SUBS = {'hidden': False}
def clear():
    home.clearProperty('kodicontrol.seekthumb'); home.clearProperty('kodicontrol.seekslot')
    if SUBS['hidden']:
        SUBS['hidden'] = False
        try: xbmc.Player().showSubtitles(True)
        except Exception: pass
def hideSubs(c):
    if SUBS['hidden'] or not c.get('hidesubs', True): return
    if xbmc.getCondVisibility('VideoPlayer.SubtitlesEnabled'):
        try: xbmc.Player().showSubtitles(False); SUBS['hidden'] = True
        except Exception: pass

class Frames(threading.Thread):
    def __init__(self, url, hdr, key, step, width):
        threading.Thread.__init__(self); self.daemon = True
        self.url, self.hdr, self.step, self.width = url, hdr, step, width
        self.height = width * 9 // 16 // 2 * 2
        self.dir = os.path.join(TMP, key); os.makedirs(self.dir, exist_ok=True)
        self.want, self.around, self.dur, self.stop, self.bad = None, 0, 0, False, 0
        self.remote = not url.startswith('/')
        self.ev = threading.Event()
    def path(self, b): return os.path.join(self.dir, '%06d.jpg' % b)
    def make(self, b):
        p = self.path(b)
        if os.path.exists(p) or self.bad > 5: return
        cmd = ['nice', '-n', '15', ffmpeg(), '-nostdin', '-loglevel', 'error']
        if self.hdr: cmd += ['-headers', self.hdr]
        cmd += ['-ss', str(b), '-noaccurate_seek', '-i', self.url, '-frames:v', '1', '-an', '-sn', '-threads', '1', '-vf', 'scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d' % (self.width, self.height, self.width, self.height), '-q:v', '5', '-y', p + '.tmp.jpg']
        try:
            subprocess.run(cmd, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if os.path.exists(p + '.tmp.jpg') and os.path.getsize(p + '.tmp.jpg') > 0: os.replace(p + '.tmp.jpg', p); self.bad = 0
            else: self.bad += 1
        except Exception: self.bad += 1
    def run(self):
        while not self.stop:
            if self.want is not None:
                b, self.want = self.want, None
                self.make(b); continue
            # prefetch outward from where you are: the whole file when local, 10 minutes each way when streamed
            span = 600 if self.remote else max(self.dur, 600)
            todo = None
            for d in range(0, int(span) + self.step, self.step):
                for b in (self.around + d, self.around - d):
                    b = b // self.step * self.step
                    if 0 <= b and (not self.dur or b < self.dur) and not os.path.exists(self.path(b)): todo = b; break
                if todo is not None: break
            if todo is None or self.bad > 5: self.ev.wait(2); self.ev.clear(); continue
            self.make(todo)

def tidy(keep):
    try:
        ds = sorted((os.path.join(TMP, d) for d in os.listdir(TMP)), key=os.path.getmtime, reverse=True)
        for d in ds[3:]:
            if os.path.basename(d) != keep: shutil.rmtree(d, True)
    except Exception: pass

mon, player = xbmc.Monitor(), xbmc.Player()
gen, cur, last, cfgAt, c = None, None, 0, 0, {}
while not mon.abortRequested():
    now = time.time()
    if now - cfgAt > 5: c, cfgAt = conf(), now
    on = c.get('on') and player.isPlayingVideo()
    if not on:
        if gen:
            gen.stop = True; gen = None; cur = None; clear()
            if TMP == RAM: shutil.rmtree(RAM, True)
        mon.waitForAbort(1); continue
    want = RAM if c.get('ram') else DISK
    if want != TMP:
        if gen: gen.stop = True; gen = None; cur = None; clear()
        shutil.rmtree(TMP, True); TMP = want
    try: f = player.getPlayingFile()
    except Exception: f = ''
    if f != cur:
        cur = f
        if gen: gen.stop = True; gen = None
        clear()
        url, hdr = source(f)
        if url and ffmpeg():
            key = hashlib.md5(('v2:%d:' % int(c.get('width', 384)) + f).encode('utf8', 'replace')).hexdigest()[:16]
            gen = Frames(url, hdr, key, max(2, int(c.get('step', 10))), max(160, int(c.get('width', 384))))
            try: gen.dur = int(player.getTotalTime()); gen.around = int(player.getTime())
            except Exception: pass
            tidy(key); gen.start()
    if not gen: mon.waitForAbort(0.5); continue
    try: gen.dur = int(player.getTotalTime()); gen.around = int(player.getTime())
    except Exception: pass
    if xbmc.getCondVisibility('Player.Seeking'):
        t = secs(xbmc.getInfoLabel('Player.SeekTime'))
        if t >= 0:
            b = t // gen.step * gen.step
            if not os.path.exists(gen.path(b)): gen.want = b; gen.ev.set()
            # show the asked-for frame, or the nearest one made so far while it is being made
            for d in range(0, 900, gen.step):
                hit = [x for x in (b - d, b + d) if x >= 0 and os.path.exists(gen.path(x))]
                if hit: home.setProperty('kodicontrol.seekthumb', gen.path(hit[0])); hideSubs(c); break
            if gen.dur: home.setProperty('kodicontrol.seekslot', str(max(0, min(SLOTS, int(round(t * SLOTS / float(gen.dur)))))))
            last = now
    elif last and now - last > 0.4:
        clear(); last = 0
    mon.waitForAbort(0.1)
clear()
`;
async function ensureHelper() {
  const dir = `${KH}/addons/script.kodicontrol`;
  const files = { 'addon.xml': HELPER_XML, 'default.py': helperPy(), 'service.py': SEEK_PY };
  const fresh = (await sh(`t=/tmp/kch.$; cat ${Object.keys(files).map(f => q(dir + '/' + f)).join(' ')} > $t 2>/dev/null; cmp -s $t - && echo same; rm -f $t`, { stdin: Object.values(files).join('') })).trim() !== 'same';
  if (fresh) await exec(`mkdir -p ${q(dir)} && tar -C ${q(dir)} -xf -`, { stdin: buildTar(files) });
  if (!(cfg.installed ||= []).includes('script.kodicontrol')) { cfg.installed.push('script.kodicontrol'); saveCfg(); }
  let enabled = false;
  try {
    const d = await rpc('Addons.GetAddonDetails', { addonid: 'script.kodicontrol', properties: ['enabled'] });
    enabled = d.addon.enabled;
  } catch {}
  if (!enabled) {
    if (HAS['kodi-send']) {
      await exec(`kodi-send -a 'UpdateLocalAddons'`);
      await new Promise(r => setTimeout(r, 2500));
    }
    try { await rpc('Addons.SetAddonEnabled', { addonid: 'script.kodicontrol', enabled: true }); enabled = true; } catch {}
  } else if (fresh) {
    // new files in an enabled add-on: re-read addon.xml and restart its service (off and on again)
    if (HAS['kodi-send']) { await exec(`kodi-send -a 'UpdateLocalAddons'`); await new Promise(r => setTimeout(r, 2000)); }
    try { await rpc('Addons.SetAddonEnabled', { addonid: 'script.kodicontrol', enabled: false }); await new Promise(r => setTimeout(r, 800)); await rpc('Addons.SetAddonEnabled', { addonid: 'script.kodicontrol', enabled: true }); } catch {}
  }
  return enabled ? 'Helper add-on ready' : 'Helper add-on copied, but Kodi has not picked it up yet: restart Kodi, then enable "Kodi Control helper" under My add-ons → Program add-ons';
}

// ---------- add-ons: what is running and what it costs ----------
// Python and binary add-ons run inside kodi.bin as threads, so Linux can't give each one its own memory figure.
// What it can give: CPU per thread (two samples 1 s apart), the threads each add-on owns (from the T:<thread>
// ids in kodi.log, and thread names), the resident size of an add-on's own mapped files (binary .so, skin
// Textures.xbt) from /proc/<kodi>/smaps, and real RSS for any add-on that runs as its own process.
const ADDONS_PY = String.raw`import os, re, sys, time, json
kh, ids = sys.argv[1], sys.argv[2].split(',')
P = None
for p in os.listdir('/proc'):
    if p.isdigit():
        try:
            if open('/proc/%s/comm' % p).read().strip() in ('kodi.bin', 'kodi-gbm', 'kodi-x11', 'kodi-wayland', 'kodi'):
                P = p; break
        except Exception: pass
out = {}
res = {'pid': P, 'addons': out}
def A(i): return out.setdefault(i, {'threads': [], 'cpu': 0.0, 'time': 0.0, 'mem': 0, 'proc': 0, 'how': []})
def ticks(t):
    try:
        f = open('/proc/%s/task/%s/stat' % (P, t)).read().rsplit(')', 1)[1].split()
        return int(f[11]) + int(f[12])
    except Exception: return 0
if P:
    tasks = os.listdir('/proc/%s/task' % P)
    t0 = dict((t, ticks(t)) for t in tasks); time.sleep(1); t1 = dict((t, ticks(t)) for t in tasks)
    comm = {}
    for t in tasks:
        try: comm[t] = open('/proc/%s/task/%s/comm' % (P, t)).read().strip()
        except Exception: comm[t] = ''
    try: res['rss'] = int(re.search(r'VmRSS:\s+(\d+)', open('/proc/%s/status' % P).read()).group(1)) * 1024
    except Exception: pass
    ID = re.compile(r'(?<![\w.])((?:plugin|script|service|skin|weather|metadata|inputstream|pvr|context|resource|peripheral|audiodecoder|imagedecoder|screensaver|visualization|vfs|game|repository)\.[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*)')
    live, owner = set(tasks), {}
    try:
        for l in open(kh + '/temp/kodi.log', errors='replace'):
            m = re.search(r' T:(\d+) ', l)
            if not m or m.group(1) == P or m.group(1) not in live or 'Found addon' in l: continue
            for mm in ID.finditer(l[m.end():]):
                a = mm.group(1)
                if a in ids: owner.setdefault(m.group(1), []).append(a)
    except Exception: pass
    for t in tasks:
        a = None
        cand = owner.get(t, [])
        best = [x for x in cand if not x.startswith(('script.module.', 'resource.', 'repository.'))]
        if best: a = best[0]
        elif cand: a = cand[0]
        else:
            c = comm.get(t, '')
            if len(c) >= 6 and c != 'kodi.bin' and ID.match(c + ('x' if c.endswith('.') else '')):
                hit = [i for i in ids if i.startswith(c) or (len(c) >= 15 and i[:15] == c)]
                if hit: a = hit[0]
        if a:
            o = A(a); o['threads'].append(comm.get(t, '')); o['cpu'] += t1.get(t, 0) - t0.get(t, 0); o['time'] += t1.get(t, 0) / 100.0
            if 'thread' not in o['how']: o['how'].append('thread')
    cur = None
    try:
        for l in open('/proc/%s/smaps' % P):
            if l[:1] in '0123456789abcdef' and '-' in l.split(' ', 1)[0]:
                m = re.search(r'/addons/([^/]+)/', l); cur = m.group(1) if m else None
            elif cur and l.startswith('Rss:'):
                o = A(cur); o['mem'] += int(l.split()[1]) * 1024
                if 'loaded' not in o['how']: o['how'].append('loaded')
    except Exception: pass
me = str(os.getpid())
for p in os.listdir('/proc'):
    if not p.isdigit() or p in (P, me): continue
    try:
        c = open('/proc/%s/cmdline' % p, 'rb').read().replace(b'\0', b' ').decode('utf8', 'replace')
        m = re.search(r'/addons/([^/ ]+)/', c)
        if not m: continue
        o = A(m.group(1)); o['proc'] += int(re.search(r'VmRSS:\s+(\d+)', open('/proc/%s/status' % p).read()).group(1)) * 1024
        if 'process' not in o['how']: o['how'].append('process')
    except Exception: pass
print(json.dumps(res))
`;
async function addonsList() {
  const r = await rpc('Addons.GetAddons', { properties: ['name', 'version', 'enabled', 'broken', 'dependencies', 'path'] }, 20000);
  const all = (r.addons || []).filter(a => a.type !== 'kodi.resource.language' || a.enabled);
  const ids = all.map(a => a.addonid);
  const run = JSON.parse((await sh(`python3 - ${q(KH)} ${q(ids.join(','))}`, { stdin: ADDONS_PY, timeout: 30000 })).trim() || '{}');
  const need = {};
  for (const a of all) for (const d of a.dependencies || []) if (!d.optional) (need[d.addonid] ||= []).push(a.addonid);
  const enabledServices = all.filter(a => a.enabled && a.type === 'xbmc.service').map(a => a.addonid);
  const list = all.map(a => {
    const x = run.addons?.[a.addonid];
    const running = !!x || (a.enabled && a.type === 'xbmc.service');
    return { id: a.addonid, name: a.name, version: a.version, type: a.type, enabled: a.enabled, broken: a.broken || false, system: /^\/usr\//.test(a.path || ''),
      running, service: a.type === 'xbmc.service', threads: x ? x.threads.length : 0, threadNames: x ? [...new Set(x.threads)].join(', ') : '',
      cpu: x ? Math.round(x.cpu * 10) / 10 : 0, cpuTime: x ? Math.round(x.time) : 0, mem: x ? x.mem : 0, proc: x ? x.proc : 0, how: x ? x.how : (running ? ['service'] : []),
      neededBy: (need[a.addonid] || []).filter(i => all.find(b => b.addonid === i && b.enabled)) };
  });
  return { list, kodiRss: run.rss || 0, enabledServices: enabledServices.length };
}
async function addonEnable({ id, enabled }) {
  // first change through the app: remember how it was, so Add-ons → Undo can put it back
  cfg.addonOrig ||= {};
  if (!(id in cfg.addonOrig)) { const was = await rpc('Addons.GetAddonDetails', { addonid: id, properties: ['enabled'] }).then(r => r.addon.enabled).catch(() => null); if (was !== null && was !== !!enabled) cfg.addonOrig[id] = was; }
  else if (cfg.addonOrig[id] === !!enabled) delete cfg.addonOrig[id];
  saveCfg();
  await rpc('Addons.SetAddonEnabled', { addonid: id, enabled: !!enabled }, 15000);
  const d = await rpc('Addons.GetAddonDetails', { addonid: id, properties: ['enabled'] });
  return d.addon.enabled;
}

// ---------- undo: everything Kodi Control changes on the box can be put back ----------
// Add-ons the app installs (or can install). Removing one: disable it, delete its folder, its settings and the
// downloaded zip, then let Kodi re-scan. Only these ids can be removed from the app.
const APP_ADDONS = {
  'script.kodicontrol': { name: 'Kodi Control helper', why: 'zoom preset button, seek preview service', heavy: 'Seek preview runs ffmpeg on the box while you watch' },
  'service.kodicontrol': { name: 'Kodi Control stats helper', why: 'fast dashboard route (HTTP on your network)', heavy: '' },
  'tools.ffmpeg-tools': { name: 'FFmpeg Tools (CoreELEC repository)', why: 'makes the seek preview frames', heavy: '65 MB on the eMMC; decodes video frames in the background during playback' },
  'virtual.system-tools': { name: 'System Tools (CoreELEC repository)', why: 'iftop for "Streaming from"', heavy: '' },
};
const SEEK_DEFAULT = { delay: 750, steps: [-10, 10] };
async function undoStatus() {
  const ids = Object.keys(APP_ADDONS);
  const there = (await sh(`for a in ${ids.join(' ')}; do [ -d ${q(KH + '/addons')}/$a ] && echo $a; done; true`)).split('\n').filter(Boolean);
  const det = {};
  for (const id of there) det[id] = await rpc('Addons.GetAddonDetails', { addonid: id, properties: ['enabled', 'version'] }).then(r => r.addon).catch(() => ({}));
  const [delay, steps] = await Promise.all(['videoplayer.seekdelay', 'videoplayer.seeksteps'].map(s => rpc('Settings.GetSettingValue', { setting: s }).then(r => r.value).catch(() => null)));
  const orig = cfg.seekOrig || SEEK_DEFAULT;
  const files = (await sh(`[ -f ${q(KH + '/userdata/keymaps/kodicontrol.xml')} ] && echo km; ls ${q(KH + '/userdata/addon_data/pvr.iptvsimple')}/*.kcorig 2>/dev/null | head -1 | sed 's/^/iptv /'; du -sk ${q(KH + '/temp/kcseek')} 2>/dev/null | cut -f1 | sed 's/^/cache /'; true`)).split('\n');
  const { skins, current } = await listSkins().catch(() => ({ skins: [], current: '' }));
  const patched = await patchedSkins().catch(() => []);
  return {
    addons: ids.map(id => ({ id, ...APP_ADDONS[id], installed: there.includes(id), enabled: there.includes(id) ? det[id].enabled !== false : false, version: (det[id] || {}).version, byApp: (cfg.installed || []).includes(id), copy: fs.existsSync(addonCopy(id)) })),
    skins: skins.filter(x => patched.includes(x.id) || hasTweaks(cfg.skins[x.id]) || (cfg.seek && cfg.seek.on && x.path.startsWith(KH))).map(x => ({ id: x.id, name: x.name, patched: patched.includes(x.id), active: x.id === current, tweaks: hasTweaks(cfg.skins[x.id]) })),
    seekOn: !!(cfg.seek && cfg.seek.on), seekRam: !!(cfg.seek && cfg.seek.ram),
    seek: { delay, steps, orig, changed: delay != null && (delay !== orig.delay || JSON.stringify(steps) !== JSON.stringify(orig.steps)) },
    keymapFile: files.includes('km'), iptvOrig: files.some(l => l.startsWith('iptv ')), seekCacheKb: +((files.find(l => l.startsWith('cache ')) || '').slice(6)) || 0,
    addonToggles: Object.entries(cfg.addonOrig || {}).map(([id, was]) => ({ id, was })), artChanges: (cfg.artUndo || []).length,
  };
}
const addonCopy = id => path.join(app.getPath('userData'), 'addon-copies', id + '.tar');
async function removeAddon(id) {
  if (!APP_ADDONS[id]) throw new Error('Kodi Control only removes the add-ons it installs');
  // add-ons from a repository are kept on this PC first, so switching them back on needs no download
  if (!['script.kodicontrol', 'service.kodicontrol'].includes(id)) {
    const r = await exec(`tar -C ${q(KH + '/addons')} -cf - ${id}`, { timeout: 300000 });
    if (r.code || r.out.length < 1024) throw new Error('Could not keep a copy of ' + id + ' on this PC, so it was not removed');
    fs.mkdirSync(path.dirname(addonCopy(id)), { recursive: true }); fs.writeFileSync(addonCopy(id), r.out);
  }
  await rpc('Addons.SetAddonEnabled', { addonid: id, enabled: false }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  const extra = id === 'script.kodicontrol' ? ` ${q(KH + '/temp/kcseek')}` : '';
  await exec(`rm -rf ${q(KH + '/addons/' + id)} ${q(KH + '/userdata/addon_data/' + id)}${extra}; rm -f ${q(KH + '/addons/packages')}/${id}-*.zip; true`);
  await builtin('UpdateLocalAddons').catch(() => {});
  cfg.installed = (cfg.installed || []).filter(x => x !== id);
  if (id === 'service.kodicontrol') { if (cfg.conn.via === 'helper') cfg.conn.via = ''; delete cfg.conn.helperToken; rpcMode = null; }
  saveCfg();
  return `${APP_ADDONS[id].name} removed from the box${fs.existsSync(addonCopy(id)) ? ' (a copy is kept in Kodi Control, so switching it on puts it back without a download)' : ' (Kodi Control can put it back any time)'}`;
}
// the switch next to each add-on: enable / disable, or put it on the box from the app (or its repository) first
async function setAppAddon({ id, enabled }) {
  if (!APP_ADDONS[id]) throw new Error('Not a Kodi Control add-on');
  const there = (await sh(`[ -d ${q(KH + '/addons/' + id)} ] && echo y; true`)).trim() === 'y';
  if (there) {
    await rpc('Addons.SetAddonEnabled', { addonid: id, enabled: !!enabled }, 15000);
    return `${APP_ADDONS[id].name} ${enabled ? 'enabled' : 'disabled'}`;
  }
  if (!enabled) return `${APP_ADDONS[id].name} is not on the box`;
  if (id === 'script.kodicontrol') return ensureHelper();
  if (id === 'service.kodicontrol') return (await installStatsHelper({ port: cfg.conn.helperPort || 8099 })).note;
  if (fs.existsSync(addonCopy(id))) {
    await exec(`tar -C ${q(KH + '/addons')} -xf -`, { stdin: fs.readFileSync(addonCopy(id)), timeout: 300000 });
    await builtin('UpdateLocalAddons').catch(() => {});
    await new Promise(r => setTimeout(r, 2500));
    await rpc('Addons.SetAddonEnabled', { addonid: id, enabled: true }, 15000).catch(() => {});
    if (!(cfg.installed ||= []).includes(id)) cfg.installed.push(id); saveCfg();
    return `${APP_ADDONS[id].name} put back from the copy kept in Kodi Control`;
  }
  await builtin(`InstallAddon(${id})`);
  if (!(cfg.installed ||= []).includes(id)) cfg.installed.push(id); saveCfg();
  return `Kodi is asking on the TV to install "${APP_ADDONS[id].name}". Confirm there.`;
}
async function setSkinPatched({ id, on }) {
  const { current } = await listSkins();
  const r = on ? await applySkin(id, cfg.skins[id] || {}, { reload: id === current }) : await revertSkin(id, { reload: id === current });
  return r.report.map(x => x.text).join(' · ');
}
async function seekDefault() {
  const o = cfg.seekOrig || SEEK_DEFAULT;
  await exec(`f=${q(KH + '/userdata/addon_data/script.kodicontrol/seek.json')}; [ -d "$(dirname "$f")" ] && printf '%s' '{"on": false}' > "$f"; rm -rf ${q(KH + '/temp/kcseek')} /tmp/kcseek; true`);
  await rpc('Settings.SetSettingValue', { setting: 'videoplayer.seekdelay', value: o.delay });
  await rpc('Settings.SetSettingValue', { setting: 'videoplayer.seeksteps', value: o.steps });
  if (cfg.seek) cfg.seek.on = false; saveCfg();
  return `Seek preview service off, cached frames deleted, seek delay ${o.delay} ms and steps ${o.steps.join(', ')} s put back`;
}
// ---------- seek preview: one Kodi-wide switch, patched into every skin installed in the profile ----------
const SEEK_LOOK = { place: 'follow', size: 'medium', bottom: 230, color: 'FFFFFFFF' };
const SEEK_KEYS = ['seekPreview', 'seekPlace', 'seekSize', 'seekBottom', 'seekColor'];
// the same defaults as the Skin tweaks page: a skin whose saved settings all match these has nothing to patch
const TWEAK_DEF = { busy: false, vol: false, topbar: false, hbTransparent: false, posters: false, fullArt: false, fullArtMode: '', fullArtColor: 'FF0B0B0F', radius: 12, speed: 100, anim: '', osdZoom: false, osdFrom: '', bgs: [], hbItems: [], menuId: 9000,
  hbGradients: false, winAnimOff: false, winAnimFiles: [], winAnimVis: false, hideInfo: [], hideItems: [], glass: false, osdHide: [], osdBarH: 0, osdClear: false };
const LOOK_ONLY = ['radius', 'menuId', 'fullArtColor', 'fullArtMode', 'zoomReplace', 'winAnimVis'];
function hasTweaks(t = {}) {
  return Object.entries(t).some(([k, v]) => {
    if (SEEK_KEYS.includes(k) || LOOK_ONLY.includes(k) || v === undefined) return false;
    if (!(k in TWEAK_DEF)) return !!v && !(Array.isArray(v) && !v.length);
    return JSON.stringify(v) !== JSON.stringify(TWEAK_DEF[k]);
  });
}
function seekT(t = {}) {
  const s = cfg.seek || {}, l = { ...SEEK_LOOK, ...(s.look || {}) };
  return { ...t, seekPreview: !!s.on, seekPlace: l.place, seekSize: l.size, seekBottom: +l.bottom || 230, seekColor: l.color };
}
const patchedMark = id => `${KH}/kodicontrol/patched-${id}`;
async function patchedSkins() {
  // marked when Kodi Control writes a skin; older patches are found by the files it adds
  const out = await sh(`cd ${q(KH + '/addons')} 2>/dev/null && for d in skin.*; do if [ -f ${q(KH + '/kodicontrol')}/patched-$d ] || [ -s ${q(KH + '/kodicontrol')}/added-$d.txt ] || grep -qls 'kodicontrol' $d/*/*.xml 2>/dev/null; then echo $d; fi; done; true`);
  return out.split('\n').map(x => x.trim()).filter(Boolean);
}
// put the switch's state into every profile skin; built-in (read-only) skins get it when you switch to them
async function seekEverywhere() {
  const { skins, current } = await listSkins();
  const on = !!(cfg.seek && cfg.seek.on), patched = await patchedSkins(), lines = [];
  for (const s of skins) {
    const t = cfg.skins[s.id] || {}, mine = s.path.startsWith(KH), reload = s.id === current;
    try {
      if (on && mine) { const r = await applySkin(s.id, t, { reload }); lines.push({ ok: !r.report.some(x => !x.ok && /Seek preview/.test(x.text)), text: `${s.name}: ${(r.report.find(x => /Seek preview/.test(x.text)) || { text: 'patched' }).text.replace(/^Seek preview: /, '')}` }); }
      else if (on && !mine) lines.push({ ok: true, text: `${s.name} is built into Kodi: it gets the seek preview when you switch to it from Kodi Control` });
      else if (!on && patched.includes(s.id)) {
        if (hasTweaks(t)) await applySkin(s.id, t, { reload }); else await revertSkin(s.id, { reload });
        lines.push({ ok: true, text: `${s.name}: seek preview taken out${hasTweaks(t) ? ' (your other tweaks stay)' : ', original skin files back'}` });
      }
    } catch (e) { lines.push({ ok: false, text: `${s.name}: ${e.message}` }); }
  }
  return lines;
}
async function seekEnable({ on, step, width, delay, steps, look, ram, hidesubs }) {
  if (!on) {
    const msg = await seekDefault();
    cfg.seek = { on: false }; saveCfg();
    const lines = await seekEverywhere();
    return { report: [{ ok: true, text: msg }, ...lines] };
  }
  const notes = await handlers['seek:save']({ on: true, step, width, delay, steps, ram, hidesubs });
  cfg.seek.look = { ...SEEK_LOOK, ...(look || {}) }; saveCfg();
  return { report: [{ ok: true, text: 'Seek preview on: ' + notes }, ...(await seekEverywhere())] };
}

async function keymapDefault() {
  await exec(`rm -f ${q(KH + '/userdata/keymaps/kodicontrol.xml')}`);
  cfg.keymaps = []; saveCfg();
  await builtin('Action(reloadkeymaps)').catch(() => {});
  return 'kodicontrol.xml removed and keymaps reloaded: Kodi uses its own keymaps (and the Keymap Editor add-on\'s gen.xml, if you made one) again';
}
async function addonsUndo() {
  const done = [];
  for (const [id, was] of Object.entries(cfg.addonOrig || {})) {
    try { await rpc('Addons.SetAddonEnabled', { addonid: id, enabled: was }, 15000); done.push(`${id} ${was ? 'enabled' : 'disabled'}`); delete cfg.addonOrig[id]; } catch (e) { done.push(`${id}: ${e.message}`); }
  }
  saveCfg();
  return done.length ? 'Put back: ' + done.join(', ') : 'No add-on switches to undo';
}
async function artUndo() {
  const list = cfg.artUndo || [];
  let n = 0;
  for (const u of list) {
    const art = { [u.type]: u.old || null };
    try { if (u.kind === 'movie') await rpc('VideoLibrary.SetMovieDetails', { movieid: u.id, art }); else await rpc('VideoLibrary.SetTVShowDetails', { tvshowid: u.id, art }); n++; } catch {}
  }
  await exec(`rm -rf ${q(KH + '/userdata/kodicontrol-art')}`);
  cfg.artUndo = []; saveCfg();
  return `${n} artwork change${n === 1 ? '' : 's'} put back`;
}
async function iptvUndo() {
  const f = (await sh(`ls ${q(KH + '/userdata/addon_data/pvr.iptvsimple')}/*.kcorig 2>/dev/null | head -1`)).trim();
  if (!f) throw new Error('No saved original IPTV Simple settings');
  await exec(`mv -f ${q(f)} ${q(f.replace(/\.kcorig$/, ''))}`);
  try { await rpc('Addons.SetAddonEnabled', { addonid: 'pvr.iptvsimple', enabled: false }); await new Promise(r => setTimeout(r, 1500)); await rpc('Addons.SetAddonEnabled', { addonid: 'pvr.iptvsimple', enabled: true }); } catch {}
  return 'IPTV Simple settings put back to how they were before Kodi Control first changed them, and channels reloaded';
}

// ---------- eMMC and NAS traffic for this session ----------
// Read-only, nothing is written on the box: every 5 s while connected, a Python snippet sent over SSH stdin reads
// /proc/diskstats (the eMMC) and asks the kernel (netlink sock_diag, tcp_info) how many bytes each TCP connection
// to the NAS has moved. The app keeps the totals; "session" starts when Kodi Control connects.
const NETIO_PY = String.raw`import os, sys, json, socket, struct
hosts = [h for h in sys.argv[1].split(',') if h]
ips = set()
for h in hosts:
    try: ips.update(i[4][0] for i in socket.getaddrinfo(h, None))
    except Exception: pass
out = {'disks': [], 'socks': [], 'ips': sorted(ips)}
for l in open('/proc/diskstats'):
    f = l.split()
    if len(f) > 9 and (f[2].startswith('mmcblk') and 'p' not in f[2][6:] and 'boot' not in f[2] and 'rpmb' not in f[2] or (f[2].startswith('sd') and len(f[2]) == 3)):
        out['disks'].append({'name': f[2], 'rd': int(f[5]) * 512, 'wr': int(f[9]) * 512})
def diag(fam):
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_DGRAM, 4)
    req = struct.pack('=BBBBI', fam, socket.IPPROTO_TCP, 1 << 1, 0, 0xfff) + b'\0' * 48
    s.sendto(struct.pack('=IHHII', 16 + len(req), 20, 0x301, 1, 0) + req, (0, 0))
    done = False
    while not done:
        d = s.recv(65536); o = 0
        while o + 16 <= len(d):
            ln, typ = struct.unpack_from('=IH', d, o)
            if ln < 16: done = True; break
            if typ in (2, 3): done = True; break
            m = d[o + 16:o + ln]
            dport = struct.unpack_from('>H', m, 6)[0]
            dst = socket.inet_ntop(fam, m[24:24 + (4 if fam == socket.AF_INET else 16)])
            if dst.startswith('::ffff:'): dst = dst[7:]
            cookie = '%x%x' % struct.unpack_from('=II', m, 44)
            a = 72; rx = tx = 0
            while a + 4 <= len(m):
                al, at = struct.unpack_from('=HH', m, a)
                if al < 4: break
                if at == 2 and al - 4 >= 136:
                    tx, rx = struct.unpack_from('=QQ', m, a + 4 + 120)
                a += (al + 3) & ~3
            if dst in ips: out['socks'].append({'c': cookie, 'd': dst, 'p': dport, 'rx': rx, 'tx': tx})
            o += (ln + 3) & ~3
    s.close()
for fam in (socket.AF_INET, socket.AF_INET6):
    try: diag(fam)
    except Exception as e: out.setdefault('err', str(e))
print(json.dumps(out))
`;
let IO = null;
async function nasHosts() {
  // only host names leave the box: any user:password@ in a source is cut off there, before it is sent
  const raw = await sh(`cat ${q(KH + '/userdata/sources.xml')} 2>/dev/null | grep -oE '(smb|nfs)://[^/<"]+' | sed -E 's#^[a-z]+://([^@/]*@)?##' | sort -u`);
  return raw.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 8);
}
async function ioSample() {
  if (!ssh || IO?.busy) return;
  if (!IO || IO.ssh !== ssh) IO = { ssh, since: Date.now(), hosts: await nasHosts().catch(() => []), socks: new Map(), disk0: null, nasRx: 0, nasTx: 0, last: null, rate: { rx: 0, tx: 0, rd: 0, wr: 0 } };
  const me = IO; me.busy = true;
  try {
    const r = JSON.parse((await sh(`python3 - ${q(me.hosts.join(','))}`, { stdin: NETIO_PY, timeout: 15000 })).trim());
    const now = Date.now(), d = r.disks.find(x => /^mmcblk/.test(x.name)) || r.disks[0];
    if (!me.disk0 && d) me.disk0 = { ...d };
    let rx = 0, tx = 0;
    const seen = new Map();
    for (const k of r.socks) {
      const p = me.socks.get(k.c);
      // connections open when the session began only count from then on; new ones count in full
      if (p) { rx += Math.max(0, k.rx - p.rx); tx += Math.max(0, k.tx - p.tx); } else if (me.last) { rx += k.rx; tx += k.tx; }
      seen.set(k.c, { rx: k.rx, tx: k.tx });
    }
    me.socks = seen; me.nasRx += rx; me.nasTx += tx;
    if (me.last) {
      const dt = Math.max(1, (now - me.last.t) / 1000);
      me.rate = { rx: rx / dt, tx: tx / dt, rd: d && me.last.d ? Math.max(0, d.rd - me.last.d.rd) / dt : 0, wr: d && me.last.d ? Math.max(0, d.wr - me.last.d.wr) / dt : 0 };
    }
    me.last = { t: now, d, open: r.socks.length, ips: r.ips };
  } catch (e) { me.err = e.message; }
  finally { me.busy = false; }
}
setInterval(() => { ioSample().catch(() => {}); }, 5000);
function ioGet() {
  if (!ssh || !IO || IO.ssh !== ssh || !IO.last) return { online: !!ssh, ready: false };
  const d = IO.last.d, d0 = IO.disk0;
  return { online: true, ready: true, since: IO.since, hosts: IO.hosts, open: IO.last.open,
    emmc: d ? { name: d.name, sessRd: d.rd - d0.rd, sessWr: d.wr - d0.wr, bootRd: d.rd, bootWr: d.wr } : null,
    nas: { rx: IO.nasRx, tx: IO.nasTx }, rate: IO.rate, err: IO.err || '' };
}

// ---------- local NFO files ----------
// box: Kodi's own "Export library → separate files" (an .nfo, and optionally the artwork, next to each item).
// pc: the same Kodi-format .nfo files written into a folder on this PC, one folder per movie / show.
const xe = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safeDir = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Untitled';
function nfoXml(root, it, extra = '') {
  const tag = (n, v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? '' : (Array.isArray(v) ? v : [v]).map(x => `  <${n}>${xe(x)}</${n}>\n`).join('');
  const ids = Object.entries(it.uniqueid || {}).map(([t, v], i) => `  <uniqueid type="${xe(t)}"${i ? '' : ' default="true"'}>${xe(v)}</uniqueid>\n`).join('');
  const ratings = Object.entries(it.ratings || {}).map(([t, r]) => `    <rating name="${xe(t)}" max="10"${r.default ? ' default="true"' : ''}><value>${(+r.rating || 0).toFixed(1)}</value><votes>${+r.votes || 0}</votes></rating>\n`).join('');
  const cast = (it.cast || []).slice(0, 30).map(c => `  <actor><name>${xe(c.name)}</name><role>${xe(c.role)}</role><order>${+c.order || 0}</order>${c.thumbnail ? `<thumb>${xe(decodeImg(c.thumbnail))}</thumb>` : ''}</actor>\n`).join('');
  const art = it.art || {};
  const thumbs = ['poster', 'banner', 'clearlogo', 'clearart', 'landscape', 'keyart', 'discart'].filter(k => art[k]).map(k => `  <thumb aspect="${k}">${xe(decodeImg(art[k]))}</thumb>\n`).join('') + (art.fanart ? `  <fanart><thumb>${xe(decodeImg(art.fanart))}</thumb></fanart>\n` : '');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<!-- made by Kodi Control from the Kodi library -->\n<${root}>\n` +
    tag('title', it.title) + tag('originaltitle', it.originaltitle) + tag('sorttitle', it.sorttitle) + (ratings ? `  <ratings>\n${ratings}  </ratings>\n` : '') +
    tag('userrating', it.userrating || undefined) + tag('outline', it.plotoutline) + tag('plot', it.plot) + tag('tagline', it.tagline) + tag('runtime', it.runtime ? Math.round(it.runtime / 60) : '') +
    tag('mpaa', it.mpaa) + tag('playcount', it.playcount || undefined) + tag('lastplayed', it.lastplayed) + ids + tag('genre', it.genre) + tag('country', it.country) + tag('set', it.set) +
    tag('tag', it.tag) + tag('credits', it.writer) + tag('director', it.director) + tag('premiered', it.premiered) + tag('year', it.year || undefined) + tag('studio', it.studio) +
    tag('trailer', it.trailer) + extra + thumbs + cast + `</${root}>\n`;
}
function decodeImg(u) { const m = /^image:\/\/(.+?)\/?$/.exec(u || ''); return m ? decodeURIComponent(m[1]) : u; }
async function nfoExport({ target, movies, shows, episodes, overwrite, images, dir }) {
  if (target === 'box') {
    await rpc('VideoLibrary.Export', { options: { overwrite: !!overwrite, images: !!images, actorthumbs: !!images } }, 600000);
    return { text: 'Kodi is writing an .nfo next to every movie, show and episode in the library' + (images ? ', with the artwork' : '') + '. It shows its progress on the TV.' };
  }
  if (!dir) throw new Error('Choose a folder on this PC first');
  let n = 0;
  const write = (rel, x) => { const f = path.join(dir, rel); if (!overwrite && fs.existsSync(f)) return; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, x); n++; };
  const common = ['title', 'originaltitle', 'sorttitle', 'plot', 'year', 'premiered', 'genre', 'studio', 'mpaa', 'ratings', 'userrating', 'uniqueid', 'cast', 'art', 'playcount', 'lastplayed', 'tag', 'file'];
  if (movies) {
    const r = await rpc('VideoLibrary.GetMovies', { properties: [...common, 'plotoutline', 'tagline', 'runtime', 'country', 'set', 'writer', 'director', 'trailer'] }, 120000);
    for (const m of r.movies || []) write(path.join('Movies', safeDir(`${m.title} (${m.year || '?'})`), 'movie.nfo'), nfoXml('movie', m, m.file ? `  <!-- file: ${xe(m.file)} -->\n` : ''));
  }
  if (shows) {
    const r = await rpc('VideoLibrary.GetTVShows', { properties: common.filter(p => p !== 'file').concat('episode', 'season') }, 120000);
    for (const s of r.tvshows || []) {
      const sd = path.join('TV Shows', safeDir(`${s.title} (${s.year || '?'})`));
      write(path.join(sd, 'tvshow.nfo'), nfoXml('tvshow', s, tagOf('season', s.season) + tagOf('episode', s.episode)));
      if (!episodes) continue;
      const e = await rpc('VideoLibrary.GetEpisodes', { tvshowid: s.tvshowid, properties: ['title', 'plot', 'season', 'episode', 'firstaired', 'runtime', 'director', 'writer', 'ratings', 'uniqueid', 'art', 'playcount', 'lastplayed', 'cast', 'file'] }, 120000);
      for (const ep of e.episodes || []) {
        const se = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
        write(path.join(sd, `Season ${ep.season}`, safeDir(`${se} ${ep.title}`) + '.nfo'), nfoXml('episodedetails', { ...ep, premiered: ep.firstaired }, tagOf('season', ep.season) + tagOf('episode', ep.episode) + tagOf('aired', ep.firstaired)));
      }
    }
  }
  return { text: `${n} .nfo file${n === 1 ? '' : 's'} written to ${dir}`, dir };
}
const tagOf = (n, v) => v === undefined || v === '' ? '' : `  <${n}>${xe(v)}</${n}>\n`;

// ---------- stats ----------
let osdThumbCache = {};
let prevCpu = null, prevNet = null, prevKodi = null, libCache = { t: 0, v: null }, thumbCache = { key: '', data: '' };
// ---------- stats helper service (optional, Connection → Dashboard data) ----------
const helperUrl = p => `http://${cfg.conn.host}:${+cfg.conn.helperPort || 8099}${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(unseal(cfg.conn.helperToken || ''))}`;
let helperDown = 0; // after a failure, skip the helper for 30 s so the dashboard falls back to SSH without stalling
const helperOn = () => cfg.conn.via === 'helper' && cfg.conn.helperToken && Date.now() - helperDown > 30000;
async function helperFetch(p, opts = {}) {
  try {
    const r = await fetch(helperUrl(p), { ...opts, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('helper HTTP ' + r.status);
    return await r.text();
  } catch (e) { helperDown = Date.now(); throw e; }
}
async function statsRaw() {
  if (helperOn()) { try { return JSON.parse(await helperFetch('/stats')).raw; } catch {} }
  return sh(STATS_SH());
}
async function installStatsHelper({ port } = {}) {
  const crypto = require('crypto');
  const tok = unseal(cfg.conn.helperToken || '') || crypto.randomBytes(16).toString('hex');
  const dir = `${KH}/addons/${helpersvc.ID}`, prof = `${KH}/userdata/addon_data/${helpersvc.ID}`;
  await exec(`mkdir -p ${q(dir)} ${q(prof)} && tar -C ${q(dir)} -xf - && printf %s ${q(tok)} > ${q(prof + '/token')} && chmod 600 ${q(prof + '/token')}`,
    { stdin: buildTar({ 'addon.xml': helpersvc.addonXml(), 'service.py': helpersvc.servicePy(STATS_SH(), port || 8099) }) });
  cfg.conn.helperToken = seal(tok); cfg.conn.helperPort = +port || 8099; (cfg.installed ||= []).includes('service.kodicontrol') || cfg.installed.push('service.kodicontrol'); saveCfg();
  let enabled = false;
  try { enabled = (await rpc('Addons.GetAddonDetails', { addonid: helpersvc.ID, properties: ['enabled'] })).addon.enabled; } catch {}
  if (!enabled) {
    await builtin('UpdateLocalAddons').catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    try { await rpc('Addons.SetAddonEnabled', { addonid: helpersvc.ID, enabled: true }); enabled = true; } catch {}
  } else {
    // already running an older copy: restart the service so it reads the new script
    await rpc('Addons.SetAddonEnabled', { addonid: helpersvc.ID, enabled: false }).catch(() => {});
    await rpc('Addons.SetAddonEnabled', { addonid: helpersvc.ID, enabled: true }).catch(() => {});
  }
  helperDown = 0;
  let ping = '';
  for (let i = 0; i < 6 && !ping; i++) { await new Promise(r => setTimeout(r, 1000)); ping = await fetch(`http://${cfg.conn.host}:${cfg.conn.helperPort}/ping`, { signal: AbortSignal.timeout(2000) }).then(r => r.text()).catch(() => ''); }
  return { enabled, answering: !!ping, port: cfg.conn.helperPort,
    note: ping ? `Helper service answering on port ${cfg.conn.helperPort}. Pick "Helper add-on" under Dashboard data to use it.` : enabled ? 'Helper installed and enabled, but it is not answering yet. Restart Kodi once, then try again.' : 'Helper copied, but Kodi has not loaded it yet: restart Kodi, then enable "Kodi Control stats" under My add-ons → Services.' };
}

// One shell script for every dashboard number. The helper service add-on runs this same script on the box.
const STATS_SH = () => `echo ==CPU; head -1 /proc/stat; echo ==MEM; cat /proc/meminfo; echo ==TEMP; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null; echo ==IP; ip -4 -o addr show 2>/dev/null | grep -v ' lo '; echo ==UP; cat /proc/uptime; echo ==HOST; hostname; echo ==LOAD; cat /proc/loadavg; echo ==NCPU; grep -c ^processor /proc/cpuinfo; echo ==FREQ; cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null; echo ==NET; cat /proc/net/dev; echo ==DISK; df -kP /storage /flash /var/media/* 2>/dev/null; echo ==KODI; for p in $(pidof kodi.bin kodi-x11 kodi-gbm kodi 2>/dev/null); do grep -E '^(VmRSS|Threads)' /proc/$p/status; awk '{print "Ticks", $14+$15, $22}' /proc/$p/stat; break; done; echo ==OS; grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release 2>/dev/null; uname -r; echo ==ADDONS; ls ${q(KH + '/addons')} 2>/dev/null | grep -vc '^packages$\\|^temp$'`;
async function stats() {
  const raw = await statsRaw();
  const sec = {};
  raw.split('==').forEach(b => { const i = b.indexOf('\n'); if (i > 0) sec[b.slice(0, i).trim()] = b.slice(i + 1).trim(); });
  const out = { host: sec.HOST, kodiHome: KH };
  const cpu = (sec.CPU || '').split(/\s+/).slice(1).map(Number);
  if (cpu.length > 4) {
    const idle = cpu[3] + (cpu[4] || 0), total = cpu.reduce((a, b) => a + b, 0);
    if (prevCpu) out.cpu = Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - prevCpu.idle) / Math.max(1, total - prevCpu.total)))));
    prevCpu = { idle, total };
  }
  const mem = {}; (sec.MEM || '').split('\n').forEach(l => { const m = /^(\w+):\s+(\d+)/.exec(l); if (m) mem[m[1]] = +m[2]; });
  if (mem.MemTotal) out.mem = { total: mem.MemTotal * 1024, used: (mem.MemTotal - (mem.MemAvailable ?? mem.MemFree)) * 1024 };
  const temps = (sec.TEMP || '').split(/\s+/).map(Number).filter(t => t > 0);
  if (temps.length) out.temp = Math.round(Math.max(...temps) / (Math.max(...temps) > 1000 ? 1000 : 1));
  out.ips = (sec.IP || '').split('\n').map(l => { const m = /^\d+:\s+(\S+)\s+inet\s+([\d.]+)/.exec(l); return m && { iface: m[1], ip: m[2] }; }).filter(Boolean);
  out.uptime = Math.floor(parseFloat(sec.UP || '0'));
  const now = Date.now();

  const ld = (sec.LOAD || '').split(/\s+/);
  if (ld.length >= 4) out.load = { l1: +ld[0], l5: +ld[1], l15: +ld[2], procs: ld[3] };
  out.cores = +sec.NCPU || 0;
  const fr = (sec.FREQ || '').split(/\s+/).map(Number).filter(f => f > 0);
  if (fr.length) out.freq = { cur: Math.round(Math.max(...fr) / 1000), min: Math.round(Math.min(...fr) / 1000) };
  // Network rate from /proc/net/dev against the previous poll (loopback left out)
  let rx = 0, tx = 0; const nifs = [];
  (sec.NET || '').split('\n').forEach(l => { const m = /^\s*([^:\s]+):\s*(\d+)\s+(?:\d+\s+){7}(\d+)/.exec(l); if (m && m[1] !== 'lo') { rx += +m[2]; tx += +m[3]; if (+m[2]) nifs.push(m[1]); } });
  if (prevNet && now > prevNet.t && rx >= prevNet.rx) out.net = { down: (rx - prevNet.rx) * 8000 / (now - prevNet.t), up: Math.max(0, tx - prevNet.tx) * 8000 / (now - prevNet.t), rxTotal: rx, txTotal: tx, ifaces: nifs };
  else out.net = { rxTotal: rx, txTotal: tx, ifaces: nifs };
  prevNet = { rx, tx, t: now };
  out.disks = (sec.DISK || '').split('\n').slice(1).map(l => { const f = l.trim().split(/\s+/); return f.length >= 6 && { mount: f.slice(5).join(' '), total: +f[1] * 1024, used: +f[2] * 1024, free: +f[3] * 1024 }; })
    .filter((d, i, a) => d && d.total > 0 && a.findIndex(x => x && x.mount === d.mount) === i);
  const kp = sec.KODI || '';
  const rss = /VmRSS:\s+(\d+)/.exec(kp), thr = /Threads:\s+(\d+)/.exec(kp), tk = /Ticks (\d+) (\d+)/.exec(kp);
  if (rss) {
    out.kodi = { rss: +rss[1] * 1024, threads: thr ? +thr[1] : 0 };
    const hz = 100, ticks = tk ? +tk[1] : 0;
    if (tk) out.kodi.runFor = Math.max(0, out.uptime - +tk[2] / hz);
    if (tk && prevKodi && now > prevKodi.t) out.kodi.cpu = Math.max(0, Math.round((ticks - prevKodi.ticks) / hz / ((now - prevKodi.t) / 1000) * 100 / Math.max(1, out.cores || 1)));
    prevKodi = { ticks, t: now };
  }
  const osl = (sec.OS || '').split('\n');
  out.os = { name: ((/PRETTY_NAME="?([^"\n]*)/.exec(sec.OS || '') || [])[1] || '').trim(), kernel: osl.filter(l => !/=/.test(l)).pop() || '' };
  out.addons = +sec.ADDONS || 0;

  try {
    // in parallel: one round trip's wait instead of five
    const [lab, sk, players] = await Promise.all([rpc('XBMC.GetInfoLabels', { labels: ['System.ScreenResolution', 'System.BuildVersion', 'System.FriendlyName', 'Player.Process(videowidth)', 'Player.Process(videoheight)', 'Player.Process(videofps)', 'Player.Process(videodecoder)', 'VideoPlayer.HdrType', 'Player.Process(audiochannels)', 'VideoPlayer.AudioCodec'] }), rpc('Settings.GetSettingValue', { setting: 'lookandfeel.skin' }), rpc('Player.GetActivePlayers')]);
    out.labels = lab;
    out.skin = sk.value;
    // library counts refresh in the background every 5 minutes; the dashboard shows the last ones meanwhile
    if (now - libCache.t > 300000 && !libCache.busy) {
      libCache.busy = true;
      const n = async (m, extra = {}) => { try { return (await rpc(m, { limits: { start: 0, end: 1 }, ...extra })).limits.total; } catch { return null; } };
      const libP = Promise.all([n('VideoLibrary.GetMovies'), n('VideoLibrary.GetTVShows'), n('VideoLibrary.GetEpisodes'), n('AudioLibrary.GetAlbums'), n('AudioLibrary.GetSongs'), n('PVR.GetChannels', { channelgroupid: 'alltv' })])
        .then(([movies, shows, episodes, albums, songs, channels]) => { libCache = { t: Date.now(), v: { movies, shows, episodes, albums, songs, channels } }; })
        .finally(() => { libCache.busy = false; });
      if (!libCache.v) await libP;
    }
    out.library = libCache.v;
    const vp = players.find(p => p.type === 'video') || players[0];
    if (vp) {
      const [it, prop] = await Promise.all([rpc('Player.GetItem', { playerid: vp.playerid, properties: ['title', 'year', 'showtitle', 'season', 'episode', 'file', 'thumbnail', 'art'] }),
        rpc('Player.GetProperties', { playerid: vp.playerid, properties: ['percentage', 'time', 'totaltime', 'speed'] })]);
      const item = it.item;
      const thumb = item.art?.poster || item.art?.['tvshow.poster'] || item.thumbnail || '';
      // a new poster loads in the background; the card fills in on the next refresh
      if (thumb && thumb !== thumbCache.key && thumbCache.loading !== thumb) {
        thumbCache.loading = thumb;
        artData(thumb).then(d => { thumbCache = { key: thumb, data: d }; }).catch(() => { thumbCache.loading = ''; });
      }
      let host = '';
      try { host = new URL(item.file).hostname; } catch {}
      out.playing = { type: vp.type, item, prop, thumb: thumb && thumbCache.key === thumb ? thumbCache.data : '', host, provider: provider(host) };
    }
  } catch (e) { out.rpcError = e.message; }
  return out;
}

// Poster for the Now Playing card without needing Kodi's web server (often off when JSON-RPC runs over TCP):
// Kodi's own texture cache over SSH, then the original http(s) URL from this PC, then a file on the box, then the web server.
async function artData(thumb) {
  const asData = buf => {
    if (!buf || buf.length < 200) return '';
    const type = buf[0] === 0x89 ? 'png' : buf.slice(0, 4).toString() === 'RIFF' ? 'webp' : 'jpeg';
    return `data:image/${type};base64,${buf.toString('base64')}`;
  };
  const url = /^image:\/\//i.test(thumb) ? decodeURIComponent(thumb.slice(8).replace(/\/$/, '')) : thumb;
  try {
    const t = await rpc('Textures.GetTextures', { properties: ['cachedurl'], filter: { field: 'url', operator: 'is', value: url } });
    const c = t.textures && t.textures[0] && t.textures[0].cachedurl;
    if (c) { const d = asData((await exec(`cat ${q(KH + '/userdata/Thumbnails/' + c)}`, { timeout: 15000 })).out); if (d) return d; }
  } catch {}
  if (/^https?:\/\//i.test(url)) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) { const d = asData(Buffer.from(await r.arrayBuffer())); if (d) return d; } } catch {}
  }
  if (/^\//.test(url)) { const d = asData((await exec(`cat ${q(url)}`, { timeout: 15000 }).catch(() => ({ out: null }))).out); if (d) return d; }
  if (HAS.curl) {
    const c = cfg.conn, auth = c.rpcUser ? `-u ${q(c.rpcUser + ':' + unseal(c.rpcPass))}` : '';
    const img = await exec(`curl -s -m 6 ${auth} ${q(`http://127.0.0.1:${+c.rpcPort || 8080}/image/${encodeURIComponent(thumb)}`)}`).catch(() => null);
    return asData(img && img.out);
  }
  return '';
}

const PROVIDERS = [[/real-?debrid|\.rdeb\./i, 'Real-Debrid'], [/alldebrid|debrid\.it/i, 'AllDebrid'], [/premiumize/i, 'Premiumize'], [/torbox/i, 'TorBox'], [/debrid-link/i, 'Debrid-Link'], [/offcloud/i, 'Offcloud'], [/easydebrid/i, 'EasyDebrid']];
const provider = h => (PROVIDERS.find(([re]) => re.test(h || '')) || [])[1] || '';
const KNOWN = [[/tmdb|themoviedb/i, 'Metadata (TMDb)'], [/image\.tmdb|fanart\.tv|thetvdb/i, 'Artwork'], [/trakt/i, 'Trakt'], [/youtube|googlevideo/i, 'YouTube'], [/github|kodi\.tv|mirrors/i, 'Add-on repo']];

// ---------- iftop ----------
const toBits = s => { const m = /^([\d.]+)([KMG]?)b?$/i.exec(s || ''); if (!m) return 0; return +m[1] * ({ '': 1, K: 1e3, M: 1e6, G: 1e9 }[m[2].toUpperCase()] || 1); };
const rdns = {};
async function resolve(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  if (rdns[ip] === undefined) { rdns[ip] = ip; dns.reverse(ip).then(n => { if (n[0]) rdns[ip] = n[0]; }).catch(() => {}); }
  return rdns[ip];
}
async function iftop() {
  const umbrella = (await sh(`[ -d ${q(KH + '/addons/plugin.video.umbrella')} ] && echo y`)).trim() === 'y';
  let rows = [], tool = '';
  const total = netTotals();
  if (HAS.iftop) {
    const r = await exec(`${q(IFTOP)} -t -s 3 -L 20 -P 2>/dev/null`, { timeout: 15000 });
    const lines = r.out.toString().split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const a = /^\s*\d+\s+(\S+)\s+=>\s+(\S+)/.exec(lines[i]), b = /^\s+(\S+)\s+<=\s+(\S+)/.exec(lines[i + 1]);
      if (a && b) { rows.push({ host: b[1], down: toBits(b[2]), up: toBits(a[2]) }); i++; }
    }
    if (rows.length) tool = 'iftop';
  }
  if (!rows.length) {
    const r = await sh(`(ss -tn 2>/dev/null || netstat -tn 2>/dev/null) | grep -i estab`);
    const seen = {};
    r.split('\n').forEach(l => {
      const f = l.trim().split(/\s+/);
      const remote = f.find((x, k) => k > 2 && /:\d+$/.test(x) && x !== f.find(y => /:\d+$/.test(y)));
      if (remote && !/^(127\.|::1|\[::1\])/.test(remote)) seen[remote] = 1;
    });
    rows = Object.keys(seen).map(h => ({ host: h, down: null, up: null }));
    tool = HAS.iftop ? 'connections (iftop returned nothing)' : 'connections (iftop not installed)';
  }
  for (const r of rows) {
    const [h, port] = r.host.replace(/^\[|\]/g, '').split(/:(?=[^:]*$)/);
    const name = await resolve(h);
    r.host = name + (port && !/^(http|https|443|80)$/.test(port) ? ':' + port : '');
    const prov = provider(name);
    const known = (KNOWN.find(([re]) => re.test(name)) || [])[1];
    r.source = prov ? (umbrella ? `Umbrella → ${prov}` : prov) : known || (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(h) ? 'Local network' : '');
    r.stream = !!prov;
  }
  // Without iftop there are no per-host byte counts, so the interface totals stand in: given to the stream
  // (or the only external host) and marked as an estimate, and always returned for the summary row.
  const t = await total;
  if (t && rows.length && rows.every(r => r.down == null)) {
    const ext = rows.filter(r => r.source !== 'Local network');
    const pick = rows.filter(r => r.stream).length === 1 ? rows.find(r => r.stream) : ext.length === 1 ? ext[0] : null;
    if (pick) Object.assign(pick, { down: t.down, up: t.up, est: true });
  }
  rows.sort((a, b) => (b.down || 0) - (a.down || 0));
  return { tool, rows, umbrella, total: t };
}

// Whole-box throughput from /proc/net/dev sampled 2 s apart (loopback and idle interfaces left out).
async function netTotals() {
  try {
    const r = await sh('cat /proc/net/dev; sleep 2; echo @@; cat /proc/net/dev');
    const read = s => { const o = {}; s.split(/\r?\n/).forEach(l => { const m = /^\s*([^:\s]+):\s*(\d+)\s+(?:\d+\s+){7}(\d+)/.exec(l); if (m && m[1] !== 'lo') o[m[1]] = [+m[2], +m[3]]; }); return o; };
    const [a, b] = r.split('@@').map(read);
    let down = 0, up = 0, iface = [];
    for (const k of Object.keys(b)) if (a[k]) {
      const d = Math.max(0, b[k][0] - a[k][0]) * 4, u = Math.max(0, b[k][1] - a[k][1]) * 4; // bytes per 2 s to bits/s
      if (b[k][0] || b[k][1]) iface.push(k);
      down += d; up += u;
    }
    return { down, up, iface };
  } catch { return null; }
}

// ---------- logs ----------
const LINE = /^(?:(\d{4}-\d\d-\d\d) )?(\d\d:\d\d:\d\d)\.\d+\s+T:\d+\s+(\w+)\s*(?:<[^>]*>)?:\s?(.*)$/;
function normalize(m) { return m.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').replace(/(['"])[^'"]{40,}\1/g, '"…"').slice(0, 160); }
function cause(m, ctx) {
  const s = m + ' ' + ctx;
  const addon = /\b((?:plugin|script|service|skin|repository|resource|metadata|inputstream|pvr)\.[\w.\-]+)/i.exec(s);
  const http = /\b(\d{3})\b.*?(?:https?:\/\/)?([\w.\-]+\.\w{2,})|(?:https?:\/\/)([\w.\-]+)/i.exec(m);
  const py = /Error Type: <class '([^']+)'>|(\w+Error): /.exec(ctx);
  const parts = [];
  if (addon) parts.push(addon[1]);
  if (py) parts.push(py[1] || py[2]);
  if (/Timeout|timed out/i.test(s)) parts.push('timeout');
  if (/429/.test(m)) parts.push('rate limited (429)');
  else if (/\b40[134]\b/.test(m) && http) parts.push('HTTP error');
  if (/duplicate.*id|control.*id/i.test(m)) parts.push('skin XML control id clash');
  if (/out of memory|oom/i.test(s)) parts.push('out of memory');
  return parts.join(' · ');
}
function parseLog(text, file) {
  const lines = text.split('\n');
  const groups = {}; let date = '', last = '';
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i]);
    if (!m) continue;
    if (m[1]) date = m[1];
    last = lines[i];
    const lvl = m[3].toLowerCase();
    if (lvl !== 'error' && lvl !== 'fatal' && lvl !== 'severe') continue;
    const ctx = lines.slice(i + 1, i + 12).filter(l => !LINE.test(l) || /error/i.test(l)).join('\n');
    const key = normalize(m[4]);
    const g = groups[key] || (groups[key] = { msg: m[4].slice(0, 300), count: 0, first: '', last: '', file, cause: cause(m[4], ctx) });
    g.count++; g.last = `${date} ${m[2]}`.trim(); if (!g.first) g.first = g.last;
    errors.push(g.last);
  }
  const clean = /application stopped|stopped\s*$|Shutdown|CApplication::Stop/i.test(lines.slice(-60).join('\n'));
  return { groups: Object.values(groups), errors: errors.length, clean, lastLine: last };
}
async function logs() {
  const files = (await sh(`ls -1t ${q(KH + '/temp')}/kodi_crashlog_*.log /storage/kodi_crash*.log ${q(KH + '/temp')}/kodi_stacktrace* 2>/dev/null | head -20`)).split('\n').filter(Boolean);
  const cur = await sh(`tail -n 30000 ${q(KH + '/temp/kodi.log')} 2>/dev/null`, { timeout: 60000 });
  const old = await sh(`tail -n 30000 ${q(KH + '/temp/kodi.old.log')} 2>/dev/null`, { timeout: 60000 });
  const crashes = [];
  for (const f of files.slice(0, 10)) {
    const t = await sh(`head -c 60000 ${q(f)}`);
    const ts = /(\d{4})(\d\d)(\d\d)_?(\d\d)(\d\d)(\d\d)/.exec(f);
    const sig = /signal (SIG\w+)|received signal (\w+)/i.exec(t);
    const frame = /#\d+\s+0x[0-9a-f]+ in (\S+)/i.exec(t) || /#\d+\s+(\S+ \(.*?\))/.exec(t);
    // the culprit is whoever owns the crashing thread: gdb names it "Current thread is 1 (… (LWP n))" and the
    // log section of the crash file shows which add-on logged from T:n (the first add-on named in the file is
    // usually just the first one that started)
    const lwp = (/Current thread is \d+ \(Thread 0x[0-9a-f]+ \(LWP (\d+)\)/i.exec(t) || [])[1];
    const owner = lwp ? (await sh(`grep -E ' T:${lwp} ' ${q(f)} | grep -oE '(plugin|script|service|inputstream|pvr|skin)\\.[A-Za-z0-9_.-]+' | head -1`).catch(() => '')).trim().replace(/[.:]+$/, '') : '';
    const addon = owner ? [, owner] : /((?:plugin|script|service|inputstream|pvr)\.[\w.\-]+)/i.exec(t);
    crashes.push({ file: f, when: ts ? `${ts[1]}-${ts[2]}-${ts[3]} ${ts[4]}:${ts[5]}` : '', signal: sig ? (sig[1] || sig[2]) : 'crash', frame: frame ? frame[1] : '', addon: addon ? addon[1] + (owner ? ' (crashing thread)' : ' (guess)') : '' });
  }
  const a = parseLog(cur, 'kodi.log'), b = parseLog(old, 'kodi.old.log');
  if (old && !b.clean) crashes.push({ file: 'kodi.old.log', when: (LINE.exec(b.lastLine) || [])[1] || '', signal: 'unclean exit', frame: b.lastLine.slice(0, 160), addon: cause(b.lastLine, '') });
  const groups = [...a.groups, ...b.groups].sort((x, y) => (y.last > x.last ? 1 : -1));
  return { crashes, groups, errorsCurrent: a.errors, errorsOld: b.errors, tail: cur.split('\n').slice(-400).join('\n') };
}

// ---------- backup ----------
// Paths are relative to / so CoreELEC system folders (Bluetooth, Wi-Fi, .config) sit next to the Kodi ones.
// K() is the Kodi home without the leading slash. Archives from older builds were relative to the Kodi home;
// restore tells them apart by the first entry.
const K = () => KH.replace(/^\/+/, '');
const BACKUP_SETS = {
  skin: () => [`${K()}/userdata/addon_data/skin.*`, `${K()}/userdata/addon_data/script.skinshortcuts`, `${K()}/kodicontrol`],
  skins: () => [`${K()}/addons/skin.*`],
  repos: () => [`${K()}/addons/repository.*`],
  thumbs: () => [`${K()}/userdata/Thumbnails`, `${K()}/userdata/Database/Textures*.db`],
  keymaps: () => [`${K()}/userdata/keymaps`],
  addons: () => [`${K()}/userdata/addon_data`, `${K()}/userdata/favourites.xml`],
  shares: () => [`${K()}/userdata/passwords.xml`, `${K()}/userdata/sources.xml`, `${K()}/userdata/mediasources.xml`, 'storage/.config/samba.conf', 'storage/.config/system.d/*.mount', 'storage/.config/system.d/*.automount', 'storage/.cache/services/samba.conf'],
  tokens: () => [`$(grep -lisE 'token|api_?key|password|passwd|secret|pin' ${K()}/userdata/addon_data/*/settings.xml ${K()}/userdata/addon_data/*/*.json 2>/dev/null)`],
  settings: () => [`${K()}/userdata/guisettings.xml`, `${K()}/userdata/advancedsettings.xml`, `${K()}/userdata/profiles.xml`, `${K()}/userdata/playercorefactory.xml`, `${K()}/userdata/RssFeeds.xml`, `${K()}/userdata/Database/MyVideos*.db`, `${K()}/userdata/Database/MyMusic*.db`],
  coreelec: () => [`${K()}/userdata/addon_data/service.coreelec.settings`, `${K()}/userdata/addon_data/service.libreelec.settings`, 'storage/.config', 'storage/.cache/coreelec', 'storage/.cache/services', 'storage/.cache/timezone', 'storage/.cache/hostname', 'storage/.cache/cron', 'storage/.cache/locpath'],
  wifi: () => ['storage/.cache/connman'],
  bluetooth: () => ['storage/.cache/bluetooth'],
};
const SYSTEM_SETS = ['coreelec', 'wifi', 'bluetooth', 'shares'];
const backupPats = sets => [...new Set(sets.flatMap(s => BACKUP_SETS[s] ? BACKUP_SETS[s]() : []))];
async function backupSizes() {
  const pats = Object.keys(BACKUP_SETS).map(k => `echo ${k} $(du -sck ${backupPats([k]).join(' ')} 2>/dev/null | tail -1 | cut -f1)`).join('; ');
  const out = await sh(`cd / && { ${pats}; }`, { timeout: 90000 });
  return Object.fromEntries(out.split('\n').map(l => l.trim().split(' ')).filter(x => x[0]).map(([k, v]) => [k, (+v || 0) * 1024]));
}
async function backup(sets) {
  const dir = cfg.backupDir || defaultBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  const pats = backupPats(sets);
  if (!pats.length) throw new Error('Pick at least one thing to back up');
  const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const file = path.join(dir, `${stamp}_${sets.join('-')}.tar`);
  const ws = fs.createWriteStream(file);
  let bytes = 0, lastSent = 0;
  const r = await exec(`cd / && set -- && for p in ${pats.join(' ')}; do [ -e "$p" ] && set -- "$@" "$p"; done; [ $# -gt 0 ] && tar -cf - "$@"`, {
    timeout: 0,
    onData: c => { ws.write(c); bytes += c.length; if (Date.now() - lastSent > 400) { lastSent = Date.now(); send('progress', { op: 'backup', bytes }); } },
  });
  await new Promise(res => ws.end(res));
  if (!bytes) { fs.unlinkSync(file); throw new Error('Nothing to back up: none of those folders exist on the device'); }
  send('progress', { op: 'backup', bytes, done: true });
  return { file, bytes, warn: r.code ? r.err.trim().split('\n').slice(-3).join(' ') : '' };
}
function listBackups() {
  const dir = cfg.backupDir || defaultBackupDir();
  try {
    return { dir, files: fs.readdirSync(dir).filter(f => /\.tar$/i.test(f)).map(f => { const s = fs.statSync(path.join(dir, f)); return { name: f, path: path.join(dir, f), size: s.size, mtime: s.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime) };
  } catch { return { dir, files: [] }; }
}
const STOP = `systemctl stop kodi 2>/dev/null || killall -q kodi.bin kodi-x11 kodi-gbm kodi-wayland kodi 2>/dev/null; sleep 2`;
const START = `systemctl start kodi 2>/dev/null || (nohup kodi >/dev/null 2>&1 &)`;
async function restore(file) {
  const size = fs.statSync(file).size;
  // First entry name decides the root: older archives were made inside the Kodi home (userdata/, addons/ …).
  const head = Buffer.alloc(100), fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 100, 0); fs.closeSync(fd);
  const first = head.toString('utf8').replace(/\0[\s\S]*$/, '').replace(/^\.\//, '');
  const legacy = /^(userdata|addons|kodicontrol|media|system)(\/|$)/.test(first);
  const system = !legacy && /^storage\/\.(cache|config)\//.test(first) || /coreelec|wifi|bluetooth|shares/.test(path.basename(file));
  await exec(STOP, { timeout: 30000 });
  const r = await new Promise((resolve, reject) => {
    ssh.exec(`tar -C ${legacy ? q(KH) : '/'} -xf -`, (e, st) => {
      if (e) return reject(e);
      let err = '', sent = 0, last = 0;
      st.stderr.on('data', d => err += d);
      st.on('close', code => resolve({ code, err }));
      const rs = fs.createReadStream(file);
      rs.on('data', c => { sent += c.length; if (Date.now() - last > 400) { last = Date.now(); send('progress', { op: 'restore', bytes: sent, total: size }); } });
      rs.pipe(st);
    });
  });
  await exec(START, { timeout: 20000 });
  if (r.code) throw new Error('Restore failed: ' + r.err.slice(0, 300));
  return system ? `Restored. Wi-Fi, Bluetooth and CoreELEC settings take effect after a reboot of the box.` : { bytes: size };
}

// ---------- skins ----------
async function listSkins() {
  let skins = [];
  try {
    const r = await rpc('Addons.GetAddons', { type: 'xbmc.gui.skin', properties: ['name', 'version', 'path', 'enabled'] });
    skins = (r.addons || []).map(a => ({ id: a.addonid, name: a.name, version: a.version, path: a.path, enabled: a.enabled }));
  } catch {}
  if (!skins.length) {
    const out = await sh(`for d in ${q(KH + '/addons')}/skin.* /usr/share/kodi/addons/skin.* /usr/local/share/kodi/addons/skin.*; do [ -f "$d/addon.xml" ] && echo "$d|$(grep -o 'name="[^"]*"' "$d/addon.xml" | sed -n 2p)|$(grep -o 'version="[^"]*"' "$d/addon.xml" | sed -n 2p)"; done`);
    skins = out.split('\n').filter(Boolean).map(l => { const [p, n, v] = l.split('|'); return { id: p.split('/').pop(), name: (n || '').replace(/name="|"/g, '') || p.split('/').pop(), version: (v || '').replace(/version="|"/g, ''), path: p, enabled: true }; });
  }
  let current = '';
  try { current = (await rpc('Settings.GetSettingValue', { setting: 'lookandfeel.skin' })).value; } catch {}
  return { skins: skins.sort((a, b) => a.name.localeCompare(b.name)), current };
}

async function skinInfo(id) {
  const { skins } = await listSkins();
  const s = skins.find(x => x.id === id);
  if (!s) throw new Error(`Skin ${id} is not installed`);
  let p = s.path;
  const xml = await sh(`cat ${q(p + '/addon.xml')}`);
  // comments stripped first: Aeon Nox SiLVO keeps a commented-out folder="xml" next to its real 16x9
  const res = [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<res\b([^>]*)\/?>/gi)].map(m => {
    const a = n => (new RegExp(`${n}\\s*=\\s*"([^"]*)"`, 'i').exec(m[1]) || [])[1];
    return { folder: a('folder'), w: +a('width') || 1920, h: +a('height') || 1080, def: /default\s*=\s*"true"/i.test(m[1]) };
  }).filter(r => r.folder);
  // keep folders that really hold windows; fall back to any folder with a Home.xml
  const have = (await sh(`cd ${q(p)} && ls -d */ 2>/dev/null; ls */[Hh]ome.xml 2>/dev/null`)).split('\n').map(x => x.trim()).filter(Boolean);
  const withHome = new Set(have.filter(x => /\/home\.xml$/i.test(x)).map(x => x.split('/')[0]));
  let out = res.filter(r => withHome.has(r.folder));
  if (!out.length) out = [...withHome].map(folder => ({ folder, w: 1920, h: 1080, def: false }));
  if (!out.length) out = res.length ? res : [{ folder: 'xml', w: 1920, h: 1080, def: true }];
  if (!out.some(r => r.def)) out[0].def = true;
  return { ...s, path: p, res: out };
}

const ORIG = () => `${KH}/kodicontrol/orig`;
// Make sure the skin lives somewhere writable and we hold a pristine tar of its XML folders.
async function prepareSkin(id) {
  const s = await skinInfo(id);
  const notes = [];
  if (!s.path.startsWith(KH)) {
    const dest = `${KH}/addons/${id}`;
    const r = await exec(`mkdir -p ${q(KH + '/addons')} && cp -a ${q(s.path)} ${q(dest)} && echo ok`, { timeout: 120000 });
    if (!r.out.toString().includes('ok')) throw new Error(`${s.name} is a read-only system skin and copying it to your profile failed: ${r.err.slice(0, 200)}`);
    notes.push(`${s.name} is a built-in skin, so a writable copy was made in your profile; restart Kodi once so it loads that copy`);
    s.path = dest;
  }
  const dirs = s.res.map(r => r.folder);
  const orig = `${ORIG()}/${id}-${s.version}.tar`;
  const colors = `${ORIG()}/${id}-${s.version}-colors.tar`;
  await exec(`mkdir -p ${q(ORIG())} && if [ ! -f ${q(orig)} ]; then rm -f ${q(ORIG() + '/' + id)}-*.tar; cd ${q(s.path)} && tar -cf ${q(orig)} ${dirs.map(q).join(' ')} 2>/dev/null; fi; if [ ! -f ${q(colors)} ] && [ -d ${q(s.path + '/colors')} ]; then cd ${q(s.path)} && tar -cf ${q(colors)} colors 2>/dev/null; fi`, { timeout: 60000 });
  return { s, dirs, orig, colors, notes };
}
// colors/ lives in its own tar so older pristine copies (made before glass support) keep working
async function pristine(p) {
  const r = await exec(`cat ${q(p.orig)}`, { timeout: 60000 });
  if (!r.out.length) throw new Error('Could not read the pristine copy of the skin');
  const c = await exec(`cat ${q(p.colors)} 2>/dev/null`, { timeout: 60000 });
  return { ...parseTar(r.out), ...(c.out.length ? parseTar(c.out) : {}) };
}
async function readSkinXml(id) {
  const s = await skinInfo(id);
  const dirs = s.res.map(r => r.folder);
  const orig = (await sh(`ls ${q(ORIG())}/${id}-${s.version}.tar 2>/dev/null`)).trim();
  const r = await exec(orig ? `cat ${q(orig)}` : `cd ${q(s.path)} && tar -cf - ${dirs.map(q).join(' ')} 2>/dev/null`, { timeout: 60000 });
  return { s, dirs, files: parseTar(r.out) };
}

const MENU_DIR = () => `${KH}/userdata/addon_data/script.skinshortcuts`;
async function readMenu(id, skinPath) {
  const user = `${MENU_DIR()}/${id}-mainmenu.DATA.xml`;
  const xml = await sh(`cat ${q(user)} 2>/dev/null || cat ${q(skinPath + '/shortcuts/mainmenu.DATA.xml')} 2>/dev/null`);
  return xml.includes('<shortcut>') ? xml : '';
}

async function applySkin(id, t, { reload = true } = {}) {
  t = seekT(t);
  const p = await prepareSkin(id);
  const files = await pristine(p);
  const res = p.s.res.find(r => r.def) || p.s.res[0];
  let otherSkin = null, otherExtra = null, other = null, otherXbt = null;
  if (t.osdFrom && t.osdFrom !== id) {
    other = await readSkinXml(t.osdFrom).catch(() => null);
    if (other) {
      otherSkin = other.files;
      // what a full OSD move needs besides the XML: colours, skin strings, the media list and the packed textures
      const sp = other.s.path;
      const [colors, strings, media, settings] = await Promise.all([
        sh(`cat ${q(sp + '/colors/defaults.xml')} 2>/dev/null`),
        sh(`cat ${q(sp)}/language/resource.language.en_gb/strings.po 2>/dev/null`),
        sh(`cd ${q(sp + '/media')} 2>/dev/null && find . -type f ! -name '*.xbt' | sed 's|^\./||'`),
        // the source skin's own settings: its OSD may show parts only for some of them (Nimbus OSD style)
        sh(`cat ${q(KH + '/userdata/addon_data/' + t.osdFrom + '/settings.xml')} 2>/dev/null`),
      ]);
      otherExtra = { colors, strings, settings, media: media.split(/\r?\n/).map(x => x.trim()).filter(Boolean) };
      const xb = await exec(`cat ${q(sp + '/media/Textures.xbt')} 2>/dev/null`, { timeout: 180000 });
      if (xb.out.length > 16) { try { otherXbt = { buf: xb.out, files: xbt.parse(xb.out) }; otherExtra.xbt = new Set(otherXbt.files.keys()); } catch {} }
    }
  }
  const { changed, report, assets = [] } = skin.applyAll(files, t, { dirs: p.dirs, res: [res.w, res.h], otherSkin, otherExtra });
  if (t.osdFrom && t.osdFrom !== id && !otherSkin) report.unshift({ ok: false, text: `OSD source ${t.osdFrom} is not installed; install it first` });
  report.unshift(...p.notes.map(n => ({ ok: true, text: n })));

  const extras = {};
  if (t.posters) { extras['extras/kc/mask.png'] = png.roundedMask(+t.radius || 12); extras['extras/kc/mask_wide.png'] = png.roundedMask(+t.radius || 12, 640, 360); }
  if (t.seekPreview) {
    const b = skin.seekBox(t);
    // drawn at the box's real size: the frame's corners and the picture's (smaller, inset) corners line up evenly
    extras['extras/kc/seek_o.png'] = png.roundedMask(b.r * 200 / b.bw, b.bw, b.bh);
    extras['extras/kc/seek_i.png'] = png.roundedMask(Math.max(0, b.r - b.pad) * 200 / b.w, b.w, b.h);
    extras['extras/kc/white.png'] = png.white();
  }
  if ((t.bgs && t.bgs.some(b => +b.dim)) || (t.fullArt && t.fullArtMode === 'top')) extras['extras/kc/white.png'] = png.white();
  if (t.fullArt && t.fullArtMode === 'top') extras['extras/kc/fade_v.png'] = png.fadeV();
  if (t.glass) extras['extras/kc/glass.png'] = png.glass();
  // OSD move: textures packed in the source's Textures.xbt are unpacked to PNG and uploaded; loose ones are copied below
  const copies = [];
  for (const a of assets) {
    if (a.xbt && otherXbt) { const pngBuf = xbt.toPng(otherXbt.buf, otherXbt.files, a.xbt); if (pngBuf) extras[a.to] = pngBuf; }
    else if (a.from) copies.push(a);
  }
  const upload = { ...changed, ...extras };
  const added = Object.keys(upload).filter(k => !files[k]);
  const manifest = `${KH}/kodicontrol/added-${id}.txt`;
  // restore pristine, drop previously added files, then write the new set
  await exec(`cd ${q(p.s.path)} && [ -f ${q(manifest)} ] && while IFS= read -r f; do [ -n "$f" ] && rm -rf "./$f"; done < ${q(manifest)}; tar -C ${q(p.s.path)} -xf ${q(p.orig)}; [ -f ${q(p.colors)} ] && tar -C ${q(p.s.path)} -xf ${q(p.colors)}; true`, { timeout: 60000 });
  if (Object.keys(upload).length) {
    const r = await exec(`tar -C ${q(p.s.path)} -xf - && printf '%s\\n' ${added.map(q).join(' ') || "''"} > ${q(manifest)}`, { stdin: buildTar(upload), timeout: 60000 });
    if (r.code) throw new Error('Writing skin files failed: ' + r.err.slice(0, 200));
  } else await exec(`rm -f ${q(manifest)}`);
  if (copies.length && other) {
    const cmd = copies.map(a => `mkdir -p ${q(path.posix.dirname(a.to))} && ${a.dir ? `rm -rf ${q(a.to)} && cp -rf` : 'cp -f'} ${q(other.s.path + '/' + a.from)} ${q(a.to)} && echo ${q(a.to)} >> ${q(manifest)}`).join('; ');
    await exec(`cd ${q(p.s.path)} && { ${cmd}; true; }`, { timeout: 60000 });
  }

  // home bar items via Skin Shortcuts
  if (t.hbItems && t.hbItems.length) {
    const origMenu = `${ORIG()}/${id}-mainmenu.DATA.xml`;
    const user = `${MENU_DIR()}/${id}-mainmenu.DATA.xml`;
    await exec(`mkdir -p ${q(MENU_DIR())}; [ -f ${q(origMenu)} ] || { if [ -f ${q(user)} ]; then cp ${q(user)} ${q(origMenu)}; else touch ${q(origMenu + '.none')}; cp ${q(p.s.path + '/shortcuts/mainmenu.DATA.xml')} ${q(origMenu)} 2>/dev/null; fi; }`);
    const xml = await sh(`cat ${q(origMenu)} 2>/dev/null`);
    if (xml.includes('<shortcut>')) {
      await exec(`cat > ${q(user)} && rm -f ${q(MENU_DIR())}/${id}.hash ${q(MENU_DIR())}/*.hash 2>/dev/null; true`, { stdin: skin.filterMenu(xml, t.hbItems) });
      report.push({ ok: true, text: `Home bar: showing ${t.hbItems.length} item(s) via Skin Shortcuts (menu rebuilds on reload)` });
    } else report.push({ ok: false, text: 'Home bar items: this skin does not use Skin Shortcuts, so its menu cannot be filtered from here' });
  } else await restoreMenu(id);

  if (t.osdZoom || t.seekPreview) report.push({ ok: true, text: await ensureHelper() });
  await exec(`mkdir -p ${q(KH + '/kodicontrol')} && touch ${q(patchedMark(id))}`);
  if (!reload) return { report };
  const via = await builtin('ReloadSkin()').catch(e => 'failed: ' + e.message);
  report.push({ ok: !via.startsWith('failed'), text: via.startsWith('failed') ? `Skin reload ${via}` : `Skin reloaded (${via})` });
  return { report };
}
async function restoreMenu(id) {
  const origMenu = `${ORIG()}/${id}-mainmenu.DATA.xml`, user = `${MENU_DIR()}/${id}-mainmenu.DATA.xml`;
  await exec(`if [ -f ${q(origMenu + '.none')} ]; then rm -f ${q(user)} ${q(origMenu)} ${q(origMenu + '.none')}; rm -f ${q(MENU_DIR())}/*.hash; elif [ -f ${q(origMenu)} ]; then cp ${q(origMenu)} ${q(user)} && rm -f ${q(origMenu)} ${q(MENU_DIR())}/*.hash; fi; true`);
}
async function revertSkin(id, { reload = true } = {}) {
  const s = await skinInfo(id);
  const orig = (await sh(`ls ${q(ORIG())}/${id}-*.tar 2>/dev/null | grep -v -- '-colors\\.tar$' | head -1`)).trim();
  if (!orig) return { report: [{ ok: true, text: 'Nothing to revert: Kodi Control has not changed this skin' }] };
  const colors = orig.replace(/\.tar$/, '-colors.tar');
  const manifest = `${KH}/kodicontrol/added-${id}.txt`;
  await exec(`cd ${q(s.path)} && { [ -f ${q(manifest)} ] && while IFS= read -r f; do [ -n "$f" ] && rm -f "./$f"; done < ${q(manifest)}; true; } && tar -xf ${q(orig)} && { [ -f ${q(colors)} ] && tar -xf ${q(colors)}; true; } && rm -f ${q(manifest)} ${q(patchedMark(id))}`, { timeout: 60000 });
  await restoreMenu(id);
  if (!reload) return { report: [{ ok: true, text: 'Skin restored to its original files' }] };
  const via = await builtin('ReloadSkin()').catch(e => 'failed: ' + e.message);
  return { report: [{ ok: true, text: 'Skin restored to its original files' }, { ok: !via.startsWith('failed'), text: via.startsWith('failed') ? `Skin reload ${via}` : `Skin reloaded (${via})` }] };
}

async function uploadBackground(id, local) {
  const isDir = fs.statSync(local).isDirectory();
  const name = path.basename(local).replace(/[^\w.\-]/g, '_');
  const rel = `kodicontrol/bg/${id}/${name}`;
  const files = {};
  if (isDir) {
    for (const f of fs.readdirSync(local)) if (/\.(jpe?g|png|webp|gif)$/i.test(f)) files[f.replace(/[^\w.\-]/g, '_')] = fs.readFileSync(path.join(local, f));
    if (!Object.keys(files).length) throw new Error('That folder has no images');
    await exec(`rm -rf ${q(KH + '/userdata/' + rel)} && mkdir -p ${q(KH + '/userdata/' + rel)} && tar -C ${q(KH + '/userdata/' + rel)} -xf -`, { stdin: buildTar(files), timeout: 120000 });
    return { path: `special://profile/${rel}/`, count: Object.keys(files).length };
  }
  await exec(`mkdir -p ${q(KH + '/userdata/kodicontrol/bg/' + id)} && cat > ${q(KH + '/userdata/' + rel)}`, { stdin: fs.readFileSync(local), timeout: 120000 });
  return { path: `special://profile/${rel}`, count: 1 };
}

// ---------- player process info (everything Kodi's "o" PPI overlay shows, plus extras) ----------
const PPI = [
  ['Video', [
    ['Decoder', 'Player.Process(videodecoder)'], ['HW decoding', 'Player.Process(videohwdecoder)'], ['Codec', 'VideoPlayer.VideoCodec'],
    ['Pixel format', 'Player.Process(pixformat)'], ['Deinterlace', 'Player.Process(deintmethod)'],
    ['Width', 'Player.Process(videowidth)'], ['Height', 'Player.Process(videoheight)'], ['Resolution', 'VideoPlayer.VideoResolution'],
    ['Source FPS', 'Player.Process(videofps)'], ['Aspect (DAR)', 'Player.Process(videodar)'], ['Aspect', 'VideoPlayer.VideoAspect'],
    ['HDR', 'VideoPlayer.HdrType'], ['Stereo mode', 'VideoPlayer.StereoscopicMode'], ['Render FPS', 'System.FPS'],
  ]],
  ['Audio', [
    ['Decoder', 'Player.Process(audiodecoder)'], ['Codec', 'VideoPlayer.AudioCodec'], ['Channels', 'Player.Process(audiochannels)'],
    ['Layout', 'VideoPlayer.AudioChannels'], ['Sample rate', 'Player.Process(audiosamplerate)'], ['Bits/sample', 'Player.Process(audiobitspersample)'],
    ['Language', 'VideoPlayer.AudioLanguage'], ['Passthrough', 'System.AudioPassthrough'],
  ]],
  ['Playback', [
    ['Title', 'Player.Title'], ['File', 'Player.Filenameandpath'], ['Time', 'Player.Time'], ['Duration', 'Player.Duration'],
    ['Speed', 'Player.PlaySpeed'], ['Cache', 'Player.CacheLevel'], ['Buffered', 'Player.ProgressCache'], ['Subtitles', 'VideoPlayer.SubtitlesLanguage'],
    ['Video bitrate', 'Player.Process(videobitrate)'], ['Audio bitrate', 'Player.Process(audiobitrate)'],
  ]],
  ['System', [
    ['CPU', 'System.CpuUsage'], ['Memory', 'System.Memory(used.percent)'], ['CPU temp', 'System.CPUTemperature'],
    ['GPU temp', 'System.GPUTemperature'], ['Screen', 'System.ScreenResolution'],
  ]],
];
async function playerProcessInfo() {
  const labels = PPI.flatMap(([, rows]) => rows.map(r => r[1]));
  const v = await rpc('XBMC.GetInfoLabels', { labels });
  const players = await rpc('Player.GetActivePlayers').catch(() => []);
  return { playing: players.length > 0, groups: PPI.map(([g, rows]) => ({ group: g, rows: rows.map(([name, l]) => ({ name, value: (v[l] || '').trim() })).filter(r => r.value && r.value !== '0') })) };
}

// ---------- IPC ----------
const handlers = {
  'cfg:get': () => {
    const c = { ...cfg.conn };
    delete c.password; delete c.passphrase; delete c.rpcPass;
    return { conn: c, hasPassword: !!cfg.conn.password, hasRpcPass: !!cfg.conn.rpcPass, skins: cfg.skins, saved: cfg.saved, backupDir: cfg.backupDir || defaultBackupDir(), connected: !!ssh };
  },
  'conn:connect': async c => {
    const prev = cfg.conn || {};
    const next = { ...prev, ...c };
    next.password = c.password ? seal(c.password) : prev.password;
    next.passphrase = c.passphrase ? seal(c.passphrase) : prev.passphrase;
    next.rpcPass = c.rpcPass ? seal(c.rpcPass) : prev.rpcPass;
    const t0 = Date.now();
    await connect(next);
    await probe();
    rpcMode = null;
    let rpcOk = true, rpcErr = '', version = '';
    try { const v = await rpc('Application.GetProperties', { properties: ['version', 'name'] }); version = `${v.version.major}.${v.version.minor} ${v.version.tag === 'stable' ? '' : v.version.tag}`.trim(); }
    catch (e) { rpcOk = false; rpcErr = e.message; }
    cfg.conn = next; saveCfg();
    return { ok: true, ms: Date.now() - t0, kodiHome: KH, tools: Object.keys(HAS), rpcOk, rpcErr, rpcMode, version };
  },
  'conn:disconnect': () => { if (ssh) ssh.end(); ssh = null; return true; },
  'conn:route': ({ via, helperPort }) => { cfg.conn.via = ['web', 'helper'].includes(via) ? via : ''; cfg.conn.helperPort = +helperPort || 8099; helperDown = 0; rpcMode = null; saveCfg(); return true; },
  'pick:key': async () => (await dialog.showOpenDialog(win, { title: 'Private key', properties: ['openFile', 'showHiddenFiles'] })).filePaths[0] || '',
  'pick:image': async () => (await dialog.showOpenDialog(win, { title: 'Background image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] })).filePaths[0] || '',
  'pick:folder': async title => (await dialog.showOpenDialog(win, { title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] })).filePaths[0] || '',
  'pick:backup': async () => (await dialog.showOpenDialog(win, { title: 'Backup archive', defaultPath: cfg.backupDir || defaultBackupDir(), properties: ['openFile'], filters: [{ name: 'Backups', extensions: ['tar'] }] })).filePaths[0] || '',
  stats,
  iftop,
  logs,
  'backup:sizes': backupSizes,
  'backup:run': sets => backup(sets),
  'backup:list': listBackups,
  'backup:setDir': d => { cfg.backupDir = d; saveCfg(); return listBackups(); },
  'backup:restore': f => restore(f),
  'backup:reveal': f => shell.showItemInFolder(f),
  'skins:list': listSkins,
  'skins:switch': async id => {
    if (cfg.seek && cfg.seek.on) { const pt = await patchedSkins(); if (!pt.includes(id)) await applySkin(id, cfg.skins[id] || {}, { reload: false }).catch(() => {}); }
    await rpc('Settings.SetSettingValue', { setting: 'lookandfeel.skin', value: id }); return true;
  },
  'skins:install': async id => builtin(`InstallAddon(${id})`),
  'skin:save': ({ id, t }) => { cfg.skins[id] = t; saveCfg(); return true; },
  'skin:apply': ({ id, t }) => { cfg.skins[id] = t; saveCfg(); return applySkin(id, t); },
  'skin:revert': id => revertSkin(id),
  'skin:anims': async id => { const { files } = await readSkinXml(id); return skin.animInventory(files); },
  'skin:menu': async id => { const s = await skinInfo(id); const xml = await readMenu(id, s.path); const o = (await sh(`cat ${q(ORIG() + '/' + id + '-mainmenu.DATA.xml')} 2>/dev/null`)); return skin.parseMenu(o.includes('<shortcut>') ? o : xml); },
  'skin:bgUpload': ({ id, local }) => uploadBackground(id, local),
  'skin:winAnims': async id => skin.winAnimInventory((await readSkinXml(id)).files),
  // Button names: skin strings.po plus Kodi's own strings for $LOCALIZE labels
  'skin:osdButtons': async ({ id, from }) => {
    const r = await readSkinXml(from && from !== id ? from : id);
    const po = await sh(`cat ${q(r.s.path + '/language/resource.language.en_gb/strings.po')} 2>/dev/null; for d in /usr/share/kodi /usr/lib/kodi ${q(KH)}; do f="$d/addons/resource.language.en_gb/resources/strings.po"; [ -f "$f" ] && { cat "$f"; break; }; done`, { timeout: 30000 }).catch(() => '');
    return skin.osdButtons(r.files, skin.parsePo(po));
  },
  // a thumbnail of a skin's OSD: its buttons in order, each with the skin's own icon (loose or from Textures.xbt)
  'skin:osdThumb': async ({ id }) => {
    if (osdThumbCache[id]) return osdThumbCache[id];
    const r = await readSkinXml(id);
    const btns = skin.osdButtons(r.files, {}).filter(b => (b.section || 'Video') === 'Video');
    const want = [...new Set(btns.map(b => (b.tex || '').trim()).filter(t => /^[\w.\-\/ ]+\.(png|jpg)$/i.test(t)))].slice(0, 16);
    const media = r.s.path + '/media';
    const loose = new Set((await sh(`cd ${q(media)} 2>/dev/null && find . -type f ! -name '*.xbt' | sed 's|^\\./||'`)).split(/\r?\n/).map(x => x.trim().toLowerCase()).filter(Boolean));
    let xb = null;
    const icons = [];
    for (const t of want) {
      let buf = null;
      if (loose.has(t.toLowerCase())) buf = (await exec(`cat ${q(media + '/' + t)}`, { timeout: 30000 })).out;
      else {
        if (!xb) { const o = (await exec(`cat ${q(media + '/Textures.xbt')} 2>/dev/null`, { timeout: 180000 })).out; xb = { buf: o, files: o.length > 16 ? xbt.parse(o) : new Map() }; }
        try { buf = xbt.toPng(xb.buf, xb.files, t); } catch {}
      }
      if (buf && buf.length) icons.push({ tex: t, name: (btns.find(b => b.tex === t) || {}).name || '', src: `data:image/${/\.jpg$/i.test(t) ? 'jpeg' : 'png'};base64,${Buffer.from(buf).toString('base64')}` });
    }
    return (osdThumbCache[id] = { id, buttons: btns.length, icons });
  },
  'skin:infoFields': () => Object.keys(skin.INFO_FIELDS),
  'skin:infoItems': async id => skin.infoItems((await readSkinXml(id)).files),
  'player:ppi': playerProcessInfo,
  'np:art': artData,
  'clip:image': async dataUrl => { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); return true; },
  'nfo:export': nfoExport,
  // every listening port on the box, what owns it, and clashes with the ports Kodi / this app are set to use
  'ports:list': async () => {
    const raw = await sh(`netstat -tulnp 2>/dev/null || netstat -tuln; echo ==GS; grep -E 'id="services\\.(webserverport|esport|esportrange|webserver|esallinterfaces|airplay|upnp|zeroconf)"' ${q(KH + '/userdata/guisettings.xml')} 2>/dev/null`, { timeout: 30000 });
    const [ns, gs = ''] = raw.split('==GS');
    const set = Object.fromEntries([...gs.matchAll(/id="services\.(\w+)"[^>]*>([^<]*)</g)].map(m => [m[1], m[2].trim()]));
    const KNOWN = { 22: 'SSH', 111: 'RPC portmapper (NFS)', 137: 'NetBIOS name (Samba)', 138: 'NetBIOS datagram (Samba)', 139: 'Samba (SMB over NetBIOS)', 445: 'Samba (SMB)', 1900: 'UPnP / SSDP', 2049: 'NFS', 3702: 'WS-Discovery (Windows network browsing)', 5353: 'mDNS / Zeroconf (Avahi)', 5355: 'LLMNR name lookup', 9090: 'Kodi JSON-RPC (TCP)', 9777: 'Kodi EventServer (remotes)', 36666: 'Kodi AirTunes', 36667: 'Kodi AirPlay', 51515: 'Hyperion', 8888: 'Plugin proxy' };
    const web = +set.webserverport || 8080, es = +set.esport || 9777, help = +cfg.conn.helperPort || 8099;
    const expect = { [web]: { svc: 'Kodi web server / HTTP JSON-RPC', prog: 'kodi' }, 9090: { svc: 'Kodi JSON-RPC (TCP)', prog: 'kodi' }, [es]: { svc: 'Kodi EventServer (remotes)', prog: 'kodi' }, [help]: { svc: 'Kodi Control helper add-on', prog: 'kodi' } };
    const rows = [];
    for (const l of ns.split('\n')) {
      const m = /^(tcp|udp)6?\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+(?:LISTEN\s+)?(\S+)?/.exec(l.trim());
      if (!m) continue;
      const [, proto, addr, p, pp = ''] = m, port = +p, [pid, prog = ''] = pp.split('/');
      rows.push({ proto, addr: addr === '::' || addr === '0.0.0.0' ? 'all' : addr, port, pid: /^\d+$/.test(pid) ? pid : '', prog, service: (expect[port] && /kodi/.test(prog) ? expect[port].svc : '') || KNOWN[port] || (/kodi/.test(prog) ? 'Kodi (add-on or service)' : port >= 32768 ? 'temporary (assigned by the system)' : '') });
    }
    // one line per port + protocol + program; IPv4 and IPv6 merged
    const seen = new Map();
    for (const r of rows) { const k = r.proto + r.port + r.prog; if (seen.has(k)) { const o = seen.get(k); if (!o.addr.split(', ').includes(r.addr)) o.addr += ', ' + r.addr; } else seen.set(k, { ...r }); }
    const list = [...seen.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
    const issues = [];
    for (const [p, e] of Object.entries(expect)) {
      const on = list.filter(r => r.port === +p && r.proto === (+p === es ? 'udp' : 'tcp'));
      const other = on.filter(r => r.prog && !/kodi/.test(r.prog));
      if (other.length) issues.push({ bad: true, port: +p, text: `Port ${p} is meant for ${e.svc} but ${other.map(r => r.prog).join(', ')} holds it: change one of them` });
      else if (!on.length && +p === help && cfg.conn.via === 'helper') issues.push({ bad: true, port: +p, text: `The helper add-on should listen on ${p} but nothing does: Kodi may not have started it (restart Kodi, or reinstall it from Connection)` });
      else if (!on.length && +p === web && set.webserver === 'true') issues.push({ bad: true, port: +p, text: `Kodi's web server is on but nothing listens on ${p}: another program may have had the port when Kodi started` });
      else if (!on.length && +p === 9090) issues.push({ bad: true, port: 9090, text: 'Nothing listens on 9090: turn on "Allow remote control from applications on this system" in Kodi' });
    }
    const local = list.filter(r => r.port === 9090 && /^(127\.|::1)/.test(r.addr));
    if (local.length && !list.some(r => r.port === 9090 && r.addr.includes('all'))) issues.push({ bad: false, text: 'JSON-RPC 9090 only listens on the box itself: fine for this app (it goes through SSH); other apps on the network need "Allow remote control from applications on other systems"' });
    const dup = {};
    for (const r of list) { const k = r.proto + r.port; (dup[k] ||= new Set()).add(r.prog || '?'); }
    for (const [k, progs] of Object.entries(dup)) if (progs.size > 1) issues.push({ bad: true, port: +k.replace(/D/g, ''), text: `${k.replace(/^(tcp|udp)/, '$1 ')} is open by more than one program: ${[...progs].join(', ')}` });
    // two of the configured ports set to the same number: whichever starts second can't open it
    const cfgd = [['Kodi web server', web, 'tcp'], ['Kodi JSON-RPC', 9090, 'tcp'], ['Kodi EventServer', es, 'udp'], ...(cfg.conn.via === 'helper' ? [['Kodi Control helper', help, 'tcp']] : [])];
    for (let i = 0; i < cfgd.length; i++) for (let j = i + 1; j < cfgd.length; j++)
      if (cfgd[i][1] === cfgd[j][1] && cfgd[i][2] === cfgd[j][2]) issues.push({ bad: true, port: cfgd[i][1], text: `${cfgd[i][0]} and ${cfgd[j][0]} are both set to port ${cfgd[i][1]}: only one can have it` });
    // well-known ports taken by something unexpected (e.g. a web add-on on Samba's 445)
    for (const r of list) if (KNOWN[r.port] && r.prog && r.port < 1024 && /kodi/.test(r.prog) && r.port !== 22) issues.push({ bad: true, port: r.port, text: `Kodi (or one of its add-ons) holds port ${r.port}, normally ${KNOWN[r.port]}` });
    for (const r of list) r.warn = issues.filter(i => i.bad && i.port === r.port).map(i => i.text).join(' · ');
    return { list, issues, settings: { web, es, helper: help } };
  },
  // Live view text: fills Kodi's on-screen keyboard (done = press OK), or reports whether one is open now
  'kodi:sendText': async ({ text, done }) => { await rpc('Input.SendText', { text: String(text), done: !!done }); return true; },
  'kodi:closeKeyboard': async () => { await rpc('Input.Back'); return true; },
  'kodi:keyboardOpen': async () => {
    const r = await rpc('XBMC.GetInfoLabels', { labels: ['System.CurrentWindow', 'Control.GetLabel(312)', 'Window(10103).Property(heading)'] }).catch(() => ({}));
    const g = await rpc('GUI.GetProperties', { properties: ['currentwindow'] }).catch(() => null);
    return { open: !!(g && g.currentwindow && g.currentwindow.id === 10103), title: (g && g.currentwindow && g.currentwindow.label) || r['System.CurrentWindow'] || '', value: r['Control.GetLabel(312)'] || '' };
  },
  'addons:list': () => { if (!ssh) throw new Error('Not connected'); return addonsList(); },
  'addons:enable': a => { if (!ssh) throw new Error('Not connected'); return addonEnable(a); },
  // seek preview: ffmpeg on the box, the service's settings file, and Kodi's own seek delay / steps
  'seek:status': async () => {
    if (!ssh) throw new Error('Not connected');
    const ff = (await sh(`for p in ${q(KH + '/addons/tools.ffmpeg-tools/bin/ffmpeg')} $(command -v ffmpeg 2>/dev/null); do [ -x "$p" ] && { echo "$p"; break; }; done; true`)).trim();
    const conf = (await sh(`cat ${q(KH + '/userdata/addon_data/script.kodicontrol/seek.json')} 2>/dev/null`)).trim();
    const [delay, steps] = await Promise.all(['videoplayer.seekdelay', 'videoplayer.seeksteps'].map(s => rpc('Settings.GetSettingValue', { setting: s }).then(r => r.value).catch(() => null)));
    let c = {}; try { c = JSON.parse(conf); } catch {}
    return { ffmpeg: ff, conf: c, delay, steps, on: !!(cfg.seek && cfg.seek.on), look: { ...SEEK_LOOK, ...((cfg.seek || {}).look || {}) }, ram: !!c.ram, hidesubs: c.hidesubs !== false, cached: (await sh(`du -sk ${q(KH + '/temp/kcseek')} /tmp/kcseek 2>/dev/null | awk '{s+=$1} END {print s+0}'`)).trim() };
  },
  'seek:installFfmpeg': async () => {
    if (!ssh) throw new Error('Not connected');
    await builtin('InstallAddon(tools.ffmpeg-tools)');
    if (!(cfg.installed ||= []).includes('tools.ffmpeg-tools')) { cfg.installed.push('tools.ffmpeg-tools'); saveCfg(); }
    return 'Kodi is asking on the TV to install "FFmpeg Tools" from the CoreELEC repository. Confirm there, then press Check again.';
  },
  'seek:save': async ({ on, step, width, delay, steps, ram, look, hidesubs }) => {
    if (!ssh) throw new Error('Not connected');
    const c = { on: !!on, step: Math.max(2, Math.min(60, +step || 10)), width: Math.max(160, Math.min(640, +width || 384)), ram: ram === undefined ? !!(cfg.seek && cfg.seek.ram) : !!ram, hidesubs: hidesubs === undefined ? !(cfg.seek && cfg.seek.hidesubs === false) : !!hidesubs };
    if (!cfg.seekOrig) {
      const [d0, s0] = await Promise.all(['videoplayer.seekdelay', 'videoplayer.seeksteps'].map(k => rpc('Settings.GetSettingValue', { setting: k }).then(r => r.value).catch(() => null)));
      if (d0 != null) cfg.seekOrig = { delay: d0, steps: s0 || SEEK_DEFAULT.steps };
    }
    cfg.seek = { ...(cfg.seek || {}), ...c, delay, steps }; if (look) cfg.seek.look = { ...SEEK_LOOK, ...look }; saveCfg();
    await exec(`mkdir -p ${q(KH + '/userdata/addon_data/script.kodicontrol')} && cat > ${q(KH + '/userdata/addon_data/script.kodicontrol/seek.json')}`, { stdin: JSON.stringify(c) });
    const notes = [await ensureHelper()];
    if (delay != null) { await rpc('Settings.SetSettingValue', { setting: 'videoplayer.seekdelay', value: Math.max(0, Math.min(3000, Math.round(+delay / 250) * 250)) }); notes.push(`seek delay ${delay} ms`); }
    if (Array.isArray(steps) && steps.length) { await rpc('Settings.SetSettingValue', { setting: 'videoplayer.seeksteps', value: steps.map(Number) }); notes.push(`seek steps ${steps.join(', ')} s`); }
    return notes.join(' · ');
  },
  'seek:enable': a => { if (!ssh) throw new Error('Not connected'); return seekEnable(a || {}); },
  'seek:apply': async a => {
    if (!ssh) throw new Error('Not connected');
    // the skins only carry the box's look; frame step, delay and steps live in seek.json and Kodi's settings,
    // so the skins are rewritten only when the look changed (each rewrite is several MB on the eMMC)
    const lookOf = () => JSON.stringify({ ...SEEK_LOOK, ...((cfg.seek || {}).look || {}) });
    const before = lookOf(), wasOn = !!(cfg.seek && cfg.seek.on);
    const notes = await handlers['seek:save']({ ...a, on: true });
    if (wasOn && lookOf() === before) return { report: [{ ok: true, text: notes }, { ok: true, text: 'The box looks the same, so the skins were left as they are (nothing rewritten on the box)' }] };
    return { report: [{ ok: true, text: notes }, ...(await seekEverywhere())] };
  },
  'seek:clearCache': async () => { await exec(`rm -rf ${q(KH + '/temp/kcseek')} /tmp/kcseek`); return true; },
  'undo:status': () => { if (!ssh) throw new Error('Not connected'); return undoStatus(); },
  'addons:remove': id => { if (!ssh) throw new Error('Not connected'); return removeAddon(id); },
  'addons:setApp': a => { if (!ssh) throw new Error('Not connected'); return setAppAddon(a); },
  'addons:appState': async id => { if (!ssh) throw new Error('Not connected'); const u = await undoStatus(); return u.addons.find(a => a.id === id); },
  'skin:setPatched': a => { if (!ssh) throw new Error('Not connected'); return setSkinPatched(a); },
  'seek:ram': async ram => { if (!ssh) throw new Error('Not connected'); cfg.seek = { ...(cfg.seek || {}), ram: !!ram }; saveCfg(); await exec(`f=${q(KH + '/userdata/addon_data/script.kodicontrol/seek.json')}; [ -f "$f" ] && python3 -c 'import json,sys;p=sys.argv[1];c=json.load(open(p));c["ram"]=sys.argv[2]=="1";json.dump(c,open(p,"w"))' "$f" ${ram ? 1 : 0}; ${ram ? `rm -rf ${q(KH + '/temp/kcseek')}` : 'rm -rf /tmp/kcseek'}; true`); return ram ? 'Seek frames are now kept in RAM only and deleted when playback stops. Nothing is written to the eMMC.' : 'Seek frames are cached on the eMMC again (the last 3 videos).'; },
  'seek:default': () => { if (!ssh) throw new Error('Not connected'); return seekDefault(); },
  'keymap:default': () => { if (!ssh) throw new Error('Not connected'); return keymapDefault(); },
  'addons:undo': () => { if (!ssh) throw new Error('Not connected'); return addonsUndo(); },
  'art:undo': () => { if (!ssh) throw new Error('Not connected'); return artUndo(); },
  'iptv:undo': () => { if (!ssh) throw new Error('Not connected'); return iptvUndo(); },
  'io:get': () => ioGet(),
  'io:reset': () => { IO = null; ioSample().catch(() => {}); return true; },
  'zoom:get': () => zoomList(),
  'zoom:save': async list => {
    cfg.zoom = list.map(Number).filter(v => isFinite(v) && v >= 0 && v <= 1).slice(0, 8);
    saveCfg();
    // the helper add-on holds the presets the OSD button cycles through: rewrite it straight away when connected
    return ssh ? await ensureHelper() : 'Saved. The helper add-on is updated the next time you connect.';
  },
  'zoom:set': async i => {
    const z = 1 + (zoomList()[i] || 0);
    const players = await rpc('Player.GetActivePlayers');
    if (!players.some(p => p.type === 'video')) throw new Error('Nothing is playing');
    await rpc('Player.SetViewMode', { viewmode: z === 1 ? 'normal' : { zoom: z } });
    return z;
  },
  'helper:install': ensureHelper,
  'helper:installStats': a => { if (!ssh) throw new Error('Not connected'); return installStatsHelper(a); },
  'helper:ping': async () => { try { const t0 = Date.now(); await helperFetch('/stats'); return { ok: true, ms: Date.now() - t0 }; } catch (e) { return { ok: false, error: e.message }; } },
  builtin: cmd => builtin(cmd),
  rpc: ({ method, params }) => rpc(method, params || {}),
  exec: async ({ cmd, mode }) => {
    if (mode === 'kodi-send') return { text: 'via ' + await builtin(cmd) };
    if (mode === 'rpc') {
      const m = /^\s*([\w.]+)\s*(\{[\s\S]*\})?\s*$/.exec(cmd);
      if (!m) throw new Error('Format: Method.Name {"param": 1}');
      return { text: JSON.stringify(await rpc(m[1], m[2] ? JSON.parse(m[2]) : {}), null, 2) };
    }
    const r = await exec(cmd, { timeout: 60000 });
    return { text: r.out.toString() + r.err, code: r.code };
  },
  quick: async name => {
    switch (name) {
      case 'reload': return 'Reloaded via ' + await builtin('ReloadSkin()');
      case 'restart': if (HAS.systemctl && (await exec('systemctl restart kodi')).code === 0) return 'Kodi restarting (systemctl)'; return 'Restart sent via ' + await builtin('RestartApp');
      case 'texcache': await exec(`${STOP}; rm -rf ${q(KH + '/userdata/Thumbnails')}/* ${q(KH + '/userdata/Database')}/Textures*.db; ${START}`, { timeout: 60000 }); return 'Texture cache cleared, Kodi restarted';
      case 'scan': await rpc('VideoLibrary.Scan'); return 'Library update started';
      case 'clean': await rpc('VideoLibrary.Clean'); return 'Library clean started';
      case 'screenshot': return 'Screenshot via ' + await builtin('TakeScreenshot');
      case 'debug': return 'Debug log toggled via ' + await builtin('ToggleDebug');
      case 'repos': return 'Repo refresh via ' + await builtin('UpdateAddonRepos');
      case 'codec': await rpc('Input.ShowCodec'); return 'Codec info shown on the TV';
      case 'reboot': exec('reboot').catch(() => {}); return 'Reboot sent';
    }
    throw new Error('Unknown command');
  },
  'saved:set': list => { cfg.saved = list; saveCfg(); return true; },
};
const needSsh = fn => async a => { if (!ssh) throw new Error('Not connected'); return fn(a); };
const extra = features.make({ exec, sh, stream, q, rpc, builtin, cfg: () => cfg, saveCfg, kh: () => KH, has: () => HAS, dialog, win: () => win, app, send });
for (const [ch, fn] of Object.entries(require('./perf').make({ exec, sh, q, rpc, kh: () => KH, cfg: () => cfg, saveCfg, app }))) handlers[ch] = needSsh(fn);
for (const [ch, fn] of Object.entries(extra)) handlers[ch] = ch.startsWith('pick:') || ch === 'keymap:preview' ? fn : needSsh(fn);
const markInstalled = id => { if (!(cfg.installed ||= []).includes(id)) { cfg.installed.push(id); saveCfg(); } };
handlers['iftop:install'] = needSsh(async () => { const r = await extra['iftop:install'](); if (r.how === 'System Tools add-on') markInstalled('virtual.system-tools'); await probe(); return r; });

for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, async (e, arg) => {
    try { return { ok: true, data: await fn(arg) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

app.whenReady().then(async () => {
  loadCfg();
  const st = process.argv.indexOf('--selftest');
  const di = process.argv.indexOf('--dev-sh'); // dev: `--dev-sh "<cmd>" out.txt` runs one command over the saved connection
  if (di > 0) {
    const out = process.argv[di + 2] || path.join(app.getPath('userData'), 'dev-sh.txt');
    try { await handlers['conn:connect']({}); fs.writeFileSync(out, (await exec(process.argv[di + 1], { timeout: 300000 })).out); }
    catch (e) { fs.writeFileSync(out, 'ERROR ' + e.message); }
    if (ssh) ssh.end();
    return app.exit(0);
  }
  if (st > 0) {
    const out = process.argv[st + 1] && !process.argv[st + 1].startsWith('--') ? process.argv[st + 1] : path.join(app.getPath('userData'), 'selftest.json');
    try { await require('./selftest').run({ handlers, sh, kh: () => KH, out }); }
    catch (e) { fs.writeFileSync(out, JSON.stringify({ crash: e.stack })); }
    if (ssh) ssh.end();
    return app.exit(0);
  }
  // menu bar: tools that open from any page; each item tells the page which tool to open
  const tool = id => () => win && win.webContents.send('menu', id);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Connection…', click: tool('page:conn') }, { label: 'Backups…', click: tool('page:backup') }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Tools', submenu: [
      { label: 'Make local NFO files…', accelerator: 'CmdOrCtrl+N', click: tool('nfo') },
      { label: 'Screenshot tool…', accelerator: 'CmdOrCtrl+Shift+S', click: tool('shot') },
      { label: 'Copy TV screenshot', accelerator: 'CmdOrCtrl+Shift+C', click: tool('shot:copy') },
      { type: 'separator' },
      { label: 'Type text into Kodi…', accelerator: 'CmdOrCtrl+T', click: tool('type') },
      { label: 'Ports on the box', click: tool('ports') },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'Kodi Control on GitHub', click: () => shell.openExternal('https://github.com/easter478/kodi-control') }] },
  ]));
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600, backgroundColor: '#0B1020', title: 'Kodi Control', autoHideMenuBar: false, show: !process.argv.includes('--shots'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // docs: `--shots <outdir> <steps.json>` captures the app's own window contents (no desktop, no window frame).
  // steps: [{ name, js, wait }] — js runs in the page (e.g. "show('skin')"), then after wait ms <name>.png is saved.
  const si = process.argv.indexOf('--shots');
  if (si > 0) {
    const dir = process.argv[si + 1], steps = JSON.parse(fs.readFileSync(process.argv[si + 2], 'utf8'));
    win.webContents.once('did-finish-load', async () => {
      fs.mkdirSync(dir, { recursive: true });
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      await sleep(9000); // auto-connect with the saved connection and the first dashboard refresh
      for (const s of steps) {
        try { if (s.js) await win.webContents.executeJavaScript(s.js); } catch (e) { console.error(s.name, e.message); }
        await sleep(s.wait || 2500);
        if (s.name) console.log(s.name, await win.webContents.executeJavaScript('curPage'));
        if (s.name) fs.writeFileSync(path.join(dir, s.name + '.png'), (await win.webContents.capturePage()).toPNG());
      }
      if (ssh) ssh.end();
      app.exit(0);
    });
  }
});
// closing while the key watch runs must not leave Kodi's debug logging on (it writes to the eMMC)
app.on('window-all-closed', async () => {
  if (ssh) { try { await Promise.race([handlers['keys:watch'](false), new Promise(r => setTimeout(r, 3000))]); } catch {} ssh.end(); }
  app.quit();
});
