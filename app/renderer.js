'use strict';
const $ = id => document.getElementById(id);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const call = (ch, arg) => window.kc.call(ch, arg);
const fmtBytes = b => b == null ? '–' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const fmtBits = b => b == null ? '–' : b < 1e3 ? b + ' b/s' : b < 1e6 ? (b / 1e3).toFixed(0) + ' Kb/s' : (b / 1e6).toFixed(1) + ' Mb/s';
const fmtTime = t => t ? `${t.hours ? t.hours + ':' : ''}${String(t.minutes).padStart(t.hours ? 2 : 1, '0')}:${String(t.seconds).padStart(2, '0')}` : '';
const fmtUp = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };

let toastT;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast on' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast' + (err ? ' err' : ''), err ? 7000 : 3500);
}
// Run an async action with a busy button and error toast.
async function act(btn, fn) {
  const label = btn && btn.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + label; }
  try { return await fn(); }
  catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': /, ''), true); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = label; } }
}
const needConn = () => { if (!S.connected) { toast('Not connected. Set up SSH first.', true); show('conn'); return false; } return true; };
const report = (el, rows) => el.innerHTML = rows.map(r => `<div><span class="tag ${r.ok ? 'ok' : 'warn'}">${r.ok ? 'ok' : 'note'}</span><span>${esc(r.text)}</span></div>`).join('');

const S = { cfg: null, connected: false, info: null, skins: [], current: '', menu: [] };

