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
const report = (el, rows) => el.innerHTML = rows.map(r => `<div><span class="tag ${r.ok ? 'ok' : r.bad ? 'err' : 'warn'}">${r.ok ? 'ok' : r.bad ? 'warning' : 'note'}</span><span>${esc(r.text)}</span></div>`).join('');

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
  ['addons', 'Add-ons', '<path d="M10 3h4v4a2 2 0 104 0V7h3v5h-2a2 2 0 100 4h2v5h-5v-2a2 2 0 10-4 0v2H5v-5h2a2 2 0 100-4H5V7h5z"/>'],
  ['logs', 'Crash logs', '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>'],
  ['backup', 'Backup', '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>'],
  ['themes', 'Themes', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 000 18"/>'],
  ['exp', 'Experimental', '<path d="M9 3h6M10 3v6L4 20h16L14 9V3"/>'],
  ['ports', 'Ports', '<path d="M5 12h14M12 5v14"/><circle cx="12" cy="12" r="9"/>'],
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
  if (id === 'dashboard') { poll(); ioShow(); }
  if (id === 'backup' && S.connected && !S.listed) { S.listed = true; loadBackups(); }
  if (id === 'ports' && S.connected) $('ptScan').click();
  if (id === 'addons' && S.connected) { adLoad(); unLoad(); }
  if (id === 'preview') pvVidStart(); else if (PVV && PVV.on) pvVidStop();
  if (id === 'preview') { pvLoop(); if (S.connected) kbCheck(); }
  if (id === 'osd' && S.connected && !THUMB) osdThumbLoad();
  if (id === 'osd' && S.connected) { skCheck(); osdHelperState(); }
  if (id === 'conn' && S.connected) cHelperState();
  if (id === 'keymaps' && S.connected && !KM.loaded) kmLoad();
  if (id === 'keymaps') kwStart(); else kwStop();
  if (id === 'files' && S.connected && !FP.dir) fpOpen(FP.home || '');
  if (id === 'media' && S.connected && !S.mediaLoaded) { S.mediaLoaded = true; usbRefresh(); m3uRefresh(); }
}


