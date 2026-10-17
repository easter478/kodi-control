// Live self-test: `"Kodi Control.exe" --selftest [report.json]` connects with the saved (sealed) connection,
// runs every read-only feature against the box and writes a pass/fail report. Nothing on the box is changed
// except the debug-log toggle used by the key watcher (switched back off) and the Keymap Editor add-on settings,
// which are written back with their current values.
const fs = require('fs');

async function run({ handlers, sh, kh, out }) {
  const results = [];
  const step = async (name, fn, check) => {
    const t0 = Date.now();
    try {
      const r = await Promise.race([fn(), new Promise((_, j) => setTimeout(() => j(new Error('timeout 30 s')), 30000))]);
      const bad = check ? check(r) : '';
      results.push({ name, ok: !bad, ms: Date.now() - t0, note: bad || summary(r) });
      return r;
    } catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, note: e.message || String(e) }); return null; }
  };
  const summary = r => {
    if (r == null) return '';
    if (Array.isArray(r)) return `${r.length} items`;
    if (typeof r === 'object') return Object.keys(r).slice(0, 8).join(', ');
    return String(r).slice(0, 600);
  };
  const call = (ch, arg) => () => handlers[ch](arg);

  const conn = await step('connect (saved connection)', call('conn:connect', {}), r => r.ok ? '' : 'not ok');
  if (!conn) return finish();
  results[0].note = `Kodi ${conn.version || '?'} · rpc ${conn.rpcOk ? 'ok (' + conn.rpcMode + ')' : 'FAIL ' + conn.rpcErr} · home ${conn.kodiHome}`;
  await step('rpc ping', call('rpc', { method: 'JSONRPC.Ping' }), r => r === 'pong' ? '' : 'got ' + r);
  const st = await step('stats', call('stats'));
  await step('dashboard stats (2nd poll: rates, disk, load, kodi, library, os)', async () => {
    const s = await handlers.stats();
    const miss = ['net', 'disks', 'load', 'kodi', 'library', 'os'].filter(k => !s[k] || (Array.isArray(s[k]) && !s[k].length));
    if (miss.length || s.net.down == null) throw new Error('missing ' + (miss.join(', ') || 'net rate'));
    return `net ↓${Math.round(s.net.down / 1e3)}Kb/s ↑${Math.round(s.net.up / 1e3)}Kb/s · /storage ${Math.round(s.disks[0].used / 1e9)}/${Math.round(s.disks[0].total / 1e9)} GB · load ${s.load.l1} · kodi ${Math.round(s.kodi.rss / 1e6)} MB ${s.kodi.cpu}% · lib ${JSON.stringify(s.library)} · ${s.os.name} ${s.os.kernel} · ${s.addons} add-ons`;
  });
  if (st && st.playing) await step('now playing poster (loads in the background, shows on a later refresh)', async () => {
    let p = st.playing;
    for (let i = 0; i < 20 && !p.thumb; i++) { await new Promise(r => setTimeout(r, 500)); p = (await handlers.stats()).playing || p; }
    return p.thumb ? 'poster ' + p.thumb.length + ' bytes (data URL)' : Promise.reject(new Error('no poster for ' + JSON.stringify(p.item.art || {}).slice(0, 200)));
  });
  await step('RPC route speed: 10 pings', async () => { const t0 = Date.now(); for (let i = 0; i < 10; i++) await handlers.rpc({ method: 'JSONRPC.Ping' }); return `${Math.round((Date.now() - t0) / 10)} ms per call`; });
  await step('dashboard refresh time', async () => { const t0 = Date.now(); await handlers.stats(); return `${Date.now() - t0} ms`; });
  await step('poster from texture cache (no web server)', async () => {
    const tx = await handlers.rpc({ method: 'Textures.GetTextures', params: { properties: ['url'] } });
    const u = ((tx.textures || []).find(x => /poster|.jpe?g/i.test(x.url)) || (tx.textures || [])[0] || {}).url;
    if (!u) return 'texture cache empty';
    const d = await handlers['np:art'](u);
    if (!d) throw new Error('could not load ' + u.slice(0, 120));
    return d.slice(0, 22) + '… ' + d.length + ' bytes';
  });
  await step('network (iftop)', call('iftop'));
  await step('network totals + whole-box rate', call('iftop'), r => r.total && r.total.down != null ? '' : 'no totals');
  await step('M3U browse: find playlists on the box', call('files:find', { dir: '/storage', ext: 'm3u,m3u8', depth: 6 }));
  await step('logs', call('logs'));
  await step('backup sizes (all sets)', async () => { const r = await handlers['backup:sizes'](); return Object.entries(r).map(([k, v]) => `${k} ${(v / 1048576).toFixed(1)} MB`).join(', '); });
  await step('backup list', call('backup:list'));
  const skins = await step('skins list', call('skins:list'), r => r.skins.length ? '' : 'no skins');
  const id = skins && skins.current;
  if (id) {
    results[results.length - 1].note += ` · current ${id}`;
    await step(`skin menu (${id})`, call('skin:menu', id));
    await step(`skin animations (${id})`, call('skin:anims', id));
    await step(`window animations (${id})`, call('skin:winAnims', id));
    await step(`OSD buttons with names (${id})`, async () => { const b = await handlers['skin:osdButtons']({ id }); if (b.some(x => !x.name)) throw new Error('unnamed: ' + b.filter(x => !x.name).map(x => x.id)); return b.map(x => `${x.id} ${x.name}${x.section ? ' [' + x.section + ']' : ''}`).join(', '); });
    for (const other of ['skin.bald', 'skin.nimbus', 'skin.cupertino'].filter(o => skins.skins.some(s => s.id === o))) await step(`OSD buttons with names (${other} as source)`, async () => (await handlers['skin:osdButtons']({ id, from: other })).map(x => `${x.id} ${x.name}`).join(', '));
    await step(`info items (${id})`, call('skin:infoItems', id));
  }
  await step('player process info', call('player:ppi'));
  await step('live view screenshot', call('preview:shot'), r => r ? '' : 'empty');
  const km = await step('keymap list', call('keymap:list'));
  await step('keymap preview xml', call('keymap:preview', [{ window: 'global', key: 'f1', action: 'Info' }]), r => /<keymap>/.test(r) ? '' : 'bad xml');
  // Keymap Editor add-on (script.keymap): installed? enabled? settings?
  await step('Keymap Editor add-on', async () => {
    const H = kh();
    const t = await sh(`for d in ${H}/addons/script.keymap /usr/share/kodi/addons/script.keymap; do [ -d "$d" ] && { echo "dir=$d"; ls "$d"; ls "$d/resources" 2>/dev/null | sed 's/^/res:/'; grep -o 'version="[^"]*"' "$d/addon.xml" | head -2; }; done; ls ${H}/userdata/addon_data/script.keymap 2>/dev/null | sed 's/^/data:/'; ls ${H}/userdata/keymaps 2>/dev/null | sed 's/^/km:/'`);
    let enabled = '';
    try { enabled = JSON.stringify(await handlers.rpc({ method: 'Addons.GetAddonDetails', params: { addonid: 'script.keymap', properties: ['enabled', 'version', 'broken'] } })); } catch (e) { enabled = 'rpc: ' + e.message; }
    return (t.trim() || 'NOT INSTALLED') + '\n' + enabled;
  });
  const ka = await step('Keymap Editor settings read', call('kmaddon:get'), r => r.installed ? '' : 'not installed');
  if (ka && ka.installed) {
    results[results.length - 1].note = JSON.stringify(ka.settings) + (ka.enabled ? '' : ' (disabled)');
    await step('Keymap Editor settings save (same values)', call('kmaddon:set', ka.settings),
      r => JSON.stringify(r.settings) === JSON.stringify(ka.settings) ? (r.reloaded ? '' : 'saved, not reloaded') : 'round-trip changed values: ' + JSON.stringify(r.settings));
  }
  await step('USB drives', call('usb:list'));
  await step('M3U / PVR status', call('m3u:status'));
  await step('files list (userdata)', call('files:list', kh() + '/userdata'), r => r && (r.items || r).length ? '' : 'empty');
  await step('files find *.xml in keymaps', call('files:find', { dir: kh() + '/userdata', ext: 'xml', depth: 2 }));
  const w = await step('key watch on', call('keys:watch', true));
  if (w) {
    await new Promise(r => setTimeout(r, 1500));
    await step('key poll', call('keys:poll', w.off));
    await step('key watch off', call('keys:watch', false));
  }
  return finish();

  function finish() {
    const rep = { at: new Date().toISOString(), pass: results.filter(r => r.ok).length, fail: results.filter(r => !r.ok).length, results, keymapFiles: km || null };
    fs.writeFileSync(out, JSON.stringify(rep, null, 2));
    return rep;
  }
}

module.exports = { run };
