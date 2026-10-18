'use strict';
// Performance: is anything wearing out the box's eMMC, and what is heavy right now.
// Everything here only reads (/proc, file sizes, Kodi's databases opened read-only, JSON-RPC).
// The cleanup actions are separate calls, limited to known paths, and the page asks before each one.
const fs = require('fs');
const path = require('path');

// Runs on the box with its own python3 and prints one JSON object. SAMPLE seconds of watching in the middle.
const PERF_PY = String.raw`
import os, re, json, time, glob, sqlite3, sys
K = sys.argv[1]; SAMPLE = float(sys.argv[2]); MODE = sys.argv[3]
out = {}
def rd(p, d=''):
    try:
        with open(p) as f: return f.read().strip()
    except Exception: return d
def disk():
    for l in rd('/proc/diskstats').split('\n'):
        f = l.split()
        if len(f) > 9 and re.match(r'^(mmcblk\d+|sd[a-z]|nvme\d+n\d+)$', f[2]) and not f[2].startswith('mmcblk0boot'):
            return {'dev': f[2], 'rd': int(f[5]) * 512, 'wr': int(f[9]) * 512}
    return {}
def procio():
    r = {}
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try:
            io = dict(l.split(': ') for l in open('/proc/%s/io' % p).read().split('\n') if l)
            r[p] = (int(io.get('write_bytes', 0)) - int(io.get('cancelled_write_bytes', 0)), rd('/proc/%s/comm' % p))
        except Exception: pass
    return r
def cpu():
    f = rd('/proc/stat').split('\n')[0].split()[1:]
    v = list(map(int, f)); return sum(v), v[3] + (v[4] if len(v) > 4 else 0)
def proccpu():
    r = {}
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try:
            s = rd('/proc/%s/stat' % p); s = s[s.rfind(')') + 2:].split()
            r[p] = int(s[11]) + int(s[12])
        except Exception: pass
    return r
def du(p):
    n = c = 0
    for root, ds, fs in os.walk(p):
        for f in fs:
            try: st = os.lstat(os.path.join(root, f)); n += st.st_size; c += 1
            except Exception: pass
    return n, c
def size(p):
    try: return os.path.getsize(p)
    except Exception: return 0
dev = disk()['dev'] if disk() else 'mmcblk0'
emmc = {'name': rd('/sys/block/%s/device/name' % dev), 'life': rd('/sys/block/%s/device/life_time' % dev), 'eol': rd('/sys/block/%s/device/pre_eol_info' % dev),
        'size': int(rd('/sys/block/%s/size' % dev, '0') or 0) * 512, 'dev': dev}
mem = dict((l.split(':')[0], int(l.split()[1]) * 1024) for l in rd('/proc/meminfo').split('\n') if l)
temps = []
for z in glob.glob('/sys/class/thermal/thermal_zone*/temp'):
    try: temps.append(int(rd(z)) / 1000.0)
    except Exception: pass
out['emmc'] = emmc
out['uptime'] = float(rd('/proc/uptime', '0').split()[0])
out['load'] = rd('/proc/loadavg').split()[:3]
out['mem'] = {'total': mem.get('MemTotal', 0), 'avail': mem.get('MemAvailable', 0)}
out['swap'] = [l.split()[0] for l in rd('/proc/swaps').split('\n')[1:] if l]
out['temp'] = max(temps) if temps else None
out['disk'] = disk()
out['log'] = size(K + '/temp/kodi.log')
out['t'] = time.time()
if MODE == 'overview':
    print(json.dumps(out)); sys.exit()
if MODE == 'running':
    c0, pc0, p0 = cpu(), proccpu(), procio(); time.sleep(SAMPLE); c1, pc1, p1 = cpu(), proccpu(), procio()
    tot = max(1, c1[0] - c0[0]); ps = []
    for p in pc1:
        if p not in pc0: continue
        cp = (pc1[p] - pc0[p]) * 100.0 / tot * (os.cpu_count() or 1)
        rss = 0
        for l in rd('/proc/%s/status' % p).split('\n'):
            if l.startswith('VmRSS:'): rss = int(l.split()[1]) * 1024
        cmd = rd('/proc/%s/cmdline' % p).replace(chr(0), ' ').strip()
        cmd = re.sub(r'(\w+://)[^/@\s]+@', lambda m: m.group(1), cmd)[:200]
        w = p1.get(p, (0,))[0] - p0.get(p, (0,))[0]
        if cp >= 0.5 or rss > 20 * 1048576 or w > 0:
            ps.append({'pid': int(p), 'comm': rd('/proc/%s/comm' % p), 'cpu': round(cp, 1), 'rss': rss, 'wr': w, 'cmd': cmd})
    out['procs'] = sorted(ps, key=lambda x: (-x['cpu'], -x['rss']))[:25]
    out['cpuAll'] = round(100.0 * (1 - (c1[1] - c0[1]) / float(tot)), 1)
    print(json.dumps(out)); sys.exit()

# ---- watch for SAMPLE seconds: who writes, which files change, how fast the log grows ----
d0, p0, c0, pc0, l0, t0 = disk(), procio(), cpu(), proccpu(), size(K + '/temp/kodi.log'), time.time()
time.sleep(SAMPLE)
d1, p1, c1, pc1, l1, t1 = disk(), procio(), cpu(), proccpu(), size(K + '/temp/kodi.log'), time.time()
dt = max(0.1, t1 - t0)
procs = []
for p, (w, comm) in p1.items():
    w0 = p0.get(p, (w, comm))[0]
    cp = (pc1.get(p, 0) - pc0.get(p, 0)) * 100.0 / max(1, (c1[0] - c0[0])) * os.cpu_count() if p in pc0 else 0
    if w - w0 > 0 or cp >= 1: procs.append({'pid': int(p), 'comm': comm, 'wr': w - w0, 'cpu': round(cp, 1)})
procs.sort(key=lambda x: (-x['wr'], -x['cpu']))
out['sample'] = {'secs': round(dt, 1), 'wr': d1.get('wr', 0) - d0.get('wr', 0), 'rd': d1.get('rd', 0) - d0.get('rd', 0),
    'cpu': round(100.0 * (1 - (c1[1] - c0[1]) / float(max(1, c1[0] - c0[0]))), 1), 'log': l1 - l0, 'procs': procs[:12]}
# files changed while watching, and in the last hour / day, grouped by folder (Thumbnails counted on its own)
changed, hour, day = {}, {}, {}
now = time.time()
for root, ds, fs in os.walk('/storage'):
    if root.startswith(('/storage/.update', '/storage/.cache/cores')): continue
    for f in fs:
        p = os.path.join(root, f)
        try: st = os.lstat(p)
        except Exception: continue
        rel = p[len('/storage/'):]
        parts = rel.split('/')
        key = '/'.join(parts[:4]) if rel.startswith('.kodi/userdata/addon_data/') else '/'.join(parts[:3]) if rel.startswith('.kodi/') else '/'.join(parts[:2])
        if st.st_mtime >= t0 - 1:
            e = changed.setdefault(key, [0, 0]); e[0] += 1; e[1] += st.st_size
        if now - st.st_mtime < 3600:
            e = hour.setdefault(key, [0, 0]); e[0] += 1; e[1] += st.st_size
        if now - st.st_mtime < 86400:
            e = day.setdefault(key, [0, 0]); e[0] += 1; e[1] += st.st_size
top = lambda m: sorted(([k, v[0], v[1]] for k, v in m.items()), key=lambda x: -x[2])[:12]
out['changed'], out['hour'], out['day'] = top(changed), top(hour), top(day)

# ---- logs ----
debug = rd(K + '/userdata/advancedsettings.xml')
m = re.search(r'<loglevel[^>]*>\s*(-?\d+)', debug)
lines = []
try:
    with open(K + '/temp/kodi.log', 'rb') as f:
        f.seek(max(0, size(K + '/temp/kodi.log') - 600000)); lines = f.read().decode('utf8', 'replace').split('\n')[-5000:]
except Exception: pass
src = {}
for l in lines:
    mm = re.match(r'^\S+ \S+ T:\d+\s+(\w+) <(\w+)>: (.*)', l)
    if not mm: continue
    lvl, comp, msg = mm.groups()
    a = re.search(r'/addons/([\w.\-]+)/', msg) or re.search(r'\b((?:plugin|script|service|pvr|skin|resource|metadata)\.[\w.\-]+)', msg)
    w0 = re.match(r'([A-Za-z_][\w:]*)', msg)
    who = a.group(1) if a else (w0.group(1) if w0 else '(other %s lines)' % comp)
    e = src.setdefault(who, {'n': 0, 'debug': 0, 'error': 0, 'bytes': 0}); e['n'] += 1; e['bytes'] += len(l) + 1
    if lvl == 'debug': e['debug'] += 1
    if lvl in ('error', 'fatal'): e['error'] += 1
crash = [[os.path.basename(p), size(p), os.path.getmtime(p)] for p in glob.glob(K + '/temp/kodi_crashlog_*.log')]
out['logs'] = {'size': l1, 'old': size(K + '/temp/kodi.old.log'), 'loglevel': m.group(1) if m else None,
    'span': [lines[0][:23] if lines else '', lines[-2][:23] if len(lines) > 1 else ''], 'lines': len(lines),
    'sources': sorted(([k, v['n'], v['debug'], v['error'], v['bytes']] for k, v in src.items()), key=lambda x: -x[4])[:12],
    'crash': sorted(crash, key=lambda x: -x[2])}

# ---- thumbnails ----
TH = K + '/userdata/Thumbnails'
n, c = du(TH)
th = {'bytes': n, 'files': c, 'hour': 0, 'day': 0, 'sample': 0}
for root, ds, fs in os.walk(TH):
    for f in fs:
        try: mt = os.path.getmtime(os.path.join(root, f))
        except Exception: continue
        if now - mt < 3600: th['hour'] += 1
        if now - mt < 86400: th['day'] += 1
        if mt >= t0 - 1: th['sample'] += 1
dbs = sorted(glob.glob(K + '/userdata/Database/Textures*.db'))
if dbs:
    try:
        con = sqlite3.connect('file:%s?mode=ro' % dbs[-1], uri=True, timeout=2)
        th['rows'] = con.execute('select count(*) from texture').fetchone()[0]
        for days in (90, 365):
            r = con.execute("select count(*) from texture t join sizes s on s.idtexture=t.id where s.lastusetime < datetime('now', ?)", ('-%d days' % days,)).fetchone()[0]
            th['unused%d' % days] = r
        # bytes of thumbnails not used for 90 days
        old = [r[0] for r in con.execute("select t.cachedurl from texture t join sizes s on s.idtexture=t.id where s.lastusetime < datetime('now','-90 days')")]
        th['unused90bytes'] = sum(size(os.path.join(TH, u)) for u in old)
        known = set(r[0] for r in con.execute('select cachedurl from texture'))
        orphan = 0; ob = 0
        for root, ds, fs in os.walk(TH):
            for f in fs:
                rp = os.path.relpath(os.path.join(root, f), TH)
                if rp not in known: orphan += 1; ob += size(os.path.join(root, f))
        th['orphans'], th['orphanBytes'] = orphan, ob
        con.close()
    except Exception as e: th['dberr'] = str(e)
out['thumbs'] = th

# ---- databases and add-on data ----
out['dbs'] = sorted(([os.path.basename(p), size(p), os.path.getmtime(p)] for p in glob.glob(K + '/userdata/Database/*.db')), key=lambda x: -x[1])
ad = []
for p in glob.glob(K + '/userdata/addon_data/*'):
    b, cnt = du(p)
    try: mt = max(os.path.getmtime(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)
    except ValueError: mt = 0
    ad.append([os.path.basename(p), b, cnt, mt])
out['addonData'] = sorted(ad, key=lambda x: -x[1])[:15]

# ---- what Kodi Control itself keeps on the box ----
mine = []
for label, p, how in [('Original skin copies (needed for Revert)', K + '/kodicontrol/orig', 'keep'),
                      ('Kodi Control files (backgrounds, markers)', K + '/kodicontrol', 'info'),
                      ('Seek preview frames on the eMMC', K + '/temp/kcseek', 'delete'),
                      ('Seek preview frames in RAM', '/tmp/kcseek', 'delete'),
                      ('Copied USB artwork', K + '/userdata/kodicontrol-art', 'info'),
                      ('Screenshots folder', '/storage/screenshots', 'move')]:
    if os.path.exists(p):
        b, cnt = du(p)
        if label.startswith('Kodi Control files'): b -= du(K + '/kodicontrol/orig')[0]
        mine.append({'label': label, 'path': p, 'bytes': b, 'files': cnt, 'how': how})
for p in sorted(glob.glob('/storage/backup/*')):
    if os.path.isfile(p): mine.append({'label': 'Old archive in /storage/backup', 'path': p, 'bytes': size(p), 'files': 1, 'how': 'move', 'mtime': os.path.getmtime(p)})
out['mine'] = mine
print(json.dumps(out))
`;

