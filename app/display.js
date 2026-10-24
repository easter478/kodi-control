// Display modes tab: which HDMI mode the box is in, every refresh-rate switch Kodi made (from kodi.log),
// whether the box's HDMI driver managed each one (from the kernel log), and Kodi's display whitelist.
// A broken switch looks like "Not find VIC = 64 for hpll setting": the driver signals the new mode but can't
// set its pixel clock, so the TV gets a picture that breaks up (menus too) until the mode changes back.
// Every Kodi setting changed here is kept first in cfg.displayOrig, so Put back restores it exactly.

const SETTINGS = {
  whitelist: 'videoscreen.whitelist', adjust: 'videoplayer.adjustrefreshrate', delay: 'videoscreen.delayrefreshchange',
  double: 'videoscreen.whitelistdoublerefreshrate', pulldown: 'videoscreen.whitelistpulldown', whole: 'videoscreen.whitelistwholenumber',
};
const HDMI = '/sys/class/amhdmitx/amhdmitx0';
const LOGS = '/storage/.kodi/temp';

// "0192001080100.00000pstd" -> 1920x1080p 100 Hz
function parseMode(id) {
  const m = /^(\d{5})(\d{5})(\d{3}\.\d{5})([pi])/.exec(id || '');
  return m ? { id, w: +m[1], h: +m[2], hz: +m[3], scan: m[4] } : null;
}
const hzKey = hz => Math.round(hz); // 23.976 and 24 are one mode to the HDMI driver (frac_rate_policy picks the fraction)
// kernel names: 1080p50hz, 1920x1080p100hz, 2160p23.976hz, smpte24hz
function kernelMode(s) {
  const m = /^(?:(\d+)x)?(\d+|smpte)([pi]?)(\d+(?:\.\d+)?)hz/.exec(s || '');
  if (!m) return null;
  m[3] ||= 'p';
  const h = m[2] === 'smpte' ? 2160 : +m[2];
  return { name: s, w: m[1] ? +m[1] : m[2] === 'smpte' ? 4096 : Math.round(h * 16 / 9), h, hz: +m[4], scan: m[3] };
}
const sameMode = (a, b) => a && b && a.h === b.h && hzKey(a.hz) === hzKey(b.hz) && (a.w === b.w || Math.abs(a.w - b.w) < 260);
const t = s => Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) || 0;

// Kodi log lines -> one row per switch; the URL of what was playing is never kept, only its kind
function parseKodi(text, file, tz = '') {
  const rows = [];
  let open = null, want = null;
  for (const l of text.split('\n')) {
    const ts = l.slice(0, 23) + tz;
    if (/VideoPlayer::OpenFile: /.test(l)) {
      const u = l.split('OpenFile: ')[1] || '';
      open = { at: ts, kind: /^pvr:\/\//.test(u) ? 'live TV' : /^https?:\/\//.test(u) ? 'stream' : /^(smb|nfs):\/\//.test(u) ? 'network file' : /^videodb:|^\//.test(u) ? 'file' : 'other' };
    }
    let m = /\[WHITELIST\] Searching the whitelist for: width: (\d+), height: (\d+), fps: ([\d.]+)/.exec(l);
    if (m) want = { w: +m[1], h: +m[2], fps: +m[3] };
    m = /Display resolution (ADJUST|DESKTOP|DEFAULT)? ?: (\d+)x(\d+) @ ([\d.]+)/.exec(l);
    if (m) {
      rows.push({ at: ts, file, why: m[1] === 'ADJUST' ? 'video' : 'back to the menus', video: m[1] === 'ADJUST' ? want : null, playing: open ? open.kind : '', to: { w: +m[2], h: +m[3], hz: +m[4] } });
      want = null;
    }
    if (/CVideoPlayer::CloseFile\(\)/.test(l)) open = null;
  }
  return rows;
}

// kernel log: each mode the HDMI driver was asked for, and whether it could clock it
function parseKernel(text) {
  const ev = [];
  let pending = '';
  for (const l of text.split('\n')) {
    const at = t((l.match(/^\S+/) || [''])[0]); // 2026-10-24T11:57:02+05:30 (or +0530 on older systemd)
    let m = /crtc_atomic_enable-\[\d\] in: new\[([^\]]+)\], old\[([^\]]*)\]/.exec(l);
    if (m) { ev.push({ at, mode: kernelMode(m[1]), from: m[2], bad: [], attr: pending }); pending = ''; continue; }
    m = /decide_color_attr\]:\[([^,\]]+)[^\]]*\]=>attr\[([^\]]+)\]/.exec(l);
    if (m) { pending = m[2]; continue; }
    m = /Not find VIC = (\d+) for hpll setting|calc_pixel_clk 0MHz/.exec(l);
    if (m && ev.length) { const e = ev[ev.length - 1]; if (at - e.at < 6000) e.bad.push(m[1] ? `no clock for VIC ${m[1]}` : 'pixel clock 0 MHz'); continue; }
  }
  for (const e of ev) e.bad = [...new Set(e.bad)];
  return ev;
}

