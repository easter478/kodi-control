const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
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
            try { const o = JSON.parse(rpcBuf.slice(start, i + 1)); const w = rpcWait.get(o.id); if (w) { rpcWait.delete(o.id); w(o); } } catch {}
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
async function rpc(method, params = {}) {
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
    const r = await rpcTunnelCall(id, body).catch(() => null);
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
<addon id="script.kodicontrol" name="Kodi Control helper" version="1.1.0" provider-name="Kodi Control">
  <requires><import addon="xbmc.python" version="3.0.0"/></requires>
  <extension point="xbmc.python.script" library="default.py"/>
  <extension point="xbmc.addon.metadata">
    <summary lang="en_GB">Zoom presets and helpers used by Kodi Control</summary>
    <platform>all</platform>
  </extension>
</addon>
`;
const HELPER_PY = `import sys, json, xbmc, xbmcgui
PRESETS = [1.0, 1.2, 1.35]
NAMES = ['0', '0.20', '0.35']
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
    if i == 0:
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
async function ensureHelper() {
  const dir = `${KH}/addons/script.kodicontrol`;
  const fresh = (await sh(`[ -f ${q(dir + '/default.py')} ] && cmp -s ${q(dir + '/default.py')} - && echo same`, { stdin: HELPER_PY })).trim() !== 'same';
  if (fresh) await exec(`mkdir -p ${q(dir)} && tar -C ${q(dir)} -xf -`, { stdin: buildTar({ 'addon.xml': HELPER_XML, 'default.py': HELPER_PY }) });
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
  }
  return enabled ? 'Helper add-on ready' : 'Helper add-on copied, but Kodi has not picked it up yet: restart Kodi, then enable "Kodi Control helper" under My add-ons → Program add-ons';
}

// ---------- stats ----------
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
  cfg.conn.helperToken = seal(tok); cfg.conn.helperPort = +port || 8099; saveCfg();
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
    const addon = /((?:plugin|script|service|inputstream|pvr)\.[\w.\-]+)/i.exec(t);
    crashes.push({ file: f, when: ts ? `${ts[1]}-${ts[2]}-${ts[3]} ${ts[4]}:${ts[5]}` : '', signal: sig ? (sig[1] || sig[2]) : 'crash', frame: frame ? frame[1] : '', addon: addon ? addon[1] : '' });
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

async function applySkin(id, t) {
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
  await exec(`cd ${q(p.s.path)} && [ -f ${q(manifest)} ] && while IFS= read -r f; do rm -f "./$f"; done < ${q(manifest)}; tar -C ${q(p.s.path)} -xf ${q(p.orig)}; [ -f ${q(p.colors)} ] && tar -C ${q(p.s.path)} -xf ${q(p.colors)}; true`, { timeout: 60000 });
  if (Object.keys(upload).length) {
    const r = await exec(`tar -C ${q(p.s.path)} -xf - && printf '%s\\n' ${added.map(q).join(' ') || "''"} > ${q(manifest)}`, { stdin: buildTar(upload), timeout: 60000 });
    if (r.code) throw new Error('Writing skin files failed: ' + r.err.slice(0, 200));
  } else await exec(`rm -f ${q(manifest)}`);
  if (copies.length && other) {
    const cmd = copies.map(a => `mkdir -p ${q(path.posix.dirname(a.to))} && cp -f ${q(other.s.path + '/' + a.from)} ${q(a.to)} && echo ${q(a.to)} >> ${q(manifest)}`).join('; ');
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

  if (t.osdZoom) report.push({ ok: true, text: await ensureHelper() });
  const via = await builtin('ReloadSkin()').catch(e => 'failed: ' + e.message);
  report.push({ ok: !via.startsWith('failed'), text: via.startsWith('failed') ? `Skin reload ${via}` : `Skin reloaded (${via})` });
  return { report };
}
async function restoreMenu(id) {
  const origMenu = `${ORIG()}/${id}-mainmenu.DATA.xml`, user = `${MENU_DIR()}/${id}-mainmenu.DATA.xml`;
  await exec(`if [ -f ${q(origMenu + '.none')} ]; then rm -f ${q(user)} ${q(origMenu)} ${q(origMenu + '.none')}; rm -f ${q(MENU_DIR())}/*.hash; elif [ -f ${q(origMenu)} ]; then cp ${q(origMenu)} ${q(user)} && rm -f ${q(origMenu)} ${q(MENU_DIR())}/*.hash; fi; true`);
}
async function revertSkin(id) {
  const s = await skinInfo(id);
  const orig = (await sh(`ls ${q(ORIG())}/${id}-*.tar 2>/dev/null | grep -v -- '-colors\\.tar$' | head -1`)).trim();
  if (!orig) return { report: [{ ok: true, text: 'Nothing to revert: Kodi Control has not changed this skin' }] };
  const colors = orig.replace(/\.tar$/, '-colors.tar');
  const manifest = `${KH}/kodicontrol/added-${id}.txt`;
  await exec(`cd ${q(s.path)} && { [ -f ${q(manifest)} ] && while IFS= read -r f; do [ -n "$f" ] && rm -f "./$f"; done < ${q(manifest)}; true; } && tar -xf ${q(orig)} && { [ -f ${q(colors)} ] && tar -xf ${q(colors)}; true; } && rm -f ${q(manifest)}`, { timeout: 60000 });
  await restoreMenu(id);
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
  'skins:switch': async id => { await rpc('Settings.SetSettingValue', { setting: 'lookandfeel.skin', value: id }); return true; },
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
  'skin:infoFields': () => Object.keys(skin.INFO_FIELDS),
  'skin:infoItems': async id => skin.infoItems((await readSkinXml(id)).files),
  'player:ppi': playerProcessInfo,
  'np:art': artData,
  'zoom:set': async i => {
    const z = [1.0, 1.2, 1.35][i] || 1;
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
const extra = features.make({ exec, sh, q, rpc, builtin, cfg: () => cfg, saveCfg, kh: () => KH, has: () => HAS, dialog, win: () => win, app, send });
for (const [ch, fn] of Object.entries(extra)) handlers[ch] = ch.startsWith('pick:') || ch === 'keymap:preview' ? fn : needSsh(fn);
handlers['iftop:install'] = needSsh(async () => { const r = await extra['iftop:install'](); await probe(); return r; });

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
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600, backgroundColor: '#0B1020', title: 'Kodi Control', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});
app.on('window-all-closed', () => { if (ssh) ssh.end(); app.quit(); });