// ---------- nav ----------
const I = p => `<svg class="i" viewBox="0 0 24 24">${p}</svg>`;
const pages = [['dashboard', 'Dashboard', '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'],
  ['skin', 'Skin tweaks', '<path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/>'],
  ['osd', 'OSD themes', '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15h12"/>'],
  ['preview', 'Live view', '<rect x="2" y="4" width="20" height="13" rx="2"/><circle cx="12" cy="10.5" r="2.5"/><path d="M8 21h8"/>'],
  ['keymaps', 'Keymaps', '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'],
  ['files', 'Pull files', '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 10v6M9 13l3 3 3-3"/>'],
  ['media', 'Media & IPTV', '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'],
  ['logs', 'Crash logs', '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>'],
  ['backup', 'Backup', '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>'],
  ['themes', 'Themes', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 000 18"/>'],
  ['exp', 'Experimental', '<path d="M9 3h6M10 3v6L4 20h16L14 9V3"/>'],
  ['conn', 'SSH', '<path d="M4 17l6-5-6-5M12 19h8"/>']];
const nav = $('nav');
pages.forEach(([id, n, ic]) => {
  const b = document.createElement('button'); b.innerHTML = I(ic) + n; b.dataset.p = id;
  b.onclick = () => show(id); nav.appendChild(b);
});
nav.insertAdjacentHTML('beforeend', '<div class="conn" id="connBox"><span class="dot off"></span> Not connected</div>');
let curPage = 'dashboard';
function show(id) {
  curPage = id;
  $$('nav button').forEach(x => x.classList.toggle('on', x.dataset.p === id));
  $$('.page').forEach(p => p.classList.toggle('on', p.id === id));
  if (id === 'dashboard') poll();
  if (id === 'backup' && S.connected && !S.listed) { S.listed = true; loadBackups(); }
  if (id === 'preview') pvLoop();
  if (id === 'keymaps' && S.connected && !KM.loaded) kmLoad();
  if (id === 'keymaps') kwStart(); else kwStop();
  if (id === 'files' && S.connected && !FP.dir) fpOpen(FP.home || '');
  if (id === 'media' && S.connected && !S.mediaLoaded) { S.mediaLoaded = true; usbRefresh(); m3uRefresh(); }
}


function setConn(on, text) {
  S.connected = on;
  $('connBox').innerHTML = `<span class="dot${on ? '' : ' off'}"></span> ${esc(text)}`;
}

// ---------- themes ----------
const themes = [['Modern', [['indigo', 'Indigo Soft', 'default', ['#F5F3FF', '#6366F1', '#059669']], ['midnight', 'Midnight Glass', 'glassmorphism', ['#0B1020', '#818CF8', '#34D399']], ['nord', 'Nord Frost', 'calm arctic', ['#2E3440', '#88C0D0', '#A3BE8C']], ['paper', 'Paper Mono', 'editorial minimal', ['#FAFAF7', '#111', '#0F766E']]]],
  ['Retro', [['synthwave', "Synthwave '84", 'neon 80s', ['#1A0B2E', '#F472B6', '#22D3EE']], ['amber', 'Amber CRT', 'terminal phosphor', ['#0D0800', '#FFB000', '#FFD27A']], ['pixel', 'Pixel 8-bit', 'arcade', ['#1D2B53', '#FFEC27', '#00E436']], ['film', 'Vintage Film', '70s cinema', ['#2B2118', '#E3A857', '#9DBF9E']], ['y2k', 'Y2K Chrome', 'glossy 2000s', ['#DDE6F3', '#3B82F6', '#D946EF']]]],
  ['Futuristic', [['cyberpunk', 'Cyberpunk 2077', 'high contrast neon', ['#05050A', '#FCEE0A', '#00F0FF']], ['hud', 'Sci-Fi HUD', 'FUI cockpit', ['#020B12', '#00D4FF', '#7CFFB2']], ['aurora', 'Aurora Holo', 'holographic glow', ['#0A0F1E', '#5EEAD4', '#C084FC']]]]].concat(window.KC_THEMES_EXT || []);
$('themegroups').innerHTML = themes.map(([g, list]) => `<h3 style="margin:18px 0 10px">${g}</h3><div class="themes">` +
  list.map(([id, n, d, c, ref]) => `<div class="th" data-id="${id}" tabindex="0"${ref ? ` title="Reference: ${esc(ref)}"` : ""}><div class="sw3">${c.map(x => `<i style="background:${x}"></i>`).join('')}</div><div class="n">${n}<small>${d}</small>${ref ? `<small class="ref">${esc(ref)}</small>` : ""}</div></div>`).join('') + '</div>').join('');
function setTheme(id) {
  $$('.th').forEach(x => x.classList.toggle('on', x.dataset.id === id));
  id === 'indigo' ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', id);
  try { localStorage.setItem('kc-theme', id); } catch {}
}
$$('.th').forEach(t => { t.onclick = () => setTheme(t.dataset.id); t.onkeydown = e => e.key === 'Enter' && setTheme(t.dataset.id); });
try { setTheme(localStorage.getItem('kc-theme') || 'midnight'); } catch { setTheme('midnight'); }

// ---------- connection ----------
const authVis = () => $$('[data-auth]').forEach(l => l.style.display = l.dataset.auth === $('cAuth').value ? '' : 'none');
$('cAuth').onchange = authVis;
$('cKeyPick').onclick = async () => { const p = await call('pick:key'); if (p) $('cKey').value = p; };
function connForm() {
  return { host: $('cHost').value.trim(), port: +$('cPort').value || 22, user: $('cUser').value.trim() || 'root', auth: $('cAuth').value,
    password: $('cPass').value, keyPath: $('cKey').value.trim(), passphrase: $('cPhrase').value,
    rpcPort: +$('cRpcPort').value || 8080, rpcUser: $('cRpcUser').value.trim(), rpcPass: $('cRpcPass').value,
    via: $('cVia').value, helperPort: +$('cHelperPort').value || 8099 };
}
async function connect(c, quiet) {
  if (!c.host) { if (!quiet) toast('Enter the Kodi box IP or host name', true); return; }
  $('cStatus').innerHTML = '<span class="spin"></span> Connecting…';
  setConn(false, `Connecting to ${c.host}…`);
  try {
    const r = await call('conn:connect', c);
    S.info = r;
    $('cPass').value = $('cPhrase').value = $('cRpcPass').value = '';
    $('cPass').placeholder = $('cRpcPass').placeholder = '(saved)';
    setConn(true, `SSH ${c.user}@${c.host}`);
    $('connBox').insertAdjacentHTML('beforeend', `<br>${r.version ? 'Kodi ' + esc(r.version) + ' · ' : ''}JSON-RPC ${r.rpcOk ? 'ok' : 'off'}`);
    $('cStatus').innerHTML = `<span class="tag ok">connected in ${r.ms} ms</span>`;
    report($('cReport'), [
      { ok: true, text: `Kodi folder: ${r.kodiHome}` },
      { ok: r.rpcOk, text: r.rpcOk ? `JSON-RPC working (${r.rpcMode || 'ok'})${r.version ? ', Kodi ' + r.version : ''}` : `JSON-RPC not reachable: ${r.rpcErr}. Turn on Settings → Services → Control → "Allow remote control via HTTP" and check the web server user/password.` },
      { ok: true, text: `Tools on the box: ${r.tools.join(', ') || 'none detected'}` },
      { ok: r.tools.includes('iftop'), text: r.tools.includes('iftop') ? 'iftop found, so live per-host bandwidth is available' : 'iftop not installed, so "Streaming from" lists open connections without bandwidth' },
    ]);
    S.listed = false; S.mediaLoaded = false; KM.loaded = false;
    ifInstallVis();
    await loadSkins();
    poll();
    if (curPage === 'backup') { S.listed = true; loadBackups(); }
  } catch (e) {
    setConn(false, 'Not connected');
    $('cStatus').innerHTML = `<span class="tag err">failed</span>`;
    report($('cReport'), [{ ok: false, text: e.message.replace(/^Error invoking remote method '[^']+': /, '') }]);
    if (!quiet) toast('Connection failed: ' + e.message, true);
  }
}
$('cConnect').onclick = () => connect(connForm());
$('cDisconnect').onclick = async () => { await call('conn:disconnect'); setConn(false, 'Disconnected'); $('cStatus').innerHTML = ''; };
window.kc.on('conn', d => { if (!d.ok) { setConn(false, d.error || 'Disconnected'); $('dSub').textContent = 'Connection lost: ' + (d.error || ''); } });

// ---------- dashboard ----------
let polling = false, lastIf = 0;
async function poll() {
  if (polling || !S.connected || curPage !== 'dashboard') return;
  polling = true;
  try {
    const d = await call('stats');
    const L = d.labels || {};
    $('dSub').textContent = `${L['System.FriendlyName'] || d.host || ''} · up ${fmtUp(d.uptime)}${d.rpcError ? ' · JSON-RPC: ' + d.rpcError : ''}`;
    const vw = L['Player.Process(videowidth)'], vh = L['Player.Process(videoheight)'];
    $('dRes').textContent = (L['System.ScreenResolution'] || '–').replace(/\s*-\s*Full Screen/i, '').split(' ')[0] || '–';
    $('dResN').textContent = d.playing && vw ? `Source ${vw}×${vh}${L['Player.Process(videofps)'] ? ' @ ' + parseFloat(L['Player.Process(videofps)']).toFixed(3).replace(/\.?0+$/, '') + ' fps' : ''}${L['VideoPlayer.HdrType'] ? ' · ' + L['VideoPlayer.HdrType'].toUpperCase() : ''}` : (L['System.ScreenResolution'] || '');
    $('dTemp').innerHTML = d.temp != null ? `${d.temp}<small>°C</small>` : '–';
    $('dTempB').style.width = (d.temp ? Math.min(100, d.temp) : 0) + '%';
    $('dTempB').style.background = d.temp >= 75 ? 'var(--danger)' : d.temp >= 60 ? 'var(--warn)' : '';
    $('dCpu').innerHTML = d.cpu != null ? `${d.cpu}<small>%</small>` : '…';
    $('dCpuB').style.width = (d.cpu || 0) + '%';
    if (d.mem) { const pc = Math.round(100 * d.mem.used / d.mem.total); $('dMem').innerHTML = `${fmtBytes(d.mem.used)} <small>/ ${fmtBytes(d.mem.total)}</small>`; $('dMemB').style.width = pc + '%'; }
    $('dIp').textContent = d.ips[0]?.ip || '–';
    $('dIpN').textContent = d.ips.map(i => `${i.iface} ${i.ip}`).join(' · ');
    $('dKodi').textContent = (L['System.BuildVersion'] || '–').split(' ')[0];
    const sk = S.skins.find(s => s.id === d.skin);
    $('dKodiN').textContent = d.skin ? 'Skin: ' + (sk ? sk.name : d.skin) : '';
    const n = d.net || {};
    $('dNet').innerHTML = n.down != null ? `↓ ${fmtBits(Math.round(n.down))} <small>↑ ${fmtBits(Math.round(n.up))}</small>` : '…';
    $('dNetN').textContent = n.rxTotal != null ? `Since boot ↓ ${fmtBytes(n.rxTotal)} · ↑ ${fmtBytes(n.txTotal)}${n.ifaces?.length ? ' · ' + n.ifaces.join(', ') : ''}` : '';
    const disks = d.disks || [], st = disks.find(x => x.mount === '/storage') || disks[0];
    if (st) {
      $('dDisk').innerHTML = `${fmtBytes(st.used)} <small>/ ${fmtBytes(st.total)}</small>`;
      const pc = Math.round(100 * st.used / st.total);
      $('dDiskB').style.width = pc + '%'; $('dDiskB').style.background = pc >= 90 ? 'var(--danger)' : pc >= 75 ? 'var(--warn)' : '';
      $('dDiskN').textContent = disks.map(x => `${x.mount} ${fmtBytes(x.free)} free`).join(' · ');
    }
    if (d.load) {
      $('dLoad').innerHTML = `${d.load.l1.toFixed(2)} <small>${d.load.l5.toFixed(2)} · ${d.load.l15.toFixed(2)}</small>`;
      $('dLoadN').textContent = `${d.cores || '?'} cores${d.freq ? ` · ${d.freq.cur} MHz${d.freq.min !== d.freq.cur ? ` (min ${d.freq.min})` : ''}` : ''} · ${d.load.procs} processes`;
    }
    if (d.kodi) {
      $('dProc').innerHTML = `${fmtBytes(d.kodi.rss)}${d.kodi.cpu != null ? ` <small>${d.kodi.cpu}% CPU</small>` : ''}`;
      $('dProcN').textContent = `${d.kodi.threads} threads${d.kodi.runFor != null ? ' · running ' + fmtUp(Math.round(d.kodi.runFor)) : ''}${d.addons ? ` · ${d.addons} add-ons` : ''}`;
    }
    const lib = d.library;
    if (lib) {
      $('dLib').innerHTML = `${lib.movies ?? 0} <small>movies · ${lib.shows ?? 0} shows</small>`;
      $('dLibN').textContent = [`${lib.episodes ?? 0} episodes`, lib.albums ? `${lib.albums} albums` : '', lib.songs ? `${lib.songs} songs` : '', lib.channels ? `${lib.channels} TV channels` : ''].filter(Boolean).join(' · ');
    }
    if (d.os) { $('dOs').textContent = d.os.name || '–'; $('dOsN').textContent = d.os.kernel ? 'Kernel ' + d.os.kernel : ''; }
    renderPlaying(d.playing, L);
    loadPpi(d.playing);
    if (Date.now() - lastIf > 15000 && d.playing) { lastIf = Date.now(); loadIftop(); }
  } catch (e) { $('dSub').textContent = 'Stats failed: ' + e.message; }
  finally { polling = false; }
}
setInterval(poll, 3000);
function renderPlaying(p, L) {
  if (!p) { $('dPlay').className = 'empty'; $('dPlay').textContent = 'Nothing playing'; return; }
  const it = p.item || {}, pr = p.prop || {};
  const title = it.showtitle ? `${it.showtitle} · S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}` : it.title || it.label || it.file?.split('/').pop() || 'Unknown';
  const sub = it.showtitle ? it.title : it.year || '';
  const tags = [L['Player.Process(videodecoder)'], L['VideoPlayer.HdrType'] && L['VideoPlayer.HdrType'].toUpperCase(), L['VideoPlayer.AudioCodec'] && `${L['VideoPlayer.AudioCodec']}${L['Player.Process(audiochannels)'] ? ' ' + L['Player.Process(audiochannels)'] : ''}`, p.provider, pr.speed === 0 && 'paused'].filter(Boolean);
  $('dPlay').className = '';
  $('dPlay').innerHTML = `<div class="row" style="align-items:flex-start;flex-wrap:nowrap"><div class="poster"${p.thumb ? ` style="background-image:url('${p.thumb}')"` : ''}></div>
    <div style="flex:1;min-width:0"><b style="font-size:17px">${esc(title)}</b><div class="note" style="margin:2px 0 8px">${esc(sub)}</div>
    <div class="row">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="bar"><i style="width:${(pr.percentage || 0).toFixed(1)}%"></i></div>
    <div class="row between note"><span>${fmtTime(pr.time)}</span><span>${fmtTime(pr.totaltime)}</span></div>
    ${p.host ? `<div class="note mono">from ${esc(p.host)}</div>` : ''}</div></div>`;
}
let ppiBusy = false;
function ppiEmpty() { $('ppi').className = 'empty'; $('ppi').textContent = 'Nothing playing'; }
async function loadPpi(playing) {
  if (!playing) return ppiEmpty();
  if (ppiBusy) return;
  ppiBusy = true;
  try {
    const p = await call('player:ppi');
    if (!p.playing) return ppiEmpty();
    $('ppi').className = 'ppi';
    $('ppi').innerHTML = p.groups.filter(g => g.rows.length).map(g => `<div><h4>${esc(g.group)}</h4><table>${g.rows.map(x => `<tr><td class="note">${esc(x.name)}</td><td class="mono">${esc(x.value)}</td></tr>`).join('')}</table></div>`).join('');
  } catch (e) { $('ppiNote').textContent = 'Player info failed: ' + e.message; }
  finally { ppiBusy = false; }
}
async function loadIftop(btn) {
  if (!S.connected) return;
  $('ifNote').innerHTML = '<span class="spin"></span> sampling…';
  await act(btn, async () => {
    const r = await call('iftop');
    const est = x => (x.est ? '≈ ' : '') + fmtBits(x.down), estU = x => (x.est ? '≈ ' : '') + fmtBits(x.up);
    const tot = r.total ? `<tr><td><b>Whole box</b></td><td class="note">${esc((r.total.iface || []).join(', '))}</td><td class="mono"><b>${fmtBits(r.total.down)}</b></td><td class="mono"><b>${fmtBits(r.total.up)}</b></td></tr>` : '';
    $('ifBody').className = r.rows.length || tot ? 'scroll' : 'empty';
    $('ifBody').innerHTML = r.rows.length || tot ? `<table><tr><th>Host</th><th>Source</th><th>Down</th><th>Up</th></tr>${tot}${r.rows.slice(0, 15).map(x =>
      `<tr><td class="mono" style="word-break:break-all">${esc(x.host)}</td><td>${x.source ? `<span class="tag${x.stream ? ' ok' : ''}">${esc(x.source)}</span>` : ''}</td><td class="mono">${est(x)}</td><td class="mono">${estU(x)}</td></tr>`).join('')}</table>` : 'No external connections right now.';
    const st = r.rows.find(x => x.stream);
    $('ifNote').textContent = `Source: ${r.tool}${r.umbrella ? ' · Umbrella installed' : ''}${st ? ` · streaming from ${st.host}` : ''}${r.rows.some(x => x.est) ? ' · ≈ is the whole-box rate (install iftop for per-host numbers)' : ''}`;
  });
  if ($('ifNote').innerHTML.includes('spin')) $('ifNote').textContent = '';
}
$('ifBtn').onclick = e => needConn() && loadIftop(e.currentTarget);
const ifInstallVis = () => $('ifInstall').style.display = S.connected && S.info && !(S.info.tools || []).includes('iftop') ? '' : 'none';
$('ifInstall').onclick = e => needConn() && act(e.currentTarget, async () => {
  const r = await call('iftop:install');
  if (r.done) { (S.info.tools ||= []).push('iftop'); ifInstallVis(); toast(`iftop ready (${r.how}): ${r.path}`); loadIftop($('ifBtn')); }
  else toast(r.note);
});

// ---------- live view ----------
let pvT = null, pvBusy = false, pvTimes = [];
async function pvShot() {
  if (!S.connected || pvBusy) return;
  pvBusy = true;
  const t0 = Date.now();
  try {
    $('pvImg').src = await call('preview:shot');
    $('pvEmpty').style.display = 'none';
    const now = Date.now();
    pvTimes = pvTimes.filter(t => now - t < 5000); pvTimes.push(now);
    const fps = pvTimes.length > 1 ? (pvTimes.length - 1) / ((now - pvTimes[0]) / 1000) : 0;
    $('pvNote').textContent = `Updated ${new Date().toLocaleTimeString()} · frame took ${now - t0} ms` + (fps ? ` · ${fps.toFixed(1)} fps` : '');
  } catch (e) { $('pvNote').textContent = 'Screenshot failed: ' + e.message; }
  finally { pvBusy = false; }
}
function pvLoop() {
  clearTimeout(pvT);
  if (curPage !== 'preview') return;
  if (!S.connected) { $('pvEmpty').style.display = ''; return; }
  if (!$('pvLive').classList.contains('on')) return;
  pvShot().finally(() => { if (curPage === 'preview') pvT = setTimeout(pvLoop, +$('pvRate').value || 0); });
}
$('pvLive').onclick = e => { e.currentTarget.classList.toggle('on'); pvLoop(); };
$('pvRate').onchange = () => { pvTimes = []; pvLoop(); };
$('pvNow').onclick = e => needConn() && act(e.currentTarget, pvShot);
$('pvSave').onclick = () => { if (!$('pvImg').src) return; const a = document.createElement('a'); a.href = $('pvImg').src; a.download = `kodi-${Date.now()}.png`; a.click(); };
async function pvKey(k) {
  if (!needConn()) return;
  try { await call('preview:key', k); if (!($('pvLive').classList.contains('on') && +$('pvRate').value === 0)) setTimeout(pvShot, 350); }
  catch (e) { toast(e.message, true); }
}
$$('[data-rk]').forEach(b => b.onclick = () => pvKey(b.dataset.rk));
const PV_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'select', Backspace: 'back', Escape: 'back', ' ': 'playpause', c: 'menu', i: 'info', h: 'home', m: 'osd', o: 'ppi', x: 'stop', '+': 'volup', '=': 'volup', '-': 'voldown' };
document.addEventListener('keydown', e => {
  if (curPage !== 'preview' || e.ctrlKey || e.altKey || e.metaKey || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const k = PV_KEYS[e.key] || PV_KEYS[e.key.toLowerCase()];
  if (k) { e.preventDefault(); pvKey(k); }
});

// ---------- keymaps ----------
const KM = { list: [], loaded: false, meta: null, names: {} };
const KBD_KEYS = ['up', 'down', 'left', 'right', 'return', 'enter', 'escape', 'backspace', 'space', 'tab', 'home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'menu', 'browser_back', 'play_pause_media', 'stop', 'next_track', 'prev_track', 'volume_up', 'volume_down', 'volume_mute', 'launch_media_select', ...'abcdefghijklmnopqrstuvwxyz0123456789'];
function kmLists() {
  const m = KM.meta;
  $('kmActs').innerHTML = m.actions.flatMap(([, a]) => a).map(a => `<option value="${esc(a)}">`).join('');
  $('kmWins').innerHTML = m.windows.map(w => `<option value="${esc(w)}">`).join('');
  $('kmKeys').innerHTML = [...new Set([...KBD_KEYS, ...m.remoteKeys])].map(k => `<option value="${esc(k)}">`).join('');
}
// Kodi window ids as logged by HandleKey ("window 12005") to keymap section names.
const WIN_IDS = { 10000: 'Home', 10001: 'Programs', 10002: 'Pictures', 10003: 'FileManager', 10004: 'Settings', 10007: 'SystemInfo', 10025: 'Videos', 10028: 'MyVideoPlaylist', 10040: 'AddonBrowser', 10100: 'YesNoDialog', 10103: 'VirtualKeyboard', 10106: 'ContextMenu', 10120: 'MusicOSD', 10134: 'Favourites', 10500: 'MusicPlaylist', 10502: 'Music', 10700: 'TVChannels', 10702: 'TVGuide', 12000: 'SelectDialog', 12002: 'OkDialog', 12003: 'DialogVideoInfo', 12005: 'FullscreenVideo', 12006: 'Visualisation', 12007: 'SlideShow', 12901: 'VideoOSD' };
const kmWinOpts = cur => { const ws = KM.meta?.windows || ['global']; const all = ws.some(w => w.toLowerCase() === cur.toLowerCase()) ? ws : [...ws, cur]; return all.map(w => `<option value="${esc(w)}"${w.toLowerCase() === cur.toLowerCase() ? ' selected' : ''}>${esc(w)}</option>`).join(''); };
const kmLabel = key => /^\d+$/.test(key || '') ? (KM.names[key] || '') : '';
function kmRender() {
  if (!KM.list.length) { $('kmTable').innerHTML = '<tr><td class="empty">No bindings yet. Add one, learn a key, or import from a file below.</td></tr>'; return; }
  $('kmTable').innerHTML = '<tr><th>Window</th><th>Device</th><th>Key / button</th><th>Modifier</th><th>Long press</th><th>Action</th><th></th></tr>' + KM.list.map((b, i) => `<tr data-i="${i}">
    <td><select data-f="window" aria-label="Window">${kmWinOpts(b.window || 'global')}</select></td>
    <td><select data-f="device">${['keyboard', 'remote', 'gamepad'].map(d => `<option${d === b.device ? ' selected' : ''}>${d}</option>`).join('')}</select></td>
    <td><input list="kmKeys" data-f="key" value="${esc(b.key)}" placeholder="e.g. f1, red, 61513"${kmLabel(b.key) ? ` title="${esc(kmLabel(b.key))}"` : ''}>${kmLabel(b.key) ? `<div class="note" style="margin:2px 0 0">${esc(kmLabel(b.key))}</div>` : ''}</td>
    <td><select data-f="mod">${['', 'ctrl', 'shift', 'alt', 'ctrl,shift', 'ctrl,alt', 'super'].map(m => `<option value="${m}"${m === (b.mod || '') ? ' selected' : ''}>${m || '—'}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-f="longpress"${b.longpress ? ' checked' : ''} aria-label="Long press"></td>
    <td><input list="kmActs" data-f="action" value="${esc(b.action)}" placeholder="Action or builtin"></td>
    <td><button class="btn" data-kdel="${i}" aria-label="Delete binding">✕</button></td></tr>`).join('');
  $$('#kmTable [data-f]').forEach(el => el.onchange = () => {
    const b = KM.list[+el.closest('tr').dataset.i];
    b[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value.trim();
  });
  // a datalist only offers entries matching the current text: clear it on focus so the whole list shows
  $$('#kmTable input[list]').forEach(el => {
    el.onfocus = () => { el.dataset.was = el.value; el.placeholder = el.value || el.placeholder; el.value = ''; };
    el.onblur = () => { if (!el.value && el.dataset.was) el.value = el.dataset.was; };
  });
  $$('#kmTable [data-kdel]').forEach(el => el.onclick = () => { KM.list.splice(+el.dataset.kdel, 1); kmRender(); });
}
function kmFiles() {
  const files = KM.meta.files;
  if (!files.length) { $('kmFiles').className = 'empty'; $('kmFiles').textContent = 'No keymap files in userdata/keymaps yet.'; return; }
  $('kmFiles').className = '';
  $('kmFiles').innerHTML = files.map((f, i) => `<details style="margin-bottom:8px"><summary class="row between" style="cursor:pointer"><span><b class="mono">${esc(f.name)}</b> <span class="note">${f.binds.length} bindings${f.name === 'kodicontrol.xml' ? ' · written by this app' : ''}</span></span>${f.name === 'kodicontrol.xml' ? '' : `<button class="btn" data-imp="${i}">Import into my bindings</button>`}</summary>
    <table class="t">${f.binds.slice(0, 300).map(b => `<tr><td class="mono">${esc(b.window)}</td><td>${esc(b.device)}</td><td class="mono">${esc(b.key)}${b.label ? ` <span class="note">${esc(b.label)}</span>` : ''}${b.mod ? ' +' + esc(b.mod) : ''}${b.longpress ? ' (long)' : ''}</td><td class="mono">${esc(b.action)}</td></tr>`).join('')}</table></details>`).join('');
  $$('[data-imp]').forEach(b => b.onclick = e => {
    e.preventDefault();
    const f = files[+b.dataset.imp];
    const seen = new Set(KM.list.map(x => [x.window, x.device, x.key, x.mod, !!x.longpress].join('|')));
    const add = f.binds.filter(x => !seen.has([x.window, x.device, x.key, x.mod, !!x.longpress].join('|'))).map(({ file, ...x }) => x);
    KM.list.push(...add); kmRender();
    toast(`Imported ${add.length} bindings from ${f.name}. Save & reload to apply. You can then delete ${f.name} so the two files don't fight.`);
  });
}
async function kmLoad(btn) {
  if (!S.connected) return;
  await act(btn, async () => {
    KM.meta = await call('keymap:list');
    KM.meta.files.forEach(f => f.binds.forEach(b => { if (b.label) KM.names[b.key] = b.label; }));
    KM.list = (KM.meta.ours || []).map(x => ({ ...x }));
    KM.loaded = true;
    $('kmFile').textContent = KM.meta.dir + '/kodicontrol.xml';
    kmLists(); kmRender(); kmFiles();
  });
  kaLoad();
}
// Keymap Editor add-on (script.keymap) settings
function kaShow(a) {
  $('kaBody').style.display = a.installed ? '' : 'none';
  $('kaVer').textContent = a.installed ? `script.keymap ${a.version}${a.enabled ? '' : ' · disabled'}${a.broken ? ' · broken' : ''}` : '';
  if (!a.installed) { $('kaNote').innerHTML = 'The Keymap Editor add-on is not installed. <button class="btn" id="kaInst">Install on the box</button>'; $('kaInst').onclick = e => act(e.currentTarget, async () => { await call('kmaddon:open', 'install'); toast('Install requested. Confirm on the TV, then Load from box again.'); }); return; }
  $('kaLong').classList.toggle('on', a.settings.longpress);
  $('kaMulti').classList.toggle('on', a.settings.multifile);
  $('kaFile').value = a.settings.filename;
  $('kaFile').disabled = !a.settings.multifile;
  $('kaNote').innerHTML = a.enabled ? `Stored in <span class="mono">${esc(a.file)}</span>` : 'The add-on is disabled in Kodi, so its settings are greyed out there. <button class="btn" id="kaEn">Enable it</button>';
  if (!a.enabled) $('kaEn').onclick = e => act(e.currentTarget, async () => kaShow(await call('kmaddon:open', 'enable')));
}
async function kaLoad() { try { kaShow(await call('kmaddon:get')); } catch (e) { $('kaNote').textContent = e.message; } }
$('kaLong').onclick = () => $('kaLong').classList.toggle('on');
$('kaMulti').onclick = () => { $('kaFile').disabled = !$('kaMulti').classList.toggle('on'); };
$('kaSave').onclick = e => needConn() && act(e.currentTarget, async () => {
  const a = await call('kmaddon:set', { longpress: $('kaLong').classList.contains('on'), multifile: $('kaMulti').classList.contains('on'), filename: $('kaFile').value });
  kaShow(a); toast(a.reloaded ? 'Keymap Editor settings saved and reloaded.' : 'Saved. Kodi will use them next time the add-on starts.');
});
$('kaOpen').onclick = e => needConn() && act(e.currentTarget, async () => { await call('kmaddon:open', 'settings'); toast('Keymap Editor settings opened on the TV.'); });
$('kaRun').onclick = e => needConn() && act(e.currentTarget, async () => { await call('kmaddon:open', 'run'); toast('Keymap Editor started on the TV.'); });
$('kmLoad').onclick = e => needConn() && kmLoad(e.currentTarget);
$('kmAdd').onclick = () => { KM.list.push({ window: 'global', device: 'keyboard', key: '', mod: '', longpress: false, action: '' }); kmRender(); $$('#kmTable [data-f="key"]').pop()?.focus(); };
$('kmLearn').onclick = e => needConn() && act(e.currentTarget, async () => {
  $('kmNote').textContent = 'Listening… press the key on the remote or keyboard now.';
  try {
    const k = await call('keymap:learn');
    const wn = WIN_IDS[k.window] || k.window;
  const win = KM.meta?.windows?.includes(wn) ? wn : 'global';
  if (k.key && /^\d+$/.test(k.id)) KM.names[k.id] = k.key;
    KM.list.push({ window: win, device: k.device === 'gamepad' ? 'keyboard' : k.device, key: k.key || k.id, mod: '', longpress: false, action: '' });
    kmRender();
    $('kmNote').textContent = `Learned ${k.device} key ${k.key || '(no name)'} · code ${k.id} (${k.hex})${k.current ? ' · currently does ' + k.current : ''}. Pick an action, then Save & reload.` + (k.device === 'remote' && !k.key ? ' This remote code has no standard name; choose one from the Key list.' : '');
    $$('#kmTable [data-f="action"]').pop()?.focus();
  } catch (err) { $('kmNote').textContent = err.message; throw err; }
});
$('kmXml').onclick = async () => { const x = await call('keymap:preview', KM.list); $('kmPre').style.display = $('kmPre').style.display === 'none' ? '' : 'none'; $('kmPre').textContent = x; };
$('kmSave').onclick = e => needConn() && act(e.currentTarget, async () => {
  const bad = KM.list.filter(b => !b.key || !b.action);
  if (bad.length) throw new Error(`${bad.length} binding(s) need both a key and an action.`);
  const r = await call('keymap:save', KM.list);
  toast(`Saved ${r.count} bindings and reloaded keymaps`);
  KM.meta = await call('keymap:list'); kmFiles();
});

// ---------- last key pressed (only while the Keymaps page is open) ----------
const KW = { on: false, off: 0, t: null, hist: [], last: null, busy: false, gen: 0 };
async function kwStart() {
  if (KW.on || !S.connected || !$('kwOn').classList.contains('on')) return;
  KW.on = true; const gen = ++KW.gen;
  try { KW.off = (await call('keys:watch', true)).off; $('kwNote').textContent = 'Watching… press any key on the remote or keyboard.'; }
  catch (e) { KW.on = false; $('kwNote').textContent = 'Cannot watch keys: ' + e.message; return; }
  const tick = async () => {
    if (!KW.on || gen !== KW.gen) return;
    if (!S.connected) { KW.on = false; return; }
    try {
      const r = await call('keys:poll', KW.off); KW.off = r.off;
      // prefer the full OnKey line; a raw scancode/LIRC/CEC line alone still shows
      const keys = r.keys.filter((k, i, a) => k.kind === 'key' || !a.slice(i + 1, i + 3).some(x => x.kind === 'key'));
      if (keys.length) kwShow(keys);
    } catch (e) { $('kwNote').textContent = 'Watch error: ' + e.message; }
    if (KW.on && gen === KW.gen) KW.t = setTimeout(tick, 300);
  };
  tick();
}
function kwStop() {
  clearTimeout(KW.t);
  if (!KW.on) return;
  KW.on = false; KW.gen++;
  if (S.connected) call('keys:watch', false).catch(() => {});
}
function kwShow(keys) {
  KW.last = keys[keys.length - 1];
  const k = KW.last;
  $('kwKey').textContent = k.key || k.id || '?';
  $('kwKey').classList.remove('flash'); void $('kwKey').offsetWidth; $('kwKey').classList.add('flash');
  $('kwInfo').innerHTML = `<b>${esc(k.device)}</b>${k.long ? ' · long press' : ''} · Keymap Editor code <b class="mono">${esc(k.id || '–')}</b> ${k.hex ? '(' + esc(k.hex) + ')' : ''}${k.window ? ' · window ' + esc(WIN_IDS[k.window] || k.window) : ''}${k.current ? ' · does <b>' + esc(k.current) + '</b>' : k.kind === 'raw' ? ' · <span class="tag warn">no OnKey line: Kodi may not map this key</span>' : ''}<div class="note mono" style="margin:4px 0 0">${esc(k.time)}</div>`;
  $('kwAdd').disabled = !(k.key || k.id);
  KW.hist = keys.slice().reverse().concat(KW.hist).slice(0, 30);
  $('kwHist').innerHTML = '<tr><th>Time</th><th>Device</th><th>Key</th><th>Code</th><th>Window</th><th>Action</th></tr>' + KW.hist.map(x =>
    `<tr><td class="mono note">${esc(x.time)}</td><td>${esc(x.device)}</td><td class="mono">${esc(x.key || '')}${x.long ? ' <span class="tag">long</span>' : ''}</td><td class="mono note">${esc(x.id || '')}</td><td class="note">${esc(WIN_IDS[x.window] || x.window || '')}</td><td>${esc(x.current || '')}</td></tr>`).join('');
}
$('kwOn').onclick = e => { e.currentTarget.classList.toggle('on'); if (e.currentTarget.classList.contains('on')) kwStart(); else { kwStop(); $('kwNote').textContent = 'Watching is off. Kodi debug logging was put back.'; } };
$('kwAdd').onclick = () => {
  const k = KW.last; if (!k) return;
  const wn = WIN_IDS[k.window] || k.window;
  const win = KM.meta?.windows?.includes(wn) ? wn : 'global';
  if (k.key && /^\d+$/.test(k.id)) KM.names[k.id] = k.key;
  KM.list.push({ window: win, device: k.device === 'gamepad' ? 'keyboard' : k.device, key: k.key || k.id, mod: '', longpress: !!k.long, action: '' });
  kmRender(); $$('#kmTable [data-f="action"]').pop()?.focus();
  toast('Added ' + (k.key || k.id) + '. Pick an action, then Save & reload.');
};

// ---------- pull files ----------
const FOLDER = '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>';
const FP = { dir: '', mode: 'browse', items: [], base: '', sel: new Set(), home: '' };
const fpPath = (d, n) => (d === '/' ? '' : d) + '/' + n;
async function fpOpen(dir, btn) {
  await act(btn, async () => {
    const r = await call('files:list', dir);
    Object.assign(FP, { dir: r.dir, mode: 'browse', base: r.dir, sel: new Set(), items: r.items.map(x => ({ ...x, path: fpPath(r.dir, x.name) })) });
    if (!FP.home) FP.home = r.dir;
    $('fpDir').value = r.dir; fpRender();
  });
}
function fpRender() {
  const f = $('fpFilter').value.trim().toLowerCase();
  const rows = FP.items.filter(x => !f || (x.name || x.path).toLowerCase().includes(f));
  const files = rows.filter(x => !x.dir);
  $('fpTable').innerHTML = (rows.length ? `<tr><th><input type="checkbox" id="fpAll" aria-label="Select all files"${files.length && files.every(x => FP.sel.has(x.path)) ? ' checked' : ''}></th><th>${FP.mode === 'find' ? 'Path' : 'Name'}</th><th>Size</th></tr>` : '') + (rows.map(x => x.dir
    ? `<tr data-d="${esc(x.path)}"><td></td><td>${I(FOLDER)} ${esc(x.name)}</td><td class="note">folder</td></tr>`
    : `<tr><td><input type="checkbox" data-fp="${esc(x.path)}"${FP.sel.has(x.path) ? ' checked' : ''}></td><td class="mono">${esc(FP.mode === 'find' ? x.path.slice(FP.base.length + 1) || x.path : x.name)}</td><td class="mono note">${fmtBytes(x.size)}</td></tr>`).join('') || '<tr><td class="empty">Nothing here.</td></tr>');
  $$('#fpTable [data-d]').forEach(t => t.ondblclick = t.onclick = () => fpOpen(t.dataset.d));
  $$('#fpTable [data-fp]').forEach(c => c.onchange = () => { c.checked ? FP.sel.add(c.dataset.fp) : FP.sel.delete(c.dataset.fp); fpTick(); });
  $('fpAll') && ($('fpAll').onchange = e => { files.forEach(x => e.target.checked ? FP.sel.add(x.path) : FP.sel.delete(x.path)); fpRender(); });
  fpTick();
}
function fpTick() {
  const sel = FP.items.filter(x => FP.sel.has(x.path));
  $('fpPull').disabled = !sel.length;
  const nf = FP.items.filter(x => !x.dir).length, nd = FP.items.length - nf;
  $('fpNote').textContent = (FP.mode === 'find' ? `${nf} file(s) found under ${FP.base}${FP.capped ? ' (first 3000 only)' : ''}` : `${nd} folder(s), ${nf} file(s)`) + (sel.length ? ` · ${sel.length} selected, ${fmtBytes(sel.reduce((a, x) => a + x.size, 0))}` : '');
}
$('fpGo').onclick = e => needConn() && fpOpen($('fpDir').value.trim(), e.currentTarget);
$('fpDir').onkeydown = e => { if (e.key === 'Enter' && needConn()) fpOpen($('fpDir').value.trim()); };
$('fpUp').onclick = () => { if (!needConn()) return; const d = (FP.mode === 'find' ? FP.base : FP.dir) || $('fpDir').value; fpOpen(d.replace(/\/[^/]*\/?$/, '') || '/'); };
$('fpBrowse').onclick = () => needConn() && fpOpen(FP.base || $('fpDir').value.trim());
$('fpFilter').oninput = fpRender;
$('fpQuick').onfocus = () => {
  if ($('fpQuick').options.length > 1) return;
  const k = FP.home || '/storage/.kodi';
  [['Kodi profile', k], ['userdata', k + '/userdata'], ['Logs (temp)', k + '/temp'], ['Addons', k + '/addons'], ['Keymaps', k + '/userdata/keymaps'], ['Addon data', k + '/userdata/addon_data'], ['Thumbnails', k + '/userdata/Thumbnails'], ['Media / USB', '/var/media'], ['/storage', '/storage'], ['/tmp', '/tmp']]
    .forEach(([n, p]) => $('fpQuick').insertAdjacentHTML('beforeend', `<option value="${esc(p)}">${esc(n)} · ${esc(p)}</option>`));
};
$('fpQuick').onchange = e => { const v = e.target.value; e.target.value = ''; if (v && needConn()) fpOpen(v); };
$('fpFind').onclick = e => needConn() && act(e.currentTarget, async () => {
  const dir = $('fpDir').value.trim() || FP.dir;
  const r = await call('files:find', { dir, ext: $('fpExt').value, depth: +$('fpDepth').value });
  Object.assign(FP, { mode: 'find', base: r.dir, capped: r.capped, sel: new Set(r.items.map(x => x.path)), items: r.items.map(x => ({ ...x, dir: false, name: x.path.split('/').pop() })) });
  fpRender();
});
$('fpPull').onclick = e => needConn() && act(e.currentTarget, async () => {
  const paths = FP.items.filter(x => FP.sel.has(x.path)).map(x => x.path);
  const r = await call('files:pull', { paths, base: FP.mode === 'find' ? FP.base : '' });
  if (r.canceled) return;
  $('fpNote').textContent = `Pulled ${r.done} of ${paths.length} file(s), ${fmtBytes(r.bytes)}, into ${r.dest}` + (r.failed.length ? ` · ${r.failed.length} failed: ${r.failed.slice(0, 3).join('; ')}` : '');
  toast(`Pulled ${r.done} file(s) to ${r.dest}`, !!r.failed.length);
});

// ---------- USB posters ----------
let USB = null;
async function usbRefresh(btn) {
  if (!S.connected) return;
  await act(btn, async () => {
    const list = await call('usb:list');
    $('usbMount').innerHTML = list.length ? list.map(m => `<option value="${esc(m.path)}">${esc(m.path)} · ${esc(m.size || '')} (${esc(m.free || '')} free)</option>`).join('') : '<option value="">No USB drives found</option>';
  });
}
$('usbRefresh').onclick = e => needConn() && usbRefresh(e.currentTarget);
function usbRender() {
  const m = USB.matches;
  $('usbApply').disabled = !m.length;
  $('usbNote').textContent = `${USB.images} images on the drive · ${m.length} matched to ${USB.library} library items · ${USB.unmatched.length} not matched`;
  $('usbTable').innerHTML = m.length ? '<tr><th><input type="checkbox" id="usbAll" checked aria-label="Select all"></th><th>Title</th><th>Art</th><th>Image</th><th>Current</th></tr>' + m.map((x, i) =>
    `<tr><td><input type="checkbox" data-um="${i}" checked></td><td>${esc(x.title)} <span class="note">${x.year || ''} · ${x.kind === 'movie' ? 'Movie' : 'TV'}</span></td><td><span class="tag">${x.type}</span></td><td class="mono note">${esc(x.img)}</td><td class="note">${x.current ? 'has art' : '<span class="tag warn">none</span>'}</td></tr>`).join('')
    : '<tr><td class="empty">No images matched a library title.</td></tr>';
  $('usbAll') && ($('usbAll').onchange = e => $$('[data-um]').forEach(c => c.checked = e.target.checked));
}
$('usbScan').onclick = e => needConn() && act(e.currentTarget, async () => {
  const dir = $('usbMount').value;
  if (!dir) throw new Error('Plug in a USB drive and press Find drives.');
  USB = await call('usb:scan', dir); usbRender();
});
$('usbCopy').onclick = e => e.currentTarget.classList.toggle('on');
$('usbApply').onclick = e => needConn() && act(e.currentTarget, async () => {
  const pick = $$('[data-um]').filter(c => c.checked).map(c => USB.matches[+c.dataset.um]);
  if (!pick.length) throw new Error('Select at least one image.');
  const r = await call('usb:apply', { matches: pick, copy: $('usbCopy').classList.contains('on') });
  toast(`Set art on ${r.ok} item(s)${r.copied ? ' · images copied to ' + r.dest : ''}${r.fail.length ? '\n' + r.fail.slice(0, 4).join('\n') : ''}`, !!r.fail.length && !r.ok);
});

// ---------- M3U ----------
let M3U = { dl: null, st: null };
const fmtDate = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const pvSrcVis = () => $$('[data-src]').forEach(l => l.style.display = l.dataset.src === $('pvSrc').value ? '' : 'none');
$('pvSrc').onchange = pvSrcVis;
$('pvCache').onclick = e => e.currentTarget.classList.toggle('on');
async function m3uRefresh(btn) {
  if (!S.connected) return;
  await act(btn, async () => {
    const st = M3U.st = await call('m3u:status');
    $('m3uDir').textContent = st.dir; $('m3uPc').textContent = st.pcDir;
    $('m3uState').innerHTML = st.installed ? '<span class="tag ok">IPTV Simple installed</span>' : '<span class="tag warn">IPTV Simple not installed</span> <span class="note">Install "PVR IPTV Simple Client" in Kodi, then set it up here.</span>';
    $('m3uFiles').innerHTML = st.files.length ? st.files.map(f => `<tr><td class="mono">${esc(f.name)}</td><td>${f.channels} ch</td><td class="note">${fmtBytes(f.size)} · ${fmtDate(f.mtime)}</td><td class="row" style="justify-content:flex-end"><button class="btn" data-mu="${esc(f.name)}">Use</button><button class="btn" data-mb="${esc(f.name)}">Back up</button><button class="btn danger" data-md="${esc(f.name)}">Delete</button></td></tr>`).join('') : '<tr><td class="empty">No playlists in the iptv folder yet.</td></tr>';
    $('m3uBackups').innerHTML = st.backups.length ? st.backups.map(b => `<tr><td class="mono">${esc(b)}</td><td style="text-align:right"><button class="btn" data-mr="${esc(b)}">Restore</button></td></tr>`).join('') : '<tr><td class="empty">No backups yet.</td></tr>';
    const s = st.settings;
    $('pvrNote').innerHTML = st.settingsFile ? `Settings: <span class="mono">${esc(st.settingsFile)}</span>` : 'No settings file yet; one will be created.';
    $('pvFile').innerHTML = st.files.map(f => `<option${s.path.endsWith('/' + f.name) ? ' selected' : ''}>${esc(f.name)}</option>`).join('') || '<option value="">Send a playlist first</option>';
    $('pvSrc').value = s.pathType === '1' ? 'url' : 'file'; pvSrcVis();
    $('pvUrl').value = s.url; $('pvStart').value = s.startNum || 1; $('pvRefresh').value = s.refreshMode === '1' ? s.refreshMins || 60 : 0;
    $('pvEpg').value = s.epgUrl; $('pvLogo').value = s.logoFromEpg || '1';
    $('pvCache').classList.toggle('on', s.cache !== 'false');
    $$('[data-mu]').forEach(b => b.onclick = () => { $('pvSrc').value = 'file'; pvSrcVis(); $('pvFile').value = b.dataset.mu; toast('Selected. Press Apply & reload channels.'); });
    $$('[data-mb]').forEach(b => b.onclick = e => act(e.currentTarget, async () => { const r = await call('m3u:backup', b.dataset.mb); toast(`Backed up to ${r.remote}\nand ${r.local}`); m3uRefresh(); }));
    $$('[data-md]').forEach(b => b.onclick = e => confirm(`Delete ${b.dataset.md} from the box? Back it up first if you might need it.`) && act(e.currentTarget, async () => { await call('m3u:delete', b.dataset.md); m3uRefresh(); }));
    $$('[data-mr]').forEach(b => b.onclick = e => act(e.currentTarget, async () => { const n = await call('m3u:restore', b.dataset.mr); toast(`Restored as ${n}`); m3uRefresh(); }));
  });
}
$('m3uRefresh').onclick = e => needConn() && m3uRefresh(e.currentTarget);
$('m3uDl').onclick = e => act(e.currentTarget, async () => {
  const r = M3U.dl = await call('m3u:download', { url: $('m3uUrl').value.trim(), name: $('m3uName').value.trim() });
  $('m3uDlNote').textContent = `Saved ${r.channels} channels (${fmtBytes(r.size)}) to ${r.local}`;
  $('m3uSend').disabled = false;
});
$('m3uSend').onclick = e => needConn() && M3U.dl && act(e.currentTarget, async () => {
  const r = await call('m3u:push', { local: M3U.dl.local, name: M3U.dl.file });
  toast(`Moved to ${r.remote} (${r.channels} channels)`); m3uRefresh();
});
$('m3uPick').onclick = e => needConn() && act(e.currentTarget, async () => {
  const p = await call('pick:m3u'); if (!p) return;
  const r = await call('m3u:push', { local: p });
  toast(`Sent to ${r.remote} (${r.channels} channels)`); m3uRefresh();
});
// Browse the box for a playlist (USB drives, Downloads, add-on folders) and load it into the IPTV folder.
const isM3u = n => /\.m3u8?$/i.test(n);
const m3uLoad = (btn, p) => act(btn, async () => {
  const r = await call('m3u:import', p);
  toast(`Loaded ${r.file} (${r.channels} channels) into ${r.remote}`); m3uRefresh();
});
const m3uRows = (rows, dirOf) => {
  $('m3uBrList').innerHTML = rows.length ? rows.map(x => `<tr><td class="mono" style="word-break:break-all">${x.dir ? '📁 ' : ''}${esc(x.label)}</td><td class="note">${x.dir ? '' : fmtBytes(x.size)}</td><td style="text-align:right"><button class="btn" data-mbp="${esc(x.path)}" data-mbd="${x.dir ? 1 : ''}">${x.dir ? 'Open' : 'Load'}</button></td></tr>`).join('') : '<tr><td class="empty">No folders or playlists here.</td></tr>';
  $$('[data-mbp]').forEach(b => b.onclick = e => b.dataset.mbd ? m3uOpen(b.dataset.mbp) : m3uLoad(e.currentTarget, b.dataset.mbp));
};
async function m3uOpen(dir) {
  const r = await call('files:list', dir);
  $('m3uPath').value = r.dir;
  const base = r.dir === '/' ? '' : r.dir;
  m3uRows(r.items.filter(x => x.dir || isM3u(x.name)).map(x => ({ ...x, label: x.name, path: `${base}/${x.name}` })));
}
$('m3uBrowse').onclick = e => needConn() && act(e.currentTarget, async () => {
  const box = $('m3uBr'), show = box.style.display === 'none';
  box.style.display = show ? '' : 'none';
  if (show && !$('m3uPath').value) await m3uOpen('/storage');
});
$('m3uGo').onclick = e => act(e.currentTarget, () => m3uOpen($('m3uPath').value.trim() || '/'));
$('m3uPath').onkeydown = e => e.key === 'Enter' && $('m3uGo').click();
$('m3uUp').onclick = e => act(e.currentTarget, () => m3uOpen(($('m3uPath').value.replace(/\/+$/, '').replace(/\/[^/]*$/, '')) || '/'));
$('m3uFind').onclick = e => act(e.currentTarget, async () => {
  const dir = $('m3uPath').value.trim() || '/storage';
  const r = await call('files:find', { dir, ext: 'm3u,m3u8', depth: 8 });
  m3uRows(r.items.map(x => ({ dir: false, size: x.size, label: x.path, path: x.path })));
  toast(`${r.items.length} playlist${r.items.length === 1 ? '' : 's'} under ${dir}`);
});
$('pvApply').onclick = e => needConn() && act(e.currentTarget, async () => {
  const src = $('pvSrc').value;
  if (src === 'file' && !$('pvFile').value) throw new Error('Send a playlist to the box first.');
  if (src === 'url' && !/^https?:\/\//.test($('pvUrl').value.trim())) throw new Error('Enter the playlist URL.');
  const r = await call('m3u:apply', { source: src, file: $('pvFile').value, url: $('pvUrl').value.trim(), startNum: +$('pvStart').value || 1, refreshMins: +$('pvRefresh').value || 0, epgUrl: $('pvEpg').value.trim(), logoFromEpg: $('pvLogo').value, cache: $('pvCache').classList.contains('on') });
  toast(r.restarted ? 'Saved. IPTV Simple reloaded, channels refresh in a few seconds.' : 'Saved. Restart Kodi (or toggle the add-on) to load the new playlist.');
});

// ---------- skins (shared) ----------
const TOP20 = [['Estuary', 'skin.estuary'], ['Arctic Fuse 2', 'skin.arctic.fuse.2'], ['Aeon Nox: SiLVO', 'skin.aeon.nox.silvo'], ['Arctic Horizon 2', 'skin.arctic.horizon.2'], ['Titan Bingie', 'skin.titan.bingie.mod'], ['Aura', 'skin.aura'], ['Embuary', 'skin.embuary-omega'], ['Nimbus', 'skin.nimbus'], ['Confluence', 'skin.confluence'], ['Aeon MQ 8', 'skin.aeonmq8'], ['Mimic LR', 'skin.mimic.lr'], ['Rapier', 'skin.rapier'], ['Unity', 'skin.unity'], ['Bello 9', 'skin.bello.9'], ['Xonfluence', 'skin.xonfluence'], ['Amber', 'skin.amber'], ['Eminence 2', 'skin.eminence.2'], ['fTV', 'skin.ftv'], ['Revolve', 'skin.revolve'], ['Pellucid', 'skin.pellucid']];
const findInstalled = ([name, id]) => S.skins.find(s => s.id === id) || S.skins.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(name.toLowerCase().replace(/[^a-z0-9]/g, '')));
async function loadSkins() {
  try {
    const r = await call('skins:list');
    S.skins = r.skins; S.current = r.current;
  } catch (e) { toast('Could not list skins: ' + e.message, true); }
  const prev = $('skinsel').value;
  const fav = S.skins.find(s => /silvo/i.test(s.id + s.name));
  const opts = S.skins.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.id === S.current ? '  (active)' : ''}</option>`).join('');
  $('skinsel').innerHTML = opts || '<option value="">No skins found</option>';
  $('skinsel').value = S.skins.some(s => s.id === prev) ? prev : (fav || S.skins.find(s => s.id === S.current) || S.skins[0] || {}).id || '';
  $('osdSkin').innerHTML = opts; $('osdSkin').value = $('skinsel').value;
  renderTop20();
  loadSkinState();
}
function renderTop20() {
  $('skins').innerHTML = TOP20.map((e, k) => {
    const s = findInstalled(e);
    return `<div class="skin">#${k + 1} ${esc(e[0])}<small>${s ? (s.id === S.current ? 'Installed · active' : 'Installed') : 'Not installed'}</small>
      <div class="row">${s ? `<button class="btn" data-osd="${esc(s.id)}">Use OSD</button>` : `<button class="btn" data-inst="${esc(e[1])}">Install</button>`}</div></div>`;
  }).join('');
  $$('[data-osd]').forEach(b => b.onclick = () => { $('osdsrc').value = b.dataset.osd; saveOsd(); toast('OSD source set. Press Apply OSD.'); });
  $$('[data-inst]').forEach(b => b.onclick = () => needConn() && act(b, async () => {
    const via = await call('skins:install', b.dataset.inst);
    toast(`Install requested (${via}). Confirm on the TV if Kodi asks, then press Refresh skins.`);
    setTimeout(loadSkins, 15000);
  }));
}
$('skinSwitch').onclick = e => needConn() && act(e.currentTarget, async () => {
  const id = $('skinsel').value;
  if (!confirm(`Switch Kodi to ${$('skinsel').selectedOptions[0]?.text}? Kodi will ask on the TV to keep the skin; confirm there or it reverts.`)) return;
  await call('skins:switch', id); toast('Skin switch sent. Confirm "Keep skin" on the TV.');
  setTimeout(loadSkins, 4000);
});

// ---------- skin tweaks ----------
const DEF = { busy: false, vol: false, topbar: false, hbTransparent: false, posters: false, fullArt: false, fullArtMode: '', fullArtColor: 'FF0B0B0F', radius: 12, speed: 100, anim: '', osdZoom: false, osdFrom: '', bgs: [], hbItems: [], menuId: 9000,
  hbGradients: false, winAnimOff: false, winAnimFiles: [], winAnimVis: false, hideInfo: [], hideItems: [], glass: false, osdHide: [], osdBarH: 0, osdClear: false };
let T = { ...DEF }, tid = '';
function loadSkinState() {
  tid = $('skinsel').value;
  T = { ...DEF, ...((S.cfg && S.cfg.skins && S.cfg.skins[tid]) || {}) };
  for (const k of ['bgs', 'hbItems', 'winAnimFiles', 'hideInfo', 'hideItems', 'osdHide']) T[k] = [...(T[k] || [])];
  const cur = S.skins.find(s => s.id === tid);
  $('skinCur').textContent = cur ? (tid === S.current ? 'active' : 'not active') : '';
  $('skinCur').className = 'tag' + (tid === S.current ? ' cur' : '');
  $$('#skin .sw[data-k]').forEach(s => s.classList.toggle('on', s.dataset.k === 'animOff' ? T.anim === 'off' : !!T[s.dataset.k]));
  $('rad').value = T.radius; $('radv').textContent = T.radius;
  $$('#skin [data-sel]').forEach(el => el.value = T[el.dataset.sel] || '');
  $$('#skin [data-col]').forEach(el => el.value = '#' + String(T[el.dataset.col] || 'FF0B0B0F').slice(2).toLowerCase());
  faVis();
  $('sp').value = T.speed; spLabel();
  $('skinReport').innerHTML = ''; S.menu = [];
  $('menuItems').innerHTML = T.hbItems.length ? T.hbItems.map(k => `<span class="chip on">${esc(k)}</span>`).join('') + '<span class="note" style="margin:0">Press Load menu to edit</span>' : '<span class="empty">Press Load menu.</span>';
  $('anTable').innerHTML = '<tr><td class="empty">Press Scan skin to list every animation in the skin\'s XML.</td></tr>'; $('anNote').textContent = '';
  renderBgs(); preview(); renderHideInfo(); HI = []; renderHI();
  WA = []; $('waTable').innerHTML = '<tr><td class="empty">Press Load windows.</td></tr>'; waNote();
  // OSD page mirrors the same skin
  $('osdSkin').value = tid;
  $('osdsrc').innerHTML = '<option value="">This skin\'s own OSD</option>' + S.skins.filter(s => s.id !== tid).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('osdsrc').value = T.osdFrom || '';
  $$('#osd .sw[data-o]').forEach(s => s.classList.toggle('on', !!T[s.dataset.o]));
  $('ob').value = T.osdBarH || 0; obLabel(); OB = []; renderOsdBtns();
  $('osdReport').innerHTML = '';
}
let saveT;
function save() {
  if (!tid) return;
  if (S.cfg) S.cfg.skins[tid] = JSON.parse(JSON.stringify(T));
  clearTimeout(saveT); saveT = setTimeout(() => call('skin:save', { id: tid, t: T }).catch(() => {}), 300);
}
$('skinsel').onchange = () => loadSkinState();
$('osdSkin').onchange = () => { $('skinsel').value = $('osdSkin').value; loadSkinState(); };
$$('#skin .sw[data-k]').forEach(s => s.onclick = () => {
  const on = !s.classList.toggle('on') ? false : true;
  if (s.dataset.k === 'animOff') T.anim = on ? 'off' : ''; else T[s.dataset.k] = on;
  save(); preview(); faVis();
});
// Full-screen artwork options show only while that toggle is on; colours are stored as Kodi ARGB (FFrrggbb)
function faVis() { $('faOpts').style.display = T.fullArt ? '' : 'none'; $$('#faOpts [data-col]').forEach(el => el.closest('label').style.display = T.fullArtMode === 'top' ? '' : 'none'); }
$$('#skin [data-sel]').forEach(el => el.onchange = () => { T[el.dataset.sel] = el.value; save(); faVis(); });
$$('#skin [data-col]').forEach(el => el.oninput = () => { T[el.dataset.col] = 'FF' + el.value.slice(1).toUpperCase(); save(); });
const spLabel = () => $('spv').textContent = $('sp').value + '%' + (+$('sp').value < 100 ? ' (faster)' : ' (stock)');
$('rad').oninput = e => { T.radius = +e.target.value; $('radv').textContent = T.radius; save(); preview(); };
$('sp').oninput = e => { T.speed = +e.target.value; spLabel(); save(); };
function preview() {
  $('tb').style.display = T.topbar ? 'none' : 'flex';
  $('hb').classList.toggle('solid', !T.hbTransparent);
  $$('#po b').forEach(b => b.style.borderRadius = T.posters ? Math.round(T.radius / 2.5) + 'px' : '0');
  $('vb').style.display = T.vol ? 'none' : 'block';
  const names = T.hbItems.length ? T.hbItems.map(k => (S.menu.find(m => m.key === k) || {}).name || k) : ['Movies', 'TV Shows', 'Music', 'Live TV', 'Add-ons', 'Weather', 'Settings'];
  $('hb').innerHTML = names.slice(0, 7).map((n, i) => `<span${i === 0 ? ' class="f"' : ''}>${esc(n)}</span>`).join('');
}
$('skinApply').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  $('skinReport').innerHTML = '<div class="note">Patching skin files over SSH…</div>';
  const r = await call('skin:apply', { id: tid, t: T });
  report($('skinReport'), r.report);
  if (tid !== S.current) $('skinReport').insertAdjacentHTML('beforeend', `<div><span class="tag warn">note</span><span>This skin is not the active one, so you will see the changes after switching to it.</span></div>`);
});
$('skinRevert').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  if (!confirm('Put back the original skin files? Your saved tweak settings stay here, so you can apply them again later.')) return;
  report($('skinReport'), (await call('skin:revert', tid)).report);
});

// home bar items
$('menuLoad').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  S.menu = await call('skin:menu', tid);
  renderMenu();
});
function renderMenu() {
  if (!S.menu.length) { $('menuItems').innerHTML = '<span class="empty">No Skin Shortcuts menu found for this skin, so its home bar cannot be filtered from here.</span>'; return; }
  $('menuItems').innerHTML = S.menu.map(m => `<label class="chip${T.hbItems.includes(m.key) ? ' on' : ''}${m.disabled ? '" title="Hidden in the skin already' : ''}"><input type="checkbox" data-key="${esc(m.key)}"${T.hbItems.includes(m.key) ? ' checked' : ''}>${esc(m.name || m.key)}${m.kind ? ` <small class="note" style="margin:0">${m.kind}</small>` : ''}</label>`).join('');
  $$('#menuItems input').forEach(c => c.onchange = () => {
    const k = c.dataset.key;
    T.hbItems = c.checked ? [...T.hbItems, k] : T.hbItems.filter(x => x !== k);
    c.parentElement.classList.toggle('on', c.checked); save(); preview();
  });
  preview();
}
$('menuPreset').onclick = async e => {
  if (!S.menu.length) { if (!needConn()) return; await act(e.currentTarget, async () => { S.menu = await call('skin:menu', tid); }); }
  const order = ['movies', 'tvshows', 'livetv', 'apps', 'favourites'];
  const pick = order.map(k => S.menu.find(m => m.kind === k)).filter(Boolean);
  if (!pick.length) { renderMenu(); toast('Could not recognise Movies/TV/Live TV/Apps/Favourites in this skin\'s menu. Tick them by hand.', true); return; }
  T.hbItems = pick.map(m => m.key); save(); renderMenu();
  const miss = order.filter(k => !S.menu.some(m => m.kind === k));
  toast(`Selected ${pick.length} item(s)${miss.length ? '. Not found in this skin: ' + miss.join(', ') : ''}. Press Apply to Kodi.`);
};
$('menuAll').onclick = () => { T.hbItems = []; save(); S.menu.length ? renderMenu() : loadSkinState(); toast('Home bar will use the skin\'s own menu after Apply.'); };

// backgrounds
const BGT = { home: 'Home menu item', addon: 'Add-on / app', movies: 'Movies library', tvshows: 'TV shows library', livetv: 'Live TV', apps: 'Apps / Add-on browser', favourites: 'Favourites', music: 'Music library', weather: 'Weather', settings: 'Settings' };
$('bgTarget').innerHTML = Object.entries(BGT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
const bgHint = () => {
  const t = $('bgTarget').value;
  $('bgValue').style.display = t === 'home' || t === 'addon' ? '' : 'none';
  $('bgValue').placeholder = t === 'home' ? 'Menu item, e.g. movies (Load menu to see keys)' : 'Add-on id, e.g. plugin.video.umbrella';
  $('bgHint').textContent = t === 'home' ? 'Shown behind the home screen while that menu item is focused.' : t === 'addon' ? 'Shown while you are inside that add-on (any of its folders).' : 'Shown behind that window.';
};
$('bgTarget').onchange = bgHint; bgHint();
async function addBg(btn, folder) {
  if (!needConn() || !tid) return;
  const target = $('bgTarget').value, value = $('bgValue').value.trim();
  if ((target === 'home' || target === 'addon') && !value) { toast(target === 'home' ? 'Enter the menu item key first' : 'Enter the add-on id first', true); return; }
  const local = folder ? await call('pick:folder', 'Folder of background images') : await call('pick:image');
  if (!local) return;
  await act(btn, async () => {
    const r = await call('skin:bgUpload', { id: tid, local });
    const label = target === 'home' ? `Home · ${value}` : target === 'addon' ? value : BGT[target];
    T.bgs = T.bgs.filter(b => !(b.target === target && (b.value || '') === value));
    T.bgs.push({ target, value, path: r.path, dim: +$('bgDim').value || 0, label });
    save(); renderBgs();
    toast(`${r.count} image(s) uploaded. Press Apply to Kodi.`);
  });
}
$('bgImg').onclick = e => addBg(e.currentTarget, false);
$('bgDir').onclick = e => addBg(e.currentTarget, true);
function renderBgs() {
  $('bgTable').innerHTML = T.bgs.length ? '<tr><th>Where</th><th>Image</th><th>Dim</th><th></th></tr>' + T.bgs.map((b, i) =>
    `<tr><td>${esc(b.label || b.target)}</td><td class="mono note" style="word-break:break-all">${esc(b.path)}</td><td><input type="number" min="0" max="90" value="${+b.dim || 0}" data-dim="${i}" style="width:70px"></td><td><button class="btn danger" data-rm="${i}">Remove</button></td></tr>`).join('') : '<tr><td class="empty">No custom backgrounds yet.</td></tr>';
  $$('[data-rm]').forEach(b => b.onclick = () => { T.bgs.splice(+b.dataset.rm, 1); save(); renderBgs(); });
  $$('[data-dim]').forEach(n => n.onchange = () => { T.bgs[+n.dataset.dim].dim = Math.max(0, Math.min(90, +n.value || 0)); save(); });
}

// animation inventory
let ANIMS = [];
$('anLoad').onclick = e => needConn() && tid && act(e.currentTarget, async () => { ANIMS = await call('skin:anims', tid); renderAnims(); });
$('anFilter').oninput = renderAnims;
function renderAnims() {
  if (!ANIMS.length) { $('anTable').innerHTML = '<tr><td class="empty">No animations found.</td></tr>'; return; }
  const f = $('anFilter').value.toLowerCase();
  const rows = ANIMS.filter(a => !f || `${a.file} ${a.trigger} ${a.effects} ${a.where}`.toLowerCase().includes(f));
  $('anTable').innerHTML = '<tr><th>File</th><th>Line</th><th>Trigger</th><th>Effects</th><th>Time</th><th>On</th></tr>' + rows.slice(0, 600).map(a =>
    `<tr><td class="mono">${esc(a.file)}</td><td class="mono">${a.line}</td><td><span class="tag">${esc(a.trigger)}</span></td><td>${esc(a.effects)}</td><td class="mono">${a.time ? a.time + ' ms' : '–'}</td><td class="note">${esc(a.where)}</td></tr>`).join('');
  const files = new Set(ANIMS.map(a => a.file)).size, total = ANIMS.reduce((s, a) => s + (a.time || 0), 0);
  $('anNote').textContent = `${ANIMS.length} animations in ${files} files${f ? ` · ${rows.length} match` : ''}${rows.length > 600 ? ' · showing first 600' : ''} · longest ${Math.max(...ANIMS.map(a => a.time || 0))} ms · total ${(total / 1000).toFixed(1)} s`;
}

// window-switch animations (per file)
let WA = [];
function waNote() { $('waNote').textContent = T.winAnimFiles.length ? `${T.winAnimFiles.length} picked` : 'All windows'; }
function renderWA() {
  if (!WA.length) { $('waTable').innerHTML = '<tr><td class="empty">No window animations found.</td></tr>'; return; }
  const on = new Set(T.winAnimFiles.map(f => f.toLowerCase()));
  $('waTable').innerHTML = '<tr><th></th><th>File</th><th>Open</th><th>Close</th><th>Visible/hidden</th></tr>' + WA.map(w =>
    `<tr><td><input type="checkbox" data-wa="${esc(w.file)}"${on.has(w.file.toLowerCase()) ? ' checked' : ''}></td><td class="mono">${esc(w.file)}${w.include ? ' <span class="tag">include</span>' : ''}</td><td class="mono">${w.open}</td><td class="mono">${w.close}</td><td class="mono">${w.vis}</td></tr>`).join('');
  $$('[data-wa]').forEach(c => c.onchange = () => {
    T.winAnimFiles = $$('[data-wa]').filter(x => x.checked).map(x => x.dataset.wa); save(); waNote();
  });
  waNote();
}
$('waLoad').onclick = e => needConn() && tid && act(e.currentTarget, async () => { WA = await call('skin:winAnims', tid); renderWA(); });
$('waNone').onclick = () => { T.winAnimFiles = []; save(); WA.length ? renderWA() : waNote(); };

// hide info chips (per skin)
const INFO_LABELS = { plot: 'Plot', rating: 'Ratings & votes', duration: 'Runtime & end time', year: 'Year', genre: 'Genre', mpaa: 'Age rating', studio: 'Studio', director: 'Director & writer', cast: 'Cast', tagline: 'Tagline', premiered: 'Premiered / aired', flags: 'Media flags' };
function renderHideInfo() {
  $('hideInfo').innerHTML = Object.entries(INFO_LABELS).map(([k, n]) =>
    `<label class="chip${T.hideInfo.includes(k) ? ' on' : ''}"><input type="checkbox" data-hi="${k}"${T.hideInfo.includes(k) ? ' checked' : ''}>${n}</label>`).join('');
  $$('[data-hi]').forEach(c => c.onchange = () => {
    c.parentElement.classList.toggle('on', c.checked);
    T.hideInfo = $$('[data-hi]').filter(x => x.checked).map(x => x.dataset.hi); save();
  });
}

// every text/icon item (per skin), from skin:infoItems
let HI = [];
const KIND = { t: 'Text', p: 'Text (include)', i: 'Icon', s: 'Static icon' };
const hiNote = () => $('hiNote').textContent = T.hideItems.length ? T.hideItems.length + ' item(s) will be hidden on Apply' : '';
function renderHI() {
  if (!HI.length) { $('hiTable').innerHTML = '<tr><td class="empty">' + (T.hideItems.length ? T.hideItems.length + ' hidden · press Scan this skin to edit' : 'Press Scan this skin.') + '</td></tr>'; hiNote(); return; }
  const q = $('hiFilter').value.trim().toLowerCase();
  const rows = HI.filter(i => !q || (i.label + ' ' + i.files.join(' ')).toLowerCase().includes(q));
  $('hiTable').innerHTML = '<tr><th></th><th>Item</th><th>Kind</th><th>Uses</th><th>Where</th></tr>' + rows.map(i =>
    '<tr><td><input type="checkbox" data-hk="' + esc(i.key) + '"' + (T.hideItems.includes(i.key) ? ' checked' : '') + '></td><td>' + esc(i.label) +
    '</td><td>' + KIND[i.key[0]] + '</td><td>' + i.count + '</td><td class="note" style="margin:0">' + esc(i.files.join(', ')) + '</td></tr>').join('');
  $$('[data-hk]').forEach(c => c.onchange = () => {
    const k = c.dataset.hk;
    T.hideItems = c.checked ? [...new Set([...T.hideItems, k])] : T.hideItems.filter(x => x !== k); save(); hiNote();
  });
  hiNote();
}
const hiTick = pred => { const q = $('hiFilter').value.trim().toLowerCase(); T.hideItems = [...new Set([...T.hideItems, ...HI.filter(i => pred(i) && (!q || (i.label + ' ' + i.files.join(' ')).toLowerCase().includes(q))).map(i => i.key)])]; save(); renderHI(); };
$('hiScan').onclick = e => needConn() && tid && act(e.currentTarget, async () => { HI = await call('skin:infoItems', tid); renderHI(); toast('Found ' + HI.length + ' text/icon items'); });
$('hiFilter').oninput = renderHI;
$('hiAllT').onclick = () => hiTick(i => i.kind === 'text');
$('hiAllI').onclick = () => hiTick(i => i.kind === 'icon');
$('hiNone').onclick = () => { T.hideItems = []; save(); renderHI(); };

// ---------- OSD ----------
let OB = [];
const obLabel = () => $('obv').textContent = +$('ob').value ? $('ob').value + ' px' : 'stock';
$('ob').oninput = e => { T.osdBarH = +e.target.value; obLabel(); save(); };
function renderOsdBtns() {
  if (!OB.length) { $('osdBtns').innerHTML = T.osdHide.length ? `<span class="note" style="margin:0">${T.osdHide.length} hidden · press Load buttons to edit</span>` : '<span class="empty">Press Load buttons.</span>'; return; }
  // grouped by section (Video / Live TV / Music), each chip named from what the button does
  const groups = {};
  OB.forEach(b => (groups[b.section || 'Video'] ||= []).push(b));
  $('osdBtns').innerHTML = Object.entries(groups).map(([sec, list]) => `<div style="width:100%"><div class="label" style="margin:6px 0 4px">${esc(sec)} OSD</div>${list.map(b => {
    const shown = !T.osdHide.includes(b.id);
    const name = b.name || b.label || b.texture.replace(/\.(png|jpg)$/i, '') || (b.onclick || '').replace(/\(.*/, '') || 'Button';
    const tip = [b.onclick && 'Action: ' + b.onclick, b.visible && 'Shown when: ' + b.visible, `id ${b.id} · ${b.file}${b.include ? ' · ' + b.include : ''}`].filter(Boolean).join('\n');
    return `<label class="chip${shown ? ' on' : ''}" title="${esc(tip)}"><input type="checkbox" data-ob="${esc(b.id)}"${shown ? ' checked' : ''}>${esc(name)} <small class="note mono" style="margin:0">${esc(b.id)}</small></label>`;
  }).join('')}</div>`).join('');
  $$('[data-ob]').forEach(c => c.onchange = () => {
    c.parentElement.classList.toggle('on', c.checked);
    T.osdHide = $$('[data-ob]').filter(x => !x.checked).map(x => x.dataset.ob); save();
  });
}
$('obLoad').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  OB = await call('skin:osdButtons', { id: tid, from: T.osdFrom });
  if (!OB.length) toast('No VideoOSD.xml buttons found in this skin.', true);
  renderOsdBtns();
});
function saveOsd() { T.osdFrom = $('osdsrc').value; T.osdHide = []; OB = []; save(); renderOsdBtns(); }
$('osdsrc').onchange = saveOsd;
$$('#osd .sw[data-o]').forEach(s => s.onclick = () => { T[s.dataset.o] = s.classList.toggle('on'); save(); });
$('osdApply').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  $('osdReport').innerHTML = '<div class="note">Patching skin files over SSH…</div>';
  report($('osdReport'), (await call('skin:apply', { id: tid, t: T })).report);
});
$('osdHelper').onclick = e => needConn() && act(e.currentTarget, async () => toast(await call('helper:install')));
$$('[data-z]').forEach(b => b.onclick = () => needConn() && act(b, async () => { const z = await call('zoom:set', +b.dataset.z); toast(`Zoom set to ${z}`); }));
$('osdTime').textContent = '';

// ---------- logs ----------
let LOG = null;
$('logLoad').onclick = e => needConn() && act(e.currentTarget, async () => {
  LOG = await call('logs');
  $('lCrash').textContent = LOG.crashes.length;
  $('lErr').textContent = LOG.errorsCurrent;
  $('lErrOld').textContent = `${LOG.errorsOld} in the previous session`;
  $('lLast').textContent = LOG.crashes[0] ? (LOG.crashes[0].when || LOG.crashes[0].signal) : 'none';
  $('lCrashes').className = LOG.crashes.length ? '' : 'empty';
  $('lCrashes').innerHTML = LOG.crashes.length ? '<table><tr><th>When</th><th>Type</th><th>Likely culprit</th><th>Where</th></tr>' + LOG.crashes.map(c =>
    `<tr><td class="mono">${esc(c.when || '?')}</td><td><span class="tag err">${esc(c.signal)}</span></td><td>${esc(c.addon || '–')}</td><td class="mono note" style="word-break:break-all">${esc(c.frame || c.file)}</td></tr>`).join('') + '</table>' : 'No crash logs, and the last session ended cleanly.';
  $('lGroups').innerHTML = LOG.groups.length ? '<table><tr><th>×</th><th>Error</th><th>Cause</th><th>Last</th></tr>' + LOG.groups.slice(0, 200).map(g =>
    `<tr><td class="mono">${g.count}</td><td style="word-break:break-word">${esc(g.msg)}<div class="note" style="margin:2px 0 0">${esc(g.file)}</div></td><td>${g.cause ? `<span class="tag warn">${esc(g.cause)}</span>` : ''}</td><td class="mono note">${esc(g.last)}</td></tr>`).join('') + '</table>' : '<div class="empty">No errors logged.</div>';
  $('lTail').textContent = LOG.tail;
});
$('logRaw').onclick = () => { const p = $('lTail'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; if (!LOG) p.textContent = 'Press Read logs first.'; p.scrollTop = p.scrollHeight; };
$('logCopy').onclick = async () => {
  if (!LOG) return toast('Press Read logs first', true);
  const txt = [`Kodi log summary (${new Date().toLocaleString()})`, `Crashes: ${LOG.crashes.length}`, ...LOG.crashes.map(c => `- ${c.when} ${c.signal} ${c.addon} ${c.frame}`),
    `Errors this session: ${LOG.errorsCurrent}, previous: ${LOG.errorsOld}`, ...LOG.groups.slice(0, 40).map(g => `- ${g.count}× ${g.msg}${g.cause ? ' [' + g.cause + ']' : ''}`)].join('\n');
  await navigator.clipboard.writeText(txt); toast('Summary copied');
};

// ---------- backup ----------
const bSets = () => $$('[data-b]').filter(s => s.classList.contains('on')).map(s => s.dataset.b);
$$('[data-b]').forEach(s => s.onclick = () => s.classList.toggle('on'));
$('bSizes').onclick = e => needConn() && act(e.currentTarget, async () => {
  const r = await call('backup:sizes');
  $$('[data-sz]').forEach(el => el.textContent = '· ' + fmtBytes(r[el.dataset.sz]));
});
$('bRun').onclick = e => {
  if (!needConn()) return;
  const sets = bSets(); if (!sets.length) return toast('Pick at least one thing to back up', true);
  act(e.currentTarget, async () => {
    $('bProg').textContent = 'starting…';
    const r = await call('backup:run', sets);
    $('bProg').textContent = `done · ${fmtBytes(r.bytes)}`;
    toast(`Backup saved: ${r.file}${r.warn ? '\n' + r.warn : ''}`);
    loadBackups();
  });
};
window.kc.on('progress', p => {
  if (p.op === 'pull') $('fpNote').textContent = `Pulling ${p.done} / ${p.total} · ${fmtBytes(p.bytes)}`;
  if (p.op === 'backup') $('bProg').textContent = p.done ? `done · ${fmtBytes(p.bytes)}` : `downloading · ${fmtBytes(p.bytes)}`;
  if (p.op === 'restore') $('bProg').textContent = `restoring · ${fmtBytes(p.bytes)}${p.total ? ' / ' + fmtBytes(p.total) : ''}`;
});
async function loadBackups(btn) {
  await act(btn, async () => {
    const r = await call('backup:list');
    $('bDir').textContent = r.dir;
    $('bTable').innerHTML = r.files.length ? '<tr><th>Archive</th><th>Size</th><th></th></tr>' + r.files.map((f, i) =>
      `<tr><td><span class="mono">${esc(f.name)}</span><div class="note" style="margin:0">${new Date(f.mtime).toLocaleString()}</div></td><td class="mono">${fmtBytes(f.size)}</td><td style="white-space:nowrap"><button class="btn" data-restore="${i}">Restore</button> <button class="btn" data-reveal="${i}">Show</button></td></tr>`).join('') : '<tr><td class="empty">No backups in this folder yet.</td></tr>';
    $$('[data-reveal]').forEach(b => b.onclick = () => call('backup:reveal', r.files[+b.dataset.reveal].path));
    $$('[data-restore]').forEach(b => b.onclick = () => {
      const f = r.files[+b.dataset.restore];
      if (!needConn() || !confirm(`Restore ${f.name}?\n\nKodi will stop, the archive is written over the Kodi folder, then Kodi starts again. Files not in the archive are left alone.`)) return;
      act(b, async () => { const x = await call('backup:restore', f.path); $('bProg').textContent = 'restore complete'; toast(typeof x === 'string' ? x : 'Restore complete, Kodi restarting'); });
    });
  });
}
$('bList').onclick = e => loadBackups(e.currentTarget);
$('bDirChange').onclick = async e => {
  e.preventDefault();
  const d = await call('pick:folder', 'Backup folder'); if (!d) return;
  await call('backup:setDir', d); loadBackups();
};

// ---------- experimental ----------
const QUICK = [['reload', 'Reload skin'], ['restart', 'Restart Kodi'], ['texcache', 'Clear texture cache', 'Stops Kodi, deletes all cached thumbnails and the Textures database, then starts Kodi. Posters will re-download.'], ['scan', 'Scan library'], ['clean', 'Clean library'], ['screenshot', 'Screenshot'], ['debug', 'Toggle debug log'], ['repos', 'Refresh repos'], ['codec', 'Codec info'], ['reboot', 'Reboot box', 'Reboot the whole Kodi box now?']];
$('quick').innerHTML = QUICK.map(([k, n, w]) => `<button class="btn${w ? ' danger' : ''}" data-q="${k}">${n}</button>`).join('');
$$('[data-q]').forEach(b => b.onclick = () => {
  if (!needConn()) return;
  const q = QUICK.find(x => x[0] === b.dataset.q);
  if (q[2] && !confirm(q[2])) return;
  act(b, async () => { const r = await call('quick', q[0]); conLog(`# ${q[1]}\n${r}`); toast(r); });
});
function conLog(s) { const c = $('con'); c.textContent += s.replace(/\s+$/, '') + '\n\n'; c.scrollTop = c.scrollHeight; }
const hist = []; let hi = 0;
async function run(cmd, mode, btn) {
  if (!cmd || !needConn()) return;
  if (mode === 'shell' && /\b(rm\s+-rf\s+\/(\s|$)|mkfs|dd\s+if=|reboot|poweroff|halt|shutdown)\b/.test(cmd) && !confirm(`This looks destructive:\n\n${cmd}\n\nRun it anyway?`)) return;
  conLog(`${mode === 'shell' ? '$' : mode === 'rpc' ? 'rpc>' : 'kodi-send>'} ${cmd}`);
  await act(btn, async () => {
    try { const r = await call('exec', { cmd, mode }); conLog((r.text || '(no output)') + (r.code ? `\n[exit ${r.code}]` : '')); }
    catch (e) { conLog('error: ' + e.message.replace(/^Error invoking remote method '[^']+': /, '')); }
  });
}
$('conRun').onclick = e => { const c = $('conIn').value.trim(); if (!c) return; hist.push(c); hi = hist.length; $('conIn').value = ''; run(c, $('conMode').value, e.currentTarget); };
$('conIn').onkeydown = e => {
  if (e.key === 'Enter') $('conRun').click();
  else if (e.key === 'ArrowUp' && hi > 0) { $('conIn').value = hist[--hi]; e.preventDefault(); }
  else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); $('conIn').value = hist[hi] || ''; e.preventDefault(); }
};
$('conClear').onclick = () => $('con').textContent = '';
const DEFAULT_SAVED = [{ name: 'Disk space', cmd: 'df -h', mode: 'shell' }, { name: 'Top processes', cmd: 'top -bn1 | head -15', mode: 'shell' }, { name: 'Go home', cmd: 'ActivateWindow(Home)', mode: 'kodi-send' }, { name: 'Volume', cmd: 'Application.GetProperties {"properties":["volume","muted"]}', mode: 'rpc' }];
let SAVED = [];
function renderSaved() {
  $('savedTable').innerHTML = SAVED.length ? SAVED.map((s, i) => `<tr><td>${esc(s.name)}<div class="note mono" style="margin:0;word-break:break-all">${esc(s.cmd)}</div></td><td><span class="tag">${esc(s.mode)}</span></td><td style="white-space:nowrap"><button class="btn" data-run="${i}">Run</button> <button class="btn danger" data-del="${i}">✕</button></td></tr>`).join('') : '<tr><td class="empty">No saved commands.</td></tr>';
  $$('[data-run]').forEach(b => b.onclick = () => { const s = SAVED[+b.dataset.run]; run(s.cmd, s.mode, b); });
  $$('[data-del]').forEach(b => b.onclick = () => { SAVED.splice(+b.dataset.del, 1); call('saved:set', SAVED); renderSaved(); });
}
$('svAdd').onclick = () => {
  const name = $('svName').value.trim(), cmd = $('svCmd').value.trim();
  if (!name || !cmd) return toast('Give the command a name and the command itself', true);
  SAVED.push({ name, cmd, mode: $('svMode').value }); call('saved:set', SAVED); renderSaved();
  $('svName').value = $('svCmd').value = '';
};

// dashboard route: saved straight away (no reconnect needed); the helper is installed over SSH
$('cVia').onchange = () => call('conn:route', { via: $('cVia').value, helperPort: +$('cHelperPort').value || 8099 }).then(() => toast('Dashboard route saved'));
$('cHelperInstall').onclick = e => needConn() && act(e.currentTarget, async () => {
  $('cHelperNote').textContent = 'Installing…';
  const r = await call('helper:installStats', { port: +$('cHelperPort').value || 8099 });
  $('cHelperNote').textContent = r.note;
  if (r.answering && !$('cVia').value) { $('cVia').value = 'helper'; $('cVia').onchange(); }
});
$('cHelperTest').onclick = e => needConn() && act(e.currentTarget, async () => {
  const t0 = performance.now(); await call('stats'); const ms = Math.round(performance.now() - t0);
  const h = $('cVia').value === 'helper' ? await call('helper:ping') : null;
  $('cHelperNote').textContent = `Dashboard refresh took ${ms} ms${h ? (h.ok ? ` · helper ${h.ms} ms` : ' · helper not answering, using SSH: ' + h.error) : ''}`;
});

// ---------- boot ----------
(async () => {
  S.cfg = await call('cfg:get');
  S.cfg.skins = S.cfg.skins || {};
  const c = S.cfg.conn || {};
  $('cHost').value = c.host || ''; $('cPort').value = c.port || 22; $('cUser').value = c.user || 'root';
  $('cAuth').value = c.auth || 'password'; $('cKey').value = c.keyPath || '';
  $('cRpcPort').value = c.rpcPort || 8080; $('cRpcUser').value = c.rpcUser || '';
  $('cVia').value = c.via || ''; $('cHelperPort').value = c.helperPort || 8099;
  if (S.cfg.hasPassword) $('cPass').placeholder = '(saved)';
  if (S.cfg.hasRpcPass) $('cRpcPass').placeholder = '(saved)';
  authVis();
  SAVED = Array.isArray(S.cfg.saved) ? S.cfg.saved : DEFAULT_SAVED;
  renderSaved(); renderTop20(); preview(); renderBgs();
  $('bDir').textContent = S.cfg.backupDir;
  if (c.host && (S.cfg.hasPassword || c.auth === 'key')) { show('dashboard'); connect(connForm(), true); }
  else show('conn');
})();