function make({ rpc, sh, q, cfg, saveCfg }) {
  const get = s => rpc('Settings.GetSettingValue', { setting: s }).then(r => r.value).catch(() => null);

  async function status() {
    const [sys, kodiOld, kodiNow, kern] = await Promise.all([
      sh(`echo "tz=$(date +%z)"; echo "mode=$(cat /sys/class/display/mode 2>/dev/null)"; cat ${HDMI}/config 2>/dev/null | grep -E '^(VIC|Colour depth|Colourspace|Colour range)'; echo "cap=$(cat ${HDMI}/disp_cap 2>/dev/null | tr '\\n' ' ')"; echo "dc=$(cat ${HDMI}/dc_cap 2>/dev/null | tr '\\n' ' ')"; true`),
      sh(`grep -hE 'VideoPlayer::OpenFile: |CVideoPlayer::CloseFile|\\[WHITELIST\\] Searching|Display resolution' ${q(LOGS + '/kodi.old.log')} 2>/dev/null | tail -400; true`),
      sh(`grep -hE 'VideoPlayer::OpenFile: |CVideoPlayer::CloseFile|\\[WHITELIST\\] Searching|Display resolution' ${q(LOGS + '/kodi.log')} 2>/dev/null | tail -400; true`),
      sh(`journalctl -k --no-pager -o short-iso 2>/dev/null | grep -E 'crtc_atomic_enable-\\[[0-9]\\] in: new|decide_color_attr\\]:\\[|Not find VIC|calc_pixel_clk 0MHz' | tail -600; true`),
    ]);
    const kv = Object.fromEntries(sys.split('\n').map(l => { const i = l.search(/[:=]/); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean));
    const values = {};
    for (const [k, s] of Object.entries(SETTINGS)) values[k] = await get(s);
    // the mode list Kodi offers for the whitelist
    let options = [];
    try {
      const r = await rpc('Settings.GetSettings', { level: 'expert', filter: { section: 'system', category: 'display' } });
      const w = (r.settings || []).find(s => s.id === SETTINGS.whitelist);
      options = ((w && w.definition && w.definition.options) || []).map(o => ({ ...parseMode(o.value), label: o.label.replace(/\s+/g, ' ').trim() })).filter(o => o.id);
    } catch {}
    const lab = await rpc('XBMC.GetInfoLabels', { labels: ['System.ScreenResolution', 'System.ScreenWidth', 'System.ScreenHeight'] }).catch(() => ({}));
    const desktop = { w: +lab['System.ScreenWidth'] || 0, h: +lab['System.ScreenHeight'] || 0, label: lab['System.ScreenResolution'] || '' };
    // the desktop resolution Kodi returns to (videoscreen.resolution) can differ from what is on screen during a film
    const resId = await get('videoscreen.resolution');
    let guiRes = null;
    try {
      const r = await rpc('Settings.GetSettings', { level: 'basic', filter: { section: 'system', category: 'display' } });
      const s = (r.settings || []).find(x => x.id === 'videoscreen.resolution');
      const o = s && (s.options || []).find(x => x.value === resId);
      const m = o && /(\d+)x(\d+)/.exec(o.label);
      if (m) guiRes = { w: +m[1], h: +m[2], label: o.label.trim() };
    } catch {}

    const kernel = parseKernel(kern);
    const switches = [...parseKodi(kodiOld, 'kodi.old.log', kv.tz || ''), ...parseKodi(kodiNow, 'kodi.log', kv.tz || '')];
    const bootAt = kernel.length ? kernel[0].at - 60000 : Infinity;
    for (const s of switches) {
      const at = t(s.at);
      // the kernel event for this switch: same mode, within a few seconds after Kodi asked for it
      const e = kernel.find(k => k.at >= at - 2000 && k.at <= at + 6000 && sameMode(k.mode, s.to));
      s.hdmi = e ? { mode: e.mode.name, attr: e.attr, bad: e.bad } : null;
      s.state = e ? (e.bad.length ? 'broken' : 'ok') : at < bootAt ? 'unchecked' : 'nomatch';
    }
    // a mode is "broken" when the driver failed it at least once this boot (the kernel log starts at boot)
    const broken = {};
    for (const k of kernel) if (k.bad.length && k.mode) {
      const key = `${k.mode.h}:${hzKey(k.mode.hz)}`;
      (broken[key] ||= { h: k.mode.h, w: k.mode.w, hz: k.mode.hz, name: k.mode.name, times: 0, why: k.bad }).times++;
    }
    // what Kodi may switch to: the whitelist, or when it is empty, every refresh rate at the desktop resolution
    const wl = Array.isArray(values.whitelist) ? values.whitelist : [];
    const base = guiRes || desktop;
    const allowed = wl.length ? options.filter(o => wl.includes(o.id)) : options.filter(o => o.w === base.w && o.h === base.h);
    const brokenList = Object.values(broken).map(b => ({ ...b, allowed: allowed.some(o => o.h === b.h && hzKey(o.hz) === hzKey(b.hz)) }));
    return {
      now: { mode: kv.mode || '', vic: kv.VIC || '', depth: kv['Colour depth'] || '', space: kv.Colourspace || '', range: kv['Colour range'] || '' },
      tvModes: (kv.cap || '').split(/\s+/).filter(Boolean), tvColour: (kv.dc || '').split(/\s+/).filter(Boolean),
      desktop, gui: guiRes, values, options, allowed: allowed.map(o => o.id), wlEmpty: !wl.length,
      switches: switches.slice(-60).reverse(), broken: brokenList, kernelSince: kernel.length ? new Date(kernel[0].at).toISOString() : '',
      orig: cfg().displayOrig || null,
    };
  }

  async function save(changes) {
    const c = cfg(), orig = (c.displayOrig ||= {});
    const done = [];
    for (const [k, v] of Object.entries(changes || {})) {
      const s = SETTINGS[k];
      if (!s || v === undefined) continue;
      if (!(s in orig)) orig[s] = await get(s);
      let val = v;
      if (k === 'whitelist') val = [...new Set((v || []).map(String))].filter(x => parseMode(x));
      if (k === 'adjust') val = Math.max(0, Math.min(2, +v | 0));
      if (k === 'delay') val = Math.max(0, Math.min(200, +v | 0));
      if (['double', 'pulldown', 'whole'].includes(k)) val = !!v;
      await rpc('Settings.SetSettingValue', { setting: s, value: val });
      done.push(k === 'whitelist' ? (val.length ? `whitelist: ${val.length} modes` : 'whitelist: empty (any refresh rate at the desktop resolution)') : `${k}: ${JSON.stringify(val)}`);
    }
    // nothing different from the start any more: drop the record so the Changes list stays clean
    for (const s of Object.keys(orig)) if (JSON.stringify(await get(s)) === JSON.stringify(orig[s])) delete orig[s];
    if (!Object.keys(orig).length) delete c.displayOrig;
    saveCfg();
    return done.length ? 'Saved ' + done.join(' · ') : 'Nothing to change';
  }

  async function undo() {
    const c = cfg(), orig = c.displayOrig || {};
    for (const [s, v] of Object.entries(orig)) if (v !== null) await rpc('Settings.SetSettingValue', { setting: s, value: v });
    const n = Object.keys(orig).length;
    delete c.displayOrig; saveCfg();
    return n ? `Kodi's display settings are back as they were (${n} setting${n === 1 ? '' : 's'})` : 'Nothing to put back';
  }

  return { 'display:status': status, 'display:save': save, 'display:undo': undo };
}

module.exports = { make, parseMode, parseKodi, parseKernel, kernelMode };