function setConn(on, text) {
  S.connected = on;
  if (!on) $('ioCard').hidden = true; else if (curPage === 'dashboard') setTimeout(ioShow, 6000);
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
    setConn(true, `SSH ${c.user}@${c.host}`); setTimeout(kbCheck, 1500);
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
// eMMC / NAS traffic: the app samples the box every 5 s while connected; the card only exists while online
async function ioShow() {
  if (!S.connected) { $('ioCard').hidden = true; return; }
  let d; try { d = await call('io:get'); } catch { return; }
  $('ioCard').hidden = !d.online;
  if (!d.ready) { $('ioNote').textContent = 'Measuring… the first numbers come in a few seconds.'; return; }
  const rate = v => v > 0 ? `now ${fmtBytes(Math.round(v))}/s` : 'idle';
  $('ioSince').textContent = 'since ' + new Date(d.since).toLocaleTimeString();
  if (d.emmc) {
    $('ioRd').textContent = fmtBytes(d.emmc.sessRd); $('ioRdN').textContent = `${rate(d.rate.rd)} · ${fmtBytes(d.emmc.bootRd)} since boot (${d.emmc.name})`;
    $('ioWr').textContent = fmtBytes(d.emmc.sessWr); $('ioWrN').textContent = `${rate(d.rate.wr)} · ${fmtBytes(d.emmc.bootWr)} since boot`;
  }
  $('ioNr').textContent = fmtBytes(d.nas.rx); $('ioNrN').textContent = `${rate(d.rate.rx)} · ${d.open} open connection${d.open === 1 ? '' : 's'}`;
  $('ioNw').textContent = fmtBytes(d.nas.tx); $('ioNwN').textContent = rate(d.rate.tx);
  $('ioNote').textContent = (d.hosts.length ? `NAS: ${d.hosts.join(', ')} (from Kodi's sources). ` : "No SMB or NFS sources in Kodi, so there's no NAS to count. ") + "Counted only while Kodi Control is connected, from the box's own kernel counters. Nothing is installed or saved on the box." + (d.err ? ' Last read failed: ' + d.err : '');
}
setInterval(() => { if (curPage === 'dashboard') ioShow(); }, 5000);
$('ioReset').onclick = async () => { await call('io:reset'); setTimeout(ioShow, 1500); };
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
    $('pvNote').textContent = `Menus updated ${new Date().toLocaleTimeString()} · frame took ${now - t0} ms` + (fps ? ` · ${fps.toFixed(1)} fps` : '') + (PVV.on && PVV.note ? ' · ' + PVV.note : '');
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
// video layer: frames of the video plane stream in under the GUI screenshot (whose video area is transparent)
var PVV = { on: false, img: null, note: '' };
async function pvVidStart() {
  if (!S.connected || !PVV.on || curPage !== 'preview') return;
  const [w, fps] = $('pvVidQ').value.split(',').map(Number);
  try { await call('preview:videoStart', { w, fps }); } catch (e) { PVV.on = false; $('pvVidOn').classList.remove('on'); toast(e.message, true); }
}
function pvVidStop() { call('preview:videoStop').catch(() => {}); }
window.kc.on('preview:frame', f => {
  const cv = $('pvVid');
  if (f.stopped) { if (PVV.on && f.error) { toast(f.error, true); PVV.on = false; $('pvVidOn').classList.remove('on'); } cv.hidden = true; return; }
  if (!PVV.on || curPage !== 'preview') return;
  if (!f.data) { cv.hidden = true; PVV.note = 'Video layer: nothing playing'; return; }
  const src = new Uint8Array(f.data.buffer || f.data, f.data.byteOffset || 0), n = f.w * f.h;
  if (!PVV.img || PVV.img.width !== f.w || PVV.img.height !== f.h) PVV.img = new ImageData(f.w, f.h);
  const d = PVV.img.data;
  for (let i = 0, j = 0; i < n; i++, j += 3) { const k = i * 4; d[k] = src[j + 2]; d[k + 1] = src[j + 1]; d[k + 2] = src[j]; d[k + 3] = 255; }
  // the frame is the whole picture squeezed to 16:9: letterbox it back to the film's shape, as the TV shows it
  if (cv.width !== f.w || cv.height !== f.h) { cv.width = f.w; cv.height = f.h; }
  const ctx = cv.getContext('2d');
  if (!PVV.tmp || PVV.tmp.width !== f.w || PVV.tmp.height !== f.h) { PVV.tmp = document.createElement('canvas'); PVV.tmp.width = f.w; PVV.tmp.height = f.h; }
  PVV.tmp.getContext('2d').putImageData(PVV.img, 0, 0);
  const box = 16 / 9, dar = f.dar > 0.3 && f.dar < 5 ? f.dar : box;
  let dw = f.w, dh = f.h;
  if (dar > box) dh = Math.round(f.w / dar); else if (dar < box) dw = Math.round(f.h * dar);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, f.w, f.h);
  ctx.drawImage(PVV.tmp, (f.w - dw) / 2, (f.h - dh) / 2, dw, dh);
  cv.hidden = false;
  PVV.note = `Video layer ${f.w}×${f.h} · ${f.fps.toFixed(1)} fps`;
});
// one picture of what the TV shows: the video frame with the GUI screenshot on top
function pvComposite() {
  const img = $('pvImg'), cv = $('pvVid');
  if (cv.hidden || !PVV.on) return img.src;
  const c = document.createElement('canvas'); c.width = img.naturalWidth || 1920; c.height = img.naturalHeight || 1080;
  const x = c.getContext('2d'); x.drawImage(cv, 0, 0, c.width, c.height); x.globalCompositeOperation = 'lighten'; if (img.src) x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
$('pvVidOn').onclick = e => { PVV.on = e.currentTarget.classList.toggle('on'); if (PVV.on) { if (!needConn()) { PVV.on = false; e.currentTarget.classList.remove('on'); return; } pvVidStart(); } else { pvVidStop(); $('pvVid').hidden = true; } };
$('pvVidQ').onchange = () => { if (PVV.on) pvVidStart(); };
$('pvLive').onclick = e => { e.currentTarget.classList.toggle('on'); pvLoop(); };
$('pvRate').onchange = () => { pvTimes = []; pvLoop(); };
$('pvNow').onclick = e => needConn() && act(e.currentTarget, pvShot);
$('pvSave').onclick = () => { if (!$('pvImg').src) return; const a = document.createElement('a'); a.href = pvComposite(); a.download = `kodi-${Date.now()}.png`; a.click(); };
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

// ---------- menu bar tools ----------
const pop = (id, on) => { $(id).hidden = !on; if (on) setTimeout(() => ($(id).querySelector('button.p') || $(id).querySelector('button')).focus(), 30); };
$$('[data-close]').forEach(b => b.onclick = () => pop(b.dataset.close, false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') ['nfoPop', 'shotPop', 'kePop'].forEach(id => { if (!$(id).hidden) pop(id, false); }); });
async function copyImage(src, btn) {
  if (!src) return toast('No screenshot yet.', true);
  try { await call('clip:image', src); toast('Screenshot copied. Paste it anywhere.'); } catch (e) { toast(e.message, true); }
}
const saveImage = src => { if (!src) return; const a = document.createElement('a'); a.href = src; a.download = `kodi-${Date.now()}.png`; a.click(); };
$('pvCopy').onclick = () => copyImage(pvComposite());
async function shotTake() {
  if (!needConn()) return;
  $('shotNote').textContent = 'Taking a screenshot of the TV…';
  try { const t0 = Date.now(); $('shotImg').src = await call('preview:shot'); $('shotNote').textContent = `Taken ${new Date().toLocaleTimeString()} · ${Date.now() - t0} ms`; }
  catch (e) { $('shotNote').textContent = 'Screenshot failed: ' + e.message; }
}
$('shotTake').onclick = shotTake;
$('shotCopy').onclick = () => copyImage($('shotImg').src);
$('shotSave').onclick = () => saveImage($('shotImg').src);
const nfoTo = () => (document.querySelector('[name="nfoTo"]:checked') || {}).value;
$$('[name="nfoTo"]').forEach(r => r.onchange = () => { $('nfoDirRow').style.display = nfoTo() === 'pc' ? '' : 'none'; $('nfoImg').disabled = nfoTo() === 'pc'; });
$('nfoPick').onclick = async () => { const d = await call('pick:folder', 'Folder for the .nfo files'); if (d) $('nfoDir').value = d; };
$('nfoGo').onclick = e => needConn() && act(e.currentTarget, async () => {
  if (!$('nfoMovies').checked && !$('nfoShows').checked) throw new Error('Tick Movies or TV shows');
  $('nfoNote').textContent = 'Working…';
  const r = await call('nfo:export', { target: nfoTo(), movies: $('nfoMovies').checked, shows: $('nfoShows').checked, episodes: $('nfoEps').checked, images: $('nfoImg').checked, overwrite: $('nfoOver').checked, dir: $('nfoDir').value.trim() });
  $('nfoNote').textContent = r.text; toast(r.text);
});
window.kc.on('menu', async id => {
  if (id.startsWith('page:')) return show(id.slice(5));
  if (id === 'nfo') return pop('nfoPop', true);
  if (id === 'shot') { pop('shotPop', true); return shotTake(); }
  if (id === 'shot:copy') { if (!needConn()) return; try { const src = await call('preview:shot'); await copyImage(src); } catch (e) { toast(e.message, true); } return; }
  if (id === 'type') { kbHidden = false; return kbShow({ title: 'Type into the field that has focus on the TV' }); }
  if (id === 'ports') show('ports');
});

// ---------- ports on the box ----------
$('ptScan').onclick = e => needConn() && act(e.currentTarget, async () => {
  const r = await call('ports:list');
  const bad = r.issues.filter(i => i.bad);
  report($('ptIssues'), [...r.issues.map(i => ({ ok: false, bad: i.bad, text: i.text })), ...(bad.length ? [] : [{ ok: true, text: `No clashes. Kodi web server ${r.settings.web}, JSON-RPC 9090, EventServer ${r.settings.es} (UDP), helper add-on ${r.settings.helper}.` }])]);
  $('ptWarn').hidden = !bad.length;
  $('ptWarn').innerHTML = `<b>⚠ ${bad.length} port conflict${bad.length > 1 ? 's' : ''}</b><br>${bad.map(i => esc(i.text)).join('<br>')}`;
  const nb = document.querySelector('nav button[data-p="ports"]'); nb.querySelector('.badge')?.remove();
  if (bad.length) nb.insertAdjacentHTML('beforeend', `<span class="badge" title="Port conflicts">${bad.length}</span>`);
  $('ptTable').innerHTML = '<tr><th>Port</th><th>Proto</th><th>Listening on</th><th>Program</th><th>Service</th></tr>' + r.list.map(p =>
    `<tr${p.warn ? ` class="warnrow" title="${esc(p.warn)}"` : ''}><td class="mono">${p.warn ? '⚠ ' : ''}${p.port}</td><td>${p.proto.toUpperCase()}</td><td class="mono">${esc(p.addr)}</td><td class="mono">${esc(p.prog || '?')}${p.pid ? ` <span class="note">pid ${esc(p.pid)}</span>` : ''}</td><td>${esc(p.service || '')}</td></tr>`).join('');
});

// ---------- add-ons ----------
// sortable table headers: <th data-sort="key">; clicking the same one again flips the direction
function sortHead(cols, st) {
  return '<tr>' + cols.map(([k, n]) => k ? `<th data-sort="${k}" aria-sort="${st.key === k ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}">${n}${st.key === k ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>` : `<th>${n}</th>`).join('') + '</tr>';
}
function sortBind(table, st, render) {
  $$(`#${table} th[data-sort]`).forEach(th => th.onclick = () => { st.dir = st.key === th.dataset.sort ? -st.dir : 1; st.key = th.dataset.sort; render(); });
}
const sortBy = (rows, st, val) => rows.sort((a, b) => { const x = val(a, st.key), y = val(b, st.key); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * st.dir; });
const AD = { list: null, sort: { key: 'cpu', dir: -1 } };
const adType = t => ({ 'xbmc.service': 'Service', 'xbmc.python.pluginsource': 'Plugin', 'xbmc.python.script': 'Script', 'xbmc.python.module': 'Module', 'xbmc.gui.skin': 'Skin', 'kodi.inputstream': 'InputStream', 'kodi.pvrclient': 'PVR client', 'xbmc.metadata.scraper.movies': 'Scraper', 'xbmc.metadata.scraper.tvshows': 'Scraper', 'kodi.resource.images': 'Resource', 'kodi.resource.language': 'Language', 'xbmc.addon.repository': 'Repository', 'kodi.peripheral': 'Peripheral', 'xbmc.ui.screensaver': 'Screensaver', 'xbmc.player.musicviz': 'Visualisation', 'xbmc.python.weather': 'Weather', 'kodi.game.controller': 'Controller', 'kodi.audioencoder': 'Audio encoder', 'kodi.audiodecoder': 'Audio decoder', 'kodi.imagedecoder': 'Image decoder', 'kodi.vfs': 'VFS', 'xbmc.webinterface': 'Web interface', 'kodi.context.item': 'Context menu', 'xbmc.metadata.scraper.albums': 'Scraper', 'xbmc.metadata.scraper.artists': 'Scraper', 'xbmc.metadata.scraper.library': 'Scraper', 'kodi.resource.uisounds': 'Resource' }[t] || t.replace(/^(xbmc|kodi)\./, ''));
async function adLoad(btn) {
  if (!needConn()) return;
  await act(btn || $('adScan'), async () => {
    AD.list = await call('addons:list');
    const types = [...new Set(AD.list.list.map(a => adType(a.type)))].sort(), cur = $('adType').value;
    $('adType').innerHTML = '<option value="">All types</option>' + types.map(t => `<option${t === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
    adRender();
  });
}
function adRender() {
  if (!AD.list) return;
  const L = AD.list.list, q = $('adFind').value.trim().toLowerCase(), mode = $('adShow').value, ty = $('adType').value;
  const run = L.filter(a => a.running && a.enabled);
  $('adRss').textContent = fmtBytes(AD.list.kodiRss);
  $('adRun').innerHTML = `${run.length} <small>of ${L.length}</small>`;
  $('adRunN').textContent = `${run.filter(a => a.threads).length} with live threads · ${AD.list.enabledServices} enabled services · ${L.filter(a => !a.enabled).length} disabled`;
  const top = [...run].sort((a, b) => b.cpu - a.cpu)[0];
  $('adTop').textContent = top && top.cpu > 0 ? top.name : 'Nothing busy';
  $('adTopN').textContent = top && top.cpu > 0 ? `${top.cpu}% CPU over the last second` : 'Every add-on is idle';
  const ss = L.find(a => a.id === 'script.skin.info.service');
  $('adSkin').hidden = !ss;
  if (ss) {
    $('adSkinSw').classList.toggle('on', ss.enabled);
    $('adSkinN').innerHTML = `${esc(ss.name)} ${esc(ss.version)} · ${ss.enabled ? (ss.running ? '<b>running</b>' : 'enabled') : '<b>disabled</b>'}${ss.neededBy.length ? ` · needed by <span class="mono">${esc(ss.neededBy.join(', '))}</span>: with it off, those skins lose the parts that call it (letter jump, some info-dialog extras) and log "Unable to find plugin"` : ''}. Version 2.0.1~beta11 crashed Kodi several times on this box (its "Online service" thread).`;
  }
  const rows = L.filter(a => (mode === 'all' || (mode === 'running' ? a.running && a.enabled : mode === 'enabled' ? a.enabled : !a.enabled)) && (!ty || adType(a.type) === ty) && (!q || (a.name + ' ' + a.id).toLowerCase().includes(q)));
  sortBy(rows, AD.sort, (a, k) => k === 'mem' ? a.mem + a.proc : k === 'type' ? adType(a.type) : k === 'need' ? a.neededBy.length : k === 'status' ? (a.enabled ? a.running ? 2 : 1 : 0) : a[k]);
  $('adCount').textContent = `${rows.length} add-ons shown`;
  const status = a => !a.enabled ? '<span class="tag">disabled</span>' : a.broken ? '<span class="tag err">broken</span>' : a.running ? `<span class="tag ok" title="${esc(a.how.map(h => ({ thread: 'has live threads in Kodi', loaded: 'its files are loaded in Kodi', process: 'runs its own program', service: 'service: Kodi starts it at boot' })[h]).join(', '))}">running</span>` : '<span class="tag">enabled</span>';
  $('adTable').innerHTML = sortHead([['name', 'Add-on'], ['type', 'Type'], ['status', 'Status'], ['threads', 'Threads'], ['cpu', 'CPU now'], ['cpuTime', 'CPU time'], ['mem', 'Memory'], ['need', 'Needed by'], ['', 'On']], AD.sort) + rows.map(a => `<tr>
    <td><b>${esc(a.name)}</b> <span class="note">${esc(a.version)}</span><div class="note mono" style="margin:0">${esc(a.id)}${a.system ? ' · built in' : ''}</div></td>
    <td>${esc(adType(a.type))}</td><td>${status(a)}</td>
    <td class="mono"${a.threadNames ? ` title="${esc(a.threadNames)}"` : ''}>${a.threads || '–'}</td>
    <td class="mono">${a.threads ? a.cpu + '%' : '–'}</td><td class="mono">${a.cpuTime ? fmtUp(a.cpuTime).replace(/^0m$/, a.cpuTime + 's') : '–'}</td>
    <td class="mono">${a.proc ? fmtBytes(a.proc) + ' <span class="note">own program</span>' : a.mem ? fmtBytes(a.mem) + ' <span class="note">mapped</span>' : a.running ? '<span class="note">inside Kodi</span>' : '–'}</td>
    <td class="note mono" style="margin:0">${esc(a.neededBy.slice(0, 3).join(', '))}${a.neededBy.length > 3 ? ` +${a.neededBy.length - 3}` : ''}</td>
    <td>${a.type === 'xbmc.gui.skin' || a.id === 'script.kodicontrol' ? '' : `<div class="sw${a.enabled ? ' on' : ''}" data-aden="${esc(a.id)}" role="switch" aria-checked="${a.enabled}" aria-label="Enable ${esc(a.name)}"></div>`}</td></tr>`).join('');
  sortBind('adTable', AD.sort, adRender);
  $$('[data-aden]').forEach(s => s.onclick = () => adToggle(s.dataset.aden, !s.classList.contains('on'), s));
}
async function adToggle(id, on, sw) {
  const a = AD.list?.list.find(x => x.id === id);
  if (!on && a?.neededBy.length && !confirm(`${a.name} is needed by ${a.neededBy.join(', ')}. Those add-ons may lose features or stop working while it is off. Turn it off anyway?`)) return;
  try {
    sw?.classList.add('busy');
    const now = await call('addons:enable', { id, enabled: on });
    if (a) { a.enabled = now; if (!now) { a.running = false; a.threads = 0; a.cpu = 0; } }
    toast(`${a ? a.name : id} ${now ? 'enabled' : 'disabled'}${now === on ? '' : ' (Kodi would not change it)'}`, now !== on);
    adRender();
    setTimeout(() => curPage === 'addons' && adLoad(), 2500);
  } catch (e) { toast(e.message, true); }
  finally { sw?.classList.remove('busy'); }
}
$('adScan').onclick = e => adLoad(e.currentTarget);
$('adFind').oninput = adRender;
['adShow', 'adType'].forEach(id => $(id).onchange = adRender);
$('adSkinSw').onclick = e => adToggle('script.skin.info.service', !e.currentTarget.classList.contains('on'), e.currentTarget);

// ---------- text into Kodi's keyboard ----------
// Kodi sends Input.OnInputRequested when its keyboard opens (search, a text field, a password), and
// Input.OnInputFinished when it closes; the popup follows it on any page.
async function sendText(text, done, btn) {
  if (!needConn()) return;
  try { await call('kodi:sendText', { text, done }); toast(done ? 'Sent and confirmed' : 'Sent to Kodi\'s keyboard'); if (curPage === 'preview') setTimeout(pvShot, 400); }
  catch (e) { toast(/keyboard|input|not.*open|-32100/i.test(e.message) ? 'Kodi has no keyboard open: select a text field on the TV first' : e.message, true); }
}
$('pvTextSend').onclick = () => sendText($('pvText').value, false);
$('pvTextDone').onclick = () => sendText($('pvText').value, true);
$('pvText').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); sendText($('pvText').value, true); } };
let kbHidden = false;
function kbShow(d) {
  if (kbHidden) return;
  $('kbTitle').textContent = d.title ? `Kodi asks: ${d.title}` : 'Kodi is asking for text';
  $('kbText').type = /password|pass/i.test(d.type || '') ? 'password' : 'text';
  $('kbText').value = d.value || '';
  $('kbPop').hidden = false;
  setTimeout(() => { $('kbText').focus(); $('kbText').select(); }, 30);
}
function kbClose() { $('kbPop').hidden = true; }
window.kc.on('kodi:input', d => { if (d.open) { kbHidden = false; kbShow(d); } else kbClose(); });
$('kbOk').onclick = async () => { await sendText($('kbText').value, true); kbClose(); };
$('kbType').onclick = () => sendText($('kbText').value, false);
$('kbCancel').onclick = async () => { try { await call('kodi:closeKeyboard'); } catch {} kbClose(); };
$('kbHide').onclick = () => { kbHidden = true; kbClose(); };
$('kbText').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('kbOk').click(); } else if (e.key === 'Escape') $('kbHide').click(); };
// a keyboard that was already open before the app connected
async function kbCheck() { try { const k = await call('kodi:keyboardOpen'); if (k.open && $('kbPop').hidden) kbShow(k); } catch {} }

// ---------- keymaps ----------
const KM = { list: [], loaded: false, meta: null, names: {}, sort: { key: '', dir: 1 } };
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
  $('kmTable').innerHTML = sortHead([['window', 'Window'], ['device', 'Device'], ['key', 'Key / button'], ['mod', 'Modifier'], ['longpress', 'Long press'], ['action', 'Action'], ['', '']], KM.sort) + KM.list.map((b, i) => `<tr data-i="${i}">
    <td><select data-f="window" aria-label="Window">${kmWinOpts(b.window || 'global')}</select></td>
    <td><select data-f="device">${DEVICES.map(d => `<option${d === b.device ? ' selected' : ''}>${d}</option>`).join('')}</select></td>
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
  // sorting reorders the list itself, which is also the order written to kodicontrol.xml
  sortBind('kmTable', KM.sort, () => { sortBy(KM.list, KM.sort, (b, k) => k === 'longpress' ? +!!b.longpress : String(b[k] || '').toLowerCase()); kmRender(); });
}
// What every key does now: system keymaps load first, then userdata/keymaps (gen.xml from the Keymap Editor
// add-on, this app's kodicontrol.xml, any others), each folder in name order; a later file wins per
// window + device + key. Overridden lines stay listed, struck through, so clashes are visible.
const KA = { sort: { key: '', dir: 1 }, rows: [] };
const DEVICES = ['keyboard', 'remote', 'gamepad', 'mouse', 'joystick', 'appcommand'];
function kmAssign() {
  if (!KM.meta) return;
  const order = [...KM.meta.files.filter(f => f.system), ...KM.meta.files.filter(f => !f.system)];
  const sysOn = $('kaSys').checked, q = $('kaFind').value.trim().toLowerCase(), win = $('kaWin').value, dev = $('kaDev').value;
  const rows = [], last = {};
  for (const f of order) for (const b of f.binds) {
    const k = [String(b.window).toLowerCase(), b.device, String(b.key).toLowerCase(), b.mod || '', !!b.longpress].join('|');
    if (last[k]) last[k].over = f.name;
    rows.push(last[k] = { ...b, file: f.name, sys: f.system, n: rows.length });
  }
  KA.rows = rows;
  const wins = [...new Set(rows.map(r => r.window))].sort();
  if ($('kaWin').options.length !== wins.length + 1) { $('kaWin').innerHTML = '<option value="">All windows</option>' + wins.map(w => `<option>${esc(w)}</option>`).join(''); $('kaWin').value = win; }
  const devs = [...new Set(rows.map(r => r.device))].sort();
  if ($('kaDev').options.length !== devs.length + 1) { $('kaDev').innerHTML = '<option value="">All devices</option>' + devs.map(d => `<option>${esc(d)}</option>`).join(''); $('kaDev').value = dev; }
  const show = rows.filter(r => (sysOn || !r.sys) && (!win || r.window === win) && (!dev || r.device === dev) && (!q || [r.window, r.device, r.key, r.label, r.action, r.file, kaActName(r.action)].join(' ').toLowerCase().includes(q)));
  if (KA.sort.key) sortBy(show, KA.sort, (r, k) => k === 'key' ? String(r.label || r.key).toLowerCase() : k === 'from' ? r.n : String(r[k] || '').toLowerCase());
  const clash = rows.filter(r => r.over && !r.sys).length;
  $('kaCount').textContent = `${show.length} of ${rows.length} bindings · ${clash} of your bindings are overridden by a later file`;
  $('kaTable').innerHTML = sortHead([['window', 'Window'], ['device', 'Device'], ['key', 'Key / button'], ['action', 'Action'], ['from', 'From'], ['', '']], KA.sort) + show.slice(0, 1500).map(r =>
    `<tr${r.over ? ` style="opacity:.55" title="Overridden by ${esc(r.over)}"` : ''}><td class="mono">${esc(r.window)}</td><td>${esc(r.device)}</td><td class="mono">${r.over ? '<s>' : ''}${esc(r.label || r.key)}${r.label && r.label !== r.key ? ` <span class="note">${esc(r.key)}</span>` : ''}${r.mod ? ' +' + esc(r.mod) : ''}${r.longpress ? ' (long)' : ''}${r.over ? '</s>' : ''}</td><td class="mono">${esc(r.action)}${kaActName(r.action) ? ` <span class="note">${esc(kaActName(r.action))}</span>` : ''}</td><td>${esc(r.file)}${r.sys ? ' <span class="note">Kodi default</span>' : ''}${r.over ? ` <span class="note">→ ${esc(r.over)}</span>` : ''}</td><td>${r.over ? '' : `<button class="btn" data-kaed="${r.n}">Edit</button>`}</td></tr>`).join('');
  sortBind('kaTable', KA.sort, kmAssign);
  $$('[data-kaed]').forEach(b => b.onclick = () => keOpen(KA.rows[+b.dataset.kaed]));
}
// action id (any case) to the Keymap Editor's friendly name
function kaActName(a) {
  if (!KM.meta?.actionsFull || !a) return '';
  if (!KM.actName) { KM.actName = {}; for (const [, l] of KM.meta.actionsFull) for (const [id, n] of l) if (n) KM.actName[id.toLowerCase()] = n; }
  return KM.actName[String(a).trim().toLowerCase()] || '';
}
// ---------- edit one binding: every choice the Keymap Editor add-on offers ----------
let KE = null;
function keOpen(r) {
  if (!KM.meta) return toast('Press Load from box first.', true);
  KE = r || { window: 'global', device: 'keyboard', key: '', action: '' };
  const wn = Object.fromEntries((KM.meta.windowNames || []).map(([id, n]) => [id.toLowerCase(), n]));
  const wins = [...new Set([...(KM.meta.windows || []), KE.window])];
  $('keWin').innerHTML = wins.map(w => `<option value="${esc(w)}"${w.toLowerCase() === String(KE.window).toLowerCase() ? ' selected' : ''}>${esc(wn[w.toLowerCase()] ? `${wn[w.toLowerCase()]} (${w})` : w)}</option>`).join('');
  $('keDev').value = DEVICES.includes(KE.device) ? KE.device : 'keyboard';
  $('keKey').value = KE.key || ''; $('keMod').value = KE.mod || ''; $('keLong').checked = !!KE.longpress;
  const cats = KM.meta.actionsFull || [];
  const cur = String(KE.action || '').toLowerCase();
  const hit = cats.findIndex(([, l]) => l.some(([id]) => id.toLowerCase() === cur));
  $('keCat').innerHTML = cats.map(([c, l], i) => `<option value="${i}"${i === Math.max(0, hit) ? ' selected' : ''}>${esc(c)} (${l.length})</option>`).join('');
  keActs(cur);
  $('keRaw').value = hit < 0 ? KE.action || '' : '';
  $('keTitle').textContent = r ? 'Edit binding' : 'New binding';
  $('keNow').innerHTML = r ? `Now: <span class="mono">${esc(r.window)} · ${esc(r.device)} · ${esc(r.label || r.key)}${r.mod ? ' +' + esc(r.mod) : ''}${r.longpress ? ' (long)' : ''}</span> → <b class="mono">${esc(r.action)}</b>` : '';
  $('keSrc').textContent = (r ? `From ${r.file}${r.sys ? " (Kodi's defaults)" : ''}. ` : '') + (KM.meta.fromEditor ? '' : 'The Keymap Editor add-on is not installed on the box, so this shows a shorter action list.');
  pop('kePop', true);
}
function keActs(sel) {
  const l = (KM.meta.actionsFull || [])[+$('keCat').value]?.[1] || [];
  $('keAct').innerHTML = l.map(([id, n]) => `<option value="${esc(id)}"${id.toLowerCase() === sel ? ' selected' : ''}>${esc(n ? `${n} — ${id}` : id)}</option>`).join('');
}
$('keCat').onchange = () => { keActs(''); $('keRaw').value = ''; };
$('keAct').onchange = () => { $('keRaw').value = ''; };
function keValue(action) {
  const b = { window: $('keWin').value || 'global', device: $('keDev').value, key: $('keKey').value.trim(), mod: $('keMod').value, longpress: $('keLong').checked, action: action ?? ($('keRaw').value.trim() || $('keAct').value) };
  if (!b.key) throw new Error('Pick the key or button');
  if (!b.action) throw new Error('Pick an action');
  return b;
}
function keStore(b) {
  const id = x => [String(x.window).toLowerCase(), x.device, String(x.key).toLowerCase(), x.mod || '', !!x.longpress].join('|');
  // editing one of your own bindings moves it; anything else is added (or replaces the same key)
  if (KE && KE.file === 'kodicontrol.xml') { const i = KM.list.findIndex(x => id(x) === id(KE)); if (i >= 0) KM.list.splice(i, 1); }
  const j = KM.list.findIndex(x => id(x) === id(b));
  if (j >= 0) KM.list[j] = b; else KM.list.push(b);
  kmRender();
}
async function keSave(apply, action) {
  try {
    const b = keValue(action);
    keStore(b); pop('kePop', false);
    if (!apply) return toast(`Added to your bindings: ${b.key} → ${b.action}. Press Save & reload to apply.`);
    if (!needConn()) return;
    const r = await call('keymap:save', KM.list);
    KM.meta = await call('keymap:list'); KM.actName = null; kmFiles();
    toast(`Saved ${r.count} bindings and reloaded keymaps: ${b.key} → ${b.action}`);
  } catch (e) { toast(e.message, true); }
}
$('keApply').onclick = () => keSave(true);
$('keKeep').onclick = () => keSave(false);
$('keNoop').onclick = () => keSave(true, 'noop');
['kaSys', 'kaWin', 'kaDev'].forEach(id => $(id).onchange = kmAssign);
$('kaFind').oninput = kmAssign;
function kmImport(files) {
  const seen = new Set(KM.list.map(x => [x.window, x.device, x.key, x.mod, !!x.longpress].join('|')));
  const add = [];
  for (const f of files) for (const { file, label, system, ...x } of f.binds) {
    const k = [x.window, x.device, x.key, x.mod, !!x.longpress].join('|');
    if (!seen.has(k)) { seen.add(k); add.push(x); }
  }
  KM.list.push(...add); kmRender();
  return add.length;
}
$('kmImportAll').onclick = () => {
  if (!KM.meta) return toast('Press Load from box first.', true);
  const files = KM.meta.files.filter(f => !f.system && f.name !== 'kodicontrol.xml');
  if (!files.length) return toast('No other keymap files in userdata/keymaps.', true);
  const n = kmImport(files);
  toast(`Imported ${n} bindings from ${files.map(f => f.name).join(', ')}. Save & reload to apply; you can then delete those files so they don't fight with kodicontrol.xml.`);
};
function kmFiles() {
  kmAssign();
  const files = KM.meta.files.filter(f => !f.system);
  if (!files.length) { $('kmFiles').className = 'empty'; $('kmFiles').textContent = 'No keymap files in userdata/keymaps yet.'; return; }
  $('kmFiles').className = '';
  $('kmFiles').innerHTML = files.map((f, i) => `<details style="margin-bottom:8px"><summary class="row between" style="cursor:pointer"><span><b class="mono">${esc(f.name)}</b> <span class="note">${f.binds.length} bindings${f.name === 'kodicontrol.xml' ? ' · written by this app' : ''}</span></span>${f.name === 'kodicontrol.xml' ? '' : `<button class="btn" data-imp="${i}">Import into my bindings</button>`}</summary>
    <table class="t">${f.binds.slice(0, 300).map(b => `<tr><td class="mono">${esc(b.window)}</td><td>${esc(b.device)}</td><td class="mono">${esc(b.key)}${b.label ? ` <span class="note">${esc(b.label)}</span>` : ''}${b.mod ? ' +' + esc(b.mod) : ''}${b.longpress ? ' (long)' : ''}</td><td class="mono">${esc(b.action)}</td></tr>`).join('')}</table></details>`).join('');
  $$('[data-imp]').forEach(b => b.onclick = e => {
    e.preventDefault();
    const f = files[+b.dataset.imp];
    const n = kmImport([f]);
    toast(`Imported ${n} bindings from ${f.name}. Save & reload to apply. You can then delete ${f.name} so the two files don't fight.`);
  });
}
async function kmLoad(btn) {
  if (!S.connected) return;
  await act(btn, async () => {
    KM.meta = await call('keymap:list'); KM.actName = null;
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
  KM.meta = await call('keymap:list'); KM.actName = null; kmFiles();
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
  $('ob').value = T.osdBarH || 0; obLabel(); OB = []; renderOsdBtns(); skLoadT();
  $('osdReport').innerHTML = '';
  THUMB = null; thumbFor = ''; zrVis(); if (curPage === 'osd') osdThumbLoad();
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
    T.osdHide = $$('[data-ob]').filter(x => !x.checked).map(x => x.dataset.ob); save(); renderThumb();
  });
}
$('obLoad').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  OB = await call('skin:osdButtons', { id: tid, from: T.osdFrom });
  if (!OB.length) toast('No VideoOSD.xml buttons found in this skin.', true);
  renderOsdBtns();
});
function saveOsd() { T.osdFrom = $('osdsrc').value; T.osdHide = []; OB = []; delete T.zoomReplace; delete T.zoomReplaceName; THUMB = null; save(); renderOsdBtns(); osdThumbLoad(); }
$('osdsrc').onchange = saveOsd;
$$('#osd .sw[data-o]').forEach(s => s.onclick = () => { T[s.dataset.o] = s.classList.toggle('on'); save(); if (s.dataset.o === 'osdZoom') { zrVis(); if (T.osdZoom) osdThumbLoad(); } });

// Zoom preset: which of the OSD's buttons it takes over (Info unless you pick another), and a thumbnail of the
// chosen OSD (its own icons, in order) with that button highlighted
var THUMB = null, thumbFor = '';
const videoBtns = () => OB.filter(b => (b.section || 'Video') === 'Video');
function zrVis() { $('zrWrap').style.display = T.osdZoom ? '' : 'none'; }
async function osdThumbLoad() {
  const src = T.osdFrom || tid;
  if (!S.connected || !src) return;
  const name = (S.skins.find(s => s.id === src) || {}).name || src;
  $('osdThumbNote').textContent = `Reading the ${name} OSD…`;
  try {
    if (!OB.length) { OB = await call('skin:osdButtons', { id: tid, from: T.osdFrom }); renderOsdBtns(); }
    if (thumbFor !== src) { THUMB = await call('skin:osdThumb', { id: src }); thumbFor = src; }
  } catch (e) { $('osdThumbNote').textContent = e.message; return; }
  if (T.zoomReplace === undefined) {
    const info = videoBtns().find(b => /\binfo/i.test(b.name || '') || /Info|ShowInfo|information/i.test(b.onclick || ''));
    if (info) { T.zoomReplace = info.id; T.zoomReplaceName = info.name; save(); }
  }
  renderZoomRep(); renderThumb();
  $('osdThumbNote').textContent = `${name} OSD: ${videoBtns().length} buttons${THUMB.icons.length ? '' : ' (this skin draws its icons with a font, so they show as names)'}. The highlighted one becomes the zoom preset.`;
}
function renderZoomRep() {
  const list = videoBtns();
  $('zoomRep').innerHTML = `<option value="">Pick the button to replace…</option><option value="new">Don't replace any: add a new button</option>` +
    list.map(b => `<option value="${esc(b.id)}">${esc(b.name || b.label || 'Button')} · id ${esc(b.id)}</option>`).join('');
  $('zoomRep').value = T.zoomReplace === '' ? 'new' : (T.zoomReplace || '');
  $('zrNote').textContent = !T.zoomReplace && T.zoomReplace !== '' ? 'Choose which button to give up for the zoom preset.'
    : T.zoomReplace === '' ? 'A separate Zoom button is added to the OSD.' : `"${T.zoomReplaceName || T.zoomReplace}" will cycle the zoom instead.`;
}
$('zoomRep').onchange = () => {
  const v = $('zoomRep').value, b = OB.find(x => x.id === v);
  if (v === 'new') { T.zoomReplace = ''; delete T.zoomReplaceName; } else if (b) { T.zoomReplace = b.id; T.zoomReplaceName = b.name; } else delete T.zoomReplace;
  save(); renderZoomRep(); renderThumb();
};
function renderThumb() {
  if (!THUMB) return;
  const icon = Object.fromEntries(THUMB.icons.map(i => [i.tex, i.src]));
  const z = T.osdZoom ? T.zoomReplace : null;
  const cells = videoBtns().filter(b => !T.osdHide.includes(b.id)).map(b => {
    const n = esc(b.id === z ? 'Zoom' : (b.name || b.label || 'Button'));
    return icon[b.tex] ? `<div class="ob${b.id === z ? ' z' : ''}" title="${n}"><img src="${icon[b.tex]}" alt=""><small>${n}</small></div>` : `<div class="ob t${b.id === z ? ' z' : ''}">${n}</div>`;
  });
  if (T.osdZoom && T.zoomReplace === '') cells.push('<div class="ob t z">Zoom</div>');
  $('osdThumb').innerHTML = cells.join('') || '<span>No buttons found</span>';
}
$('osdApply').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  if (T.osdZoom && T.zoomReplace === undefined) { await osdThumbLoad(); if (T.zoomReplace === undefined) { $('zoomRep').focus(); throw new Error('Pick which OSD button should become the zoom preset first'); } }
  $('osdReport').innerHTML = '<div class="note">Patching skin files over SSH…</div>';
  report($('osdReport'), (await call('skin:apply', { id: tid, t: T })).report);
});
// ---------- seek preview ----------
// look of the box is per skin (T), the frame step / seek delay / steps are Kodi-wide (seek:save)
// the seek preview is Kodi-wide (every skin), so its look lives with the seek settings, not with the skin
let SK = { on: false, look: { place: 'follow', size: 'medium', bottom: 230, color: 'FFFFFFFF' } };
function skLoadT() {
  const l = SK.look;
  $('skPlace').value = l.place || 'follow'; $('skSize').value = l.size || 'medium';
  $('skBot').value = l.bottom || 230; $('skColor').value = l.color || 'FFFFFFFF'; skDemo();
  $('skOn').classList.toggle('on', !!SK.on); $('skRam').classList.toggle('on', !!SK.ram); $('skSubs').classList.toggle('on', SK.hidesubs !== false);
  $('skOpts').style.display = SK.on ? '' : 'none';
}
function skDemo() {
  $('skBotV').textContent = $('skBot').value + ' px';
  const d = $('skDemo'); d.style.width = { small: '26%', medium: '34%', large: '44%' }[$('skSize').value];
  d.style.left = $('skPlace').value === 'center' ? '50%' : '58%';
  d.style.bottom = `calc(100% + ${Math.round((+$('skBot').value - 80) / 12)}px)`;
  d.style.setProperty('--sk', $('skColor').value === '00FFFFFF' ? 'transparent' : '#' + $('skColor').value.slice(2));
}
['skPlace', 'skSize', 'skBot', 'skColor'].forEach(id => $(id).oninput = $(id).onchange = () => skDemo());
$('skDelay').oninput = () => { $('skDelayV').textContent = $('skDelay').value + ' ms'; };
const skValues = () => ({ on: $('skOn').classList.contains('on'), look: { place: $('skPlace').value, size: $('skSize').value, bottom: +$('skBot').value, color: $('skColor').value }, ram: $('skRam').classList.contains('on'), hidesubs: $('skSubs').classList.contains('on'), step: +$('skStep').value, width: { small: 288, medium: 384, large: 512 }[$('skSize').value] || 384, delay: +$('skDelay').value, steps: $('skSteps').value ? $('skSteps').value.split(',').map(Number) : null });
async function skCheck(btn) {
  if (!S.connected) return;
  const go = async () => {
    const s = await call('seek:status');
    $('skFf').innerHTML = s.ffmpeg ? `<span class="tag ok">found</span> <span class="mono">${esc(s.ffmpeg)}</span>` : '<span class="tag warn">not installed</span>';
    $('skInstall').style.display = s.ffmpeg ? 'none' : '';
    SK = { on: s.on, look: s.look, ram: s.ram, hidesubs: s.hidesubs }; skLoadT();
    if (s.conf.step) $('skStep').value = s.conf.step;
    if (s.delay != null) { $('skDelay').value = s.delay; $('skDelayV').textContent = s.delay + ' ms'; }
    if (Array.isArray(s.steps)) { const v = s.steps.join(','); if (![...$('skSteps').options].some(o => o.value === v)) $('skSteps').insertAdjacentHTML('afterbegin', `<option value="${v}">Now: ${esc(s.steps.join(', '))} s</option>`); $('skSteps').value = v; }
    $('skNote').textContent = `Service ${s.conf.on ? 'on' : 'off'}${s.cached ? ` · ${fmtBytes(+s.cached * 1024)} of cached frames` : ''}`;
  };
  return btn ? act(btn, go) : go().catch(() => {});
}
$('skCheck').onclick = e => needConn() && skCheck(e.currentTarget);
$('skInstall').onclick = e => needConn() && act(e.currentTarget, async () => toast(await call('seek:installFfmpeg')));
$('skSave').onclick = e => needConn() && act(e.currentTarget, async () => {
  $('skReport').innerHTML = '<div class="note">Updating every skin…</div>';
  report($('skReport'), (await call('seek:apply', skValues())).report); skCheck();
});
// the switch is the whole feature: on = patched into every skin + service on; off = everything back to Kodi's defaults
$('skOn').onclick = () => {
  if (!needConn()) return;
  const on = !$('skOn').classList.contains('on');
  if (on && !heavyOk('seek', 'Seek preview runs ffmpeg on the box in the background while you watch, to make the preview frames, and reads extra data from the NAS or stream. Expect more box CPU and network during playback.')) return;
  $('skOn').classList.toggle('on', on); $('skOpts').style.display = on ? '' : 'none';
  act(null, async () => {
    $('skReport').innerHTML = `<div class="note">${on ? 'Turning the seek preview on in every skin…' : 'Turning the seek preview off and putting every seek setting back…'}</div>`;
    try { report($('skReport'), (await call('seek:enable', { ...skValues(), on })).report); }
    catch (err) { $('skReport').innerHTML = ''; throw err; }
    finally { skCheck(); }
  });
};
$('skSubs').onclick = () => $('skSubs').classList.toggle('on');
$('skRam').onclick = () => needConn() && act(null, async () => { const on = $('skRam').classList.toggle('on'); toast(await call('seek:ram', on)); });
// zoom values: shown as the amount added (0.20 = Kodi zoom 1.2), edited here and baked into the helper add-on
let ZV = [0, 0.2, 0.35];
const zName = v => v === 0 ? '0' : (+v).toFixed(2);
function zRender() {
  $('zEdit').innerHTML = ZV.map((v, i) => `<span class="row" style="gap:2px"><input type="number" min="0" max="1" step="0.05" value="${v}" data-zi="${i}" style="width:74px" aria-label="Zoom value ${i + 1}">${ZV.length > 1 ? `<button class="btn" data-zx="${i}" aria-label="Remove zoom value ${i + 1}">✕</button>` : ''}</span>`).join('');
  $('zTry').innerHTML = ZV.map((v, i) => `<button class="btn" data-z="${i}">Zoom ${zName(v)}</button>`).join('');
  $('zNote').innerHTML = `The zoom preset button cycles zoom <b>${ZV.map(zName).join(' → ')}</b> (Kodi zoom ${ZV.map(v => (1 + v).toFixed(2).replace(/0$/, '')).join(' / ')}), one press per step. It runs the small Kodi Control helper add-on, which is installed automatically.`;
  $$('[data-zi]').forEach(el => el.onchange = () => { const v = Math.max(0, Math.min(1, parseFloat(el.value) || 0)); ZV[+el.dataset.zi] = Math.round(v * 1000) / 1000; zRender(); });
  $$('[data-zx]').forEach(el => el.onclick = () => { ZV.splice(+el.dataset.zx, 1); zRender(); });
  $$('[data-z]').forEach(b => b.onclick = () => needConn() && act(b, async () => { const z = await call('zoom:set', +b.dataset.z); toast(`Zoom set to ${zName(z - 1)} (Kodi zoom ${z})`); }));
}
$('zAdd').onclick = () => { if (ZV.length >= 8) return toast('Up to 8 zoom values.', true); ZV.push(Math.min(1, Math.round(((ZV[ZV.length - 1] || 0) + 0.1) * 100) / 100)); zRender(); };
$('zReset').onclick = () => { ZV = [0, 0.2, 0.35]; zRender(); };
$('zSave').onclick = e => act(e.currentTarget, async () => { const r = await call('zoom:save', ZV); ZV = await call('zoom:get'); zRender(); toast(r); });
call('zoom:get').then(z => { ZV = z; zRender(); }).catch(() => zRender());
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

// ---------- Default / Undo on every tab, and warnings before the heavy features ----------
// Heavy = makes the box work harder (CPU, eMMC writes, network) or installs something on it. Asked once per app run.
const warned = {};
function heavyOk(key, msg) { if (warned[key]) return true; if (!confirm(msg + '\n\nEverything can be undone later with the Default buttons, or under Add-ons → Changes Kodi Control made on the box.\n\nGo ahead?')) return false; return (warned[key] = true); }
function guard(id, key, msg, when = () => true) { const el = $(id), orig = el.onclick; el.onclick = e => { if (when(e) && !heavyOk(key, msg)) return; orig.call(el, e); }; }
guard('pvVidOn', 'video', 'The live video layer copies the TV picture from the box about 15 times a second. That uses box CPU and network while it is on.', () => !$('pvVidOn').classList.contains('on'));
guard('skInstall', 'ffmpeg', 'This installs the FFmpeg Tools add-on (about 65 MB) on the box from the CoreELEC repository. Kodi asks you to confirm on the TV.');
guard('ifInstall', 'iftop', 'This installs the System Tools add-on on the box from the CoreELEC repository. Kodi asks you to confirm on the TV.');
guard('kmLearn', 'debuglog', 'Learning a key switches Kodi debug logging on for a few seconds, which writes extra to the eMMC.');
{ const r = $('pvRate'), o = r.onchange; let last = r.value;
  r.onchange = e => { if (r.value === '0' && !heavyOk('fast', '"As fast as possible" asks Kodi for a screenshot again as soon as the last one arrives. That keeps the box busy.')) { r.value = last; return; } last = r.value; o.call(r, e); }; }

// skin tweaks and OSD are built from the same skin files, so each Default resets its own part and re-applies the rest
const OSD_ACTIVE = ['osdZoom', 'osdFrom', 'osdClear', 'osdBarH', 'osdHide'];
const OSD_KEYS = [...OSD_ACTIVE, 'zoomReplace', 'seekPreview', 'seekPlace', 'seekSize', 'seekBottom', 'seekColor'];
const tweakOn = k => { const v = T[k], d = DEF[k]; if (v === undefined) return false; if (d === undefined) return !!v && !(Array.isArray(v) && !v.length); return JSON.stringify(v) !== JSON.stringify(d); };
async function resetPart(keys, rest, el) {
  for (const k of keys) { if (k in DEF) T[k] = JSON.parse(JSON.stringify(DEF[k])); else delete T[k]; }
  save(); loadSkinState();
  const r = rest.some(tweakOn) ? await call('skin:apply', { id: tid, t: T }) : await call('skin:revert', tid);
  report(el, r.report);
}
$('skinDefault').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  if (!confirm('Turn every skin tweak off for this skin and put its original files back? OSD changes from the OSD themes page are kept.')) return;
  const keys = [...new Set([...Object.keys(DEF), ...Object.keys(T)])].filter(k => !OSD_KEYS.includes(k));
  $('skinReport').innerHTML = '<div class="note">Putting the skin back…</div>';
  await resetPart(keys, OSD_ACTIVE, $('skinReport'));
});
$('osdDefault').onclick = e => needConn() && tid && act(e.currentTarget, async () => {
  if (!confirm('Put this skin\'s stock OSD back: no zoom button, no borrowed OSD, normal bar and buttons? Skin tweaks from the Skin tweaks page are kept. The seek preview has its own switch below.')) return;
  $('osdReport').innerHTML = '<div class="note">Putting the OSD back…</div>';
  const rest = Object.keys(DEF).filter(k => !OSD_KEYS.includes(k));
  await resetPart(OSD_KEYS, rest, $('osdReport'));
});
$('zReset').onclick = e => act(e.currentTarget, async () => { ZV = [0, 0.2, 0.35]; zRender(); if (S.connected) { toast(await call('zoom:save', ZV)); ZV = await call('zoom:get'); zRender(); } });
$('pvDefault').onclick = () => {
  if (!$('pvLive').classList.contains('on')) $('pvLive').click();
  if ($('pvVidOn').classList.contains('on')) $('pvVidOn').click();
  $('pvVidQ').value = '640,15'; $('pvRate').value = '1500'; $('pvRate').onchange(); toast('Live view back to its defaults.');
};
$('kmDefault').onclick = e => needConn() && act(e.currentTarget, async () => {
  if (!confirm('Delete Kodi Control\'s keymap file (kodicontrol.xml) from the box and reload keymaps? Every binding made here is removed; Kodi\'s own keymaps and the Keymap Editor\'s gen.xml stay.')) return;
  toast(await call('keymap:default')); kmLoad();
});
$('kaDefault').onclick = e => needConn() && act(e.currentTarget, async () => {
  $('kaLong').classList.remove('on'); $('kaMulti').classList.remove('on'); $('kaFile').value = 'gen';
  const a = await call('kmaddon:set', { longpress: false, multifile: false, filename: 'gen' }); kaShow(a); toast('Keymap Editor settings back to defaults.');
});
$('usbUndo').onclick = e => needConn() && act(e.currentTarget, async () => {
  if (!confirm('Put back the artwork each movie and show had before Kodi Control changed it, and delete the copied images from the box?')) return;
  toast(await call('art:undo'));
});
$('m3uUndo').onclick = e => needConn() && act(e.currentTarget, async () => {
  if (!confirm('Put IPTV Simple\'s settings back to how they were before Kodi Control first changed them, and reload channels?')) return;
  toast(await call('iptv:undo')); m3uRefresh();
});
$('adUndo').onclick = e => needConn() && act(e.currentTarget, async () => {
  if (!confirm('Switch every add-on you turned on or off here back the way it was?')) return;
  toast(await call('addons:undo')); adLoad(); unLoad();
});
$('thDefault').onclick = () => { setTheme('midnight'); toast('Theme back to the default (Midnight).'); };
$('cHelperRemove').onclick = e => needConn() && act(e.currentTarget, async () => {
  if (!confirm('Remove the stats helper add-on from the box? The dashboard goes back to reading over SSH.')) return;
  toast(await call('addons:remove', 'service.kodicontrol'));
  if ($('cVia').value === 'helper') { $('cVia').value = ''; $('cVia').onchange(); }
});
// one list of everything the app changed on the box: a switch where a thing can be turned on and off,
// a button where it can only be put back or deleted
const swHtml = (on, attrs, label) => `<div class="sw${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" ${attrs}></div>`;
const addonText = a => !a.installed ? `Not on the box${a.copy ? ' · copy kept in Kodi Control' : ''}` : a.enabled ? 'Installed, enabled' : 'Installed, disabled';
async function unLoad(btn) {
  if (!S.connected) return;
  const go = async () => {
    const u = await call('undo:status'), rows = [];
    for (const a of u.addons) {
      if (!a.installed && !a.copy && !a.byApp && a.id === 'virtual.system-tools') continue;
      rows.push([`${esc(a.name)} <span class="note mono">${esc(a.id)} ${esc(a.version || '')}</span>${a.heavy ? ` <span class="tag warn" title="${esc(a.heavy)}">heavy</span>` : ''}`,
        `${addonText(a)} · ${esc(a.why)}`,
        `${swHtml(a.installed && a.enabled, `data-unsw="${esc(a.id)}"`, a.name)}${a.installed ? `<button class="btn" data-unrm="${esc(a.id)}">Remove</button>` : ''}`]);
    }
    rows.push(['Seek preview', u.seekOn ? 'On in every skin' : 'Off · Kodi\'s own seek settings', swHtml(u.seekOn, 'data-unseek', 'Seek preview')]);
    if (u.seek.changed && !u.seekOn) rows.push(['Kodi seek delay and steps', `Now ${u.seek.delay} ms, ${(u.seek.steps || []).join(', ')} s · was ${u.seek.orig.delay} ms, ${u.seek.orig.steps.join(', ')} s`, '<button class="btn" data-un="seek:default">Put back</button>']);
    rows.push(['Seek preview frame cache', `${u.seekRam ? 'RAM only, nothing on the eMMC' : 'Kept on the eMMC (last 3 videos)'}${u.seekCacheKb ? ' · ' + fmtBytes(u.seekCacheKb * 1024) + ' now' : ''}<br><span class="note">Switch on = keep frames on the eMMC; off = RAM only</span>`,
      `${swHtml(!u.seekRam, 'data-unram', 'Keep seek frames on the eMMC')}${u.seekCacheKb ? '<button class="btn" data-un="seek:clearCache">Delete</button>' : ''}`]);
    for (const k of u.skins) rows.push([`Skin files: ${esc(k.name)}${k.active ? ' <span class="tag cur">active</span>' : ''}`,
      `${k.patched ? 'Patched by Kodi Control' : 'Original files'}${k.tweaks ? ' · tweaks saved here' : ''}<br><span class="note">Switch off = the skin's original files (your tweak settings stay saved here); on = patched again</span>`,
      swHtml(k.patched, `data-unskin="${esc(k.id)}"`, 'Skin files ' + k.name)]);
    if (u.keymapFile) rows.push(['Keymap file kodicontrol.xml', 'Bindings made in Keymaps', '<button class="btn" data-un="keymap:default">Delete</button>']);
    if (u.addonToggles.length) rows.push(['Add-on switches', u.addonToggles.map(t => `${esc(t.id)} was ${t.was ? 'on' : 'off'}`).join(', '), '<button class="btn" data-un="addons:undo">Undo</button>']);
    if (u.artChanges) rows.push(['Library artwork', `${u.artChanges} change${u.artChanges === 1 ? '' : 's'} from Media`, '<button class="btn" data-un="art:undo">Undo</button>']);
    if (u.iptvOrig) rows.push(['IPTV Simple settings', 'Original saved before the first change', '<button class="btn" data-un="iptv:undo">Restore</button>']);
    $('unTable').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td class="note">${r[1]}</td><td style="text-align:right;white-space:nowrap"><span class="row" style="justify-content:flex-end;gap:8px">${r[2]}</span></td></tr>`).join('');
    const busy = (el, fn) => { if (el.dataset.busy) return; el.dataset.busy = 1; el.style.opacity = .5; act(null, fn).finally(() => { delete el.dataset.busy; el.style.opacity = ''; unLoad(); }); };
    $$('[data-unsw]').forEach(el => el.onclick = () => {
      const id = el.dataset.unsw, a = u.addons.find(x => x.id === id), on = !el.classList.contains('on');
      if (on && !a.installed && !a.copy && !['script.kodicontrol', 'service.kodicontrol'].includes(id) && !heavyOk('inst-' + id, `This installs ${a.name} on the box from its repository. Kodi asks you to confirm on the TV.`)) return;
      if (on && a.heavy && !heavyOk('on-' + id, `${a.name}: ${a.heavy}.`)) return;
      if (!on && id === 'script.kodicontrol' && !confirm('With the helper disabled, the zoom preset button and the seek preview stop working until you switch it back on. Disable it?')) return;
      busy(el, async () => { toast(await call('addons:setApp', { id, enabled: on })); if (id === 'service.kodicontrol') cHelperState(); if (id === 'script.kodicontrol') osdHelperState(); });
    });
    $$('[data-unrm]').forEach(b => b.onclick = ev => act(ev.currentTarget, async () => {
      const id = b.dataset.unrm, a = u.addons.find(x => x.id === id);
      if (!confirm(`Remove ${a.name} from the box?${['script.kodicontrol', 'service.kodicontrol'].includes(id) ? ' Kodi Control can put it back any time.' : ' A copy is kept in Kodi Control first, so switching it on again needs no download.'}`)) return;
      toast(await call('addons:remove', id));
      if (id === 'service.kodicontrol' && $('cVia').value === 'helper') { $('cVia').value = ''; $('cVia').onchange(); }
      unLoad(); cHelperState(); osdHelperState();
    }));
    $$('[data-unseek]').forEach(el => el.onclick = () => { show('osd'); $('skOn').scrollIntoView({ block: 'center' }); $('skOn').click(); });
    $$('[data-unram]').forEach(el => el.onclick = () => busy(el, async () => { toast(await call('seek:ram', el.classList.contains('on'))); }));
    $$('[data-unskin]').forEach(el => el.onclick = () => {
      const on = !el.classList.contains('on');
      if (!on && !confirm('Put this skin\'s original files back? Your tweak settings stay saved in Kodi Control, so switching it on patches them in again.')) return;
      busy(el, async () => toast(await call('skin:setPatched', { id: el.dataset.unskin, on })));
    });
    $$('[data-un]').forEach(b => b.onclick = ev => act(ev.currentTarget, async () => { if (!confirm('Put this back?')) return; const r = await call(b.dataset.un); toast(typeof r === 'string' ? r : 'Done'); unLoad(); }));
  };
  return btn ? act(btn, go) : go().catch(e => { $('unTable').innerHTML = `<tr><td class="empty">${esc(e.message)}</td></tr>`; });
}
$('unLoad').onclick = e => needConn() && unLoad(e.currentTarget);

// helper add-ons: say which one, and whether it is installed and enabled, with one switch to change that
async function helperSwitch(id, stateEl, swEl, extra) {
  if (!S.connected) { stateEl.textContent = stateEl.dataset.label + ': not connected'; return; }
  try {
    const a = await call('addons:appState', id);
    stateEl.textContent = `${stateEl.dataset.label}: ${addonText(a).toLowerCase()}`;
    swEl.classList.toggle('on', !!(a.installed && a.enabled)); swEl.setAttribute('aria-checked', !!(a.installed && a.enabled));
    if (extra) extra(a);
    return a;
  } catch (e) { stateEl.textContent = stateEl.dataset.label + ': ' + e.message; }
}
$('cHelperState').dataset.label = 'Kodi Control stats helper (service.kodicontrol)';
$('osdHelperState').dataset.label = 'Kodi Control helper (script.kodicontrol)';
const cHelperState = () => helperSwitch('service.kodicontrol', $('cHelperState'), $('cHelperSw'), a => { $('cHelperInstall').style.display = a.installed ? 'none' : ''; $('cHelperRemove').style.display = a.installed ? '' : 'none'; });
const osdHelperState = () => helperSwitch('script.kodicontrol', $('osdHelperState'), $('osdHelperSw'));
$('cHelperSw').onclick = () => needConn() && act(null, async () => {
  const on = !$('cHelperSw').classList.contains('on');
  if (on) { const a = await call('addons:appState', 'service.kodicontrol'); if (!a.installed) return $('cHelperInstall').click(); }
  toast(await call('addons:setApp', { id: 'service.kodicontrol', enabled: on }));
  if (!on && $('cVia').value === 'helper') { $('cVia').value = ''; $('cVia').onchange(); }
  cHelperState();
});
$('osdHelperSw').onclick = () => needConn() && act(null, async () => {
  const on = !$('osdHelperSw').classList.contains('on');
  if (!on && !confirm('With the helper disabled, the zoom preset button and the seek preview stop working until you switch it back on. Disable it?')) return;
  toast(await call('addons:setApp', { id: 'script.kodicontrol', enabled: on })); osdHelperState();
});
{ const o = $('cHelperInstall').onclick; $('cHelperInstall').onclick = e => { const p = o && o.call($('cHelperInstall'), e); Promise.resolve(p).finally(() => setTimeout(cHelperState, 500)); }; }
{ const o = $('cHelperRemove').onclick; $('cHelperRemove').onclick = e => { const p = o && o.call($('cHelperRemove'), e); Promise.resolve(p).finally(() => setTimeout(cHelperState, 500)); }; }