function make({ exec, sh, q, rpc, kh, cfg, saveCfg, app }) {
  const run = async (mode, secs = 0) => {
    const r = await exec(`python3 - ${q(kh())} ${+secs || 0} ${mode}`, { stdin: PERF_PY, timeout: (secs + 120) * 1000 });
    const txt = r.out.toString().trim();
    try { return JSON.parse(txt.split('\n').pop()); } catch { throw new Error('Box analysis failed: ' + (r.err || txt).toString().slice(0, 300)); }
  };
  // overview: two quick samples on consecutive calls give the write rate without any waiting
  let prev = null;
  async function overview() {
    const o = await run('overview');
    const [dbg, extra] = await Promise.all(['debug.showloginfo', 'debug.extralogging'].map(s => rpc('Settings.GetSettingValue', { setting: s }).then(r => r.value).catch(() => null)));
    o.debug = { overlay: dbg, extra };
    if (prev && o.disk && prev.disk && o.t > prev.t) {
      const dt = o.t - prev.t;
      o.rate = { wr: (o.disk.wr - prev.disk.wr) / dt, rd: (o.disk.rd - prev.disk.rd) / dt, log: (o.log - prev.log) / dt, secs: dt };
    }
    prev = o;
    o.verdict = verdict(o);
    return o;
  }
  // eMMC wear: JEDEC life_time is 0x01 = 0-10% used ... 0x0A = 90-100%, 0x0B = past its rated life
  const life = s => { const v = String(s || '').split(/\s+/).map(x => parseInt(x, 16)).filter(n => !isNaN(n)); return v.length ? Math.max(...v) : null; };
  function verdict(o) {
    const v = [];
    const l = life(o.emmc && o.emmc.life);
    if (l != null) v.push({ k: 'emmc', level: l >= 9 ? 'red' : l >= 5 ? 'amber' : 'green', text: `eMMC wear ${l <= 10 ? `${(l - 1) * 10}–${l * 10}%` : 'past rated life'} used${o.emmc.eol && o.emmc.eol !== '0x01' ? ` · pre-EOL flag ${o.emmc.eol}` : ''}` });
    if (o.emmc && o.emmc.eol && o.emmc.eol !== '0x01') v.push({ k: 'eol', level: 'red', text: 'The eMMC reports it is close to the end of its life (pre-EOL flag not normal)' });
    const rate = o.rate ? o.rate.wr : o.sample ? o.sample.wr / o.sample.secs : null;
    if (rate != null) { const day = rate * 86400; v.push({ k: 'writes', level: day > 5e9 ? 'red' : day > 1e9 ? 'amber' : 'green', text: `Writing ${fmt(rate)}/s now, about ${fmt(day)} a day at this rate` }); }
    const lr = o.rate ? o.rate.log : o.sample ? o.sample.log / o.sample.secs : null;
    if (lr != null) v.push({ k: 'log', level: lr * 3600 > 1e6 ? 'amber' : 'green', text: `kodi.log grows ${fmt(lr * 3600)} an hour` });
    if (o.debug && (o.debug.overlay || o.debug.extra)) v.push({ k: 'debug', level: 'amber', text: 'Kodi debug logging is on: it writes a lot more to the log on the eMMC' });
    if (o.logs && o.logs.loglevel && +o.logs.loglevel >= 1) v.push({ k: 'debug', level: 'amber', text: `advancedsettings.xml sets loglevel ${o.logs.loglevel}: debug logging every time Kodi starts` });
    if (o.thumbs && o.sample && o.thumbs.sample > 20 && o.sample.secs >= 30) v.push({ k: 'thumbs', level: 'amber', text: `${o.thumbs.sample} thumbnails written while watching: Kodi is caching artwork right now` });
    if (o.temp != null) v.push({ k: 'temp', level: o.temp >= 80 ? 'red' : o.temp >= 70 ? 'amber' : 'green', text: `Temperature ${o.temp.toFixed(0)} °C` });
    const order = { red: 0, amber: 1, green: 2 };
    return { overall: v.reduce((a, x) => order[x.level] < order[a] ? x.level : a, 'green'), items: v };
  }
  function fmt(b) { b = Math.abs(b); return b < 1024 ? Math.round(b) + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB'; }

  async function analyze({ secs = 60 } = {}) {
    secs = Math.max(10, Math.min(600, +secs || 60));
    const o = await run('analyze', secs);
    const [dbg, extra, epg] = await Promise.all(['debug.showloginfo', 'debug.extralogging', 'epg.epgupdate'].map(s => rpc('Settings.GetSettingValue', { setting: s }).then(r => r.value).catch(() => null)));
    o.debug = { overlay: dbg, extra }; o.epgUpdate = epg;
    // growth since the last Analyze, kept on this PC
    const last = cfg().perfLast;
    if (last && last.t) {
      o.since = { t: last.t, hours: (o.t - last.t) / 3600, thumbs: o.thumbs.bytes - (last.thumbs || 0), thumbFiles: o.thumbs.files - (last.thumbFiles || 0), dbs: {}, addonData: {} };
      for (const [n, b] of o.dbs) if (last.dbs && last.dbs[n] != null) o.since.dbs[n] = b - last.dbs[n];
      for (const [n, b] of o.addonData) if (last.addonData && last.addonData[n] != null) o.since.addonData[n] = b - last.addonData[n];
    }
    cfg().perfLast = { t: o.t, thumbs: o.thumbs.bytes, thumbFiles: o.thumbs.files, dbs: Object.fromEntries(o.dbs.map(d => [d[0], d[1]])), addonData: Object.fromEntries(o.addonData.map(d => [d[0], d[1]])) };
    saveCfg();
    o.verdict = verdict(o);
    return o;
  }

  // ---- cleanup: only these paths, and the page asks first ----
  const allowed = p => {
    const K = kh();
    return [`${K}/temp/kcseek`, '/tmp/kcseek', '/storage/screenshots'].includes(p)
      || /^\/storage\/backup\/[^/]+$/.test(p)
      || new RegExp(`^${K.replace(/[.]/g, '\\.')}/temp/kodi_crashlog_[\\w-]+\\.log$`).test(p);
  };
  async function debugOff() {
    await rpc('Settings.SetSettingValue', { setting: 'debug.showloginfo', value: false }).catch(() => {});
    await rpc('Settings.SetSettingValue', { setting: 'debug.extralogging', value: false }).catch(() => {});
    return 'Kodi debug logging is off';
  }
  async function crashLogs() {
    const K = kh();
    await exec(`rm -f ${q(K + '/temp')}/kodi_crashlog_*.log; [ -L ${q(K + '/temp/kodi_crash.log')} ] && rm -f ${q(K + '/temp/kodi_crash.log')}; true`);
    return 'Old crash logs deleted';
  }
  async function del(p) {
    if (!allowed(p)) throw new Error('Kodi Control only deletes its own cache, crash logs, screenshots and /storage/backup archives');
    await exec(`rm -rf ${q(p)}`);
    return `${p} deleted`;
  }
  // copy to this PC, check the size matches, then delete from the box
  async function moveToPc(p) {
    if (!allowed(p) || p.includes('kcseek')) throw new Error('Not a file Kodi Control moves');
    const dir = path.join(cfg().backupDir || app.getPath('documents'), 'kodi-box-files');
    fs.mkdirSync(dir, { recursive: true });
    const isDir = (await sh(`[ -d ${q(p)} ] && echo d; true`)).trim() === 'd';
    const name = path.posix.basename(p) + (isDir ? '.tar' : '');
    const r = await exec(isDir ? `tar -C ${q(path.posix.dirname(p))} -cf - ${q(path.posix.basename(p))}` : `cat ${q(p)}`, { timeout: 600000 });
    if (r.code) throw new Error('Copy failed: ' + r.err.toString().slice(0, 200));
    const want = isDir ? null : +(await sh(`stat -c %s ${q(p)}`)).trim();
    if (want != null && r.out.length !== want) throw new Error(`Copy was ${r.out.length} bytes, the file is ${want}: nothing deleted`);
    const dest = path.join(dir, name);
    fs.writeFileSync(dest, r.out);
    if (fs.statSync(dest).size !== r.out.length) throw new Error('Saving on this PC failed: nothing deleted');
    await exec(isDir ? `rm -rf ${q(p)}/*` : `rm -f ${q(p)}`);
    return `Moved to ${dest} and deleted from the box`;
  }

  return {
    'perf:overview': overview,
    'perf:analyze': analyze,
    'perf:running': () => run('running', 2),
    'perf:debugOff': debugOff,
    'perf:crashLogs': crashLogs,
    'perf:delete': del,
    'perf:moveToPc': moveToPc,
  };
}
module.exports = { make, PERF_PY };
