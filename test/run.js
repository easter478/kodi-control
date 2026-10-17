// Offline tests: run with `npm test`. No Kodi box needed.
// The features run against a fake "box": a temp folder driven through a real local bash (Git Bash on Windows),
// so the shell snippets (stat/find/tail/head/cat loops) are executed for real, not just string-checked.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const features = require('../app/features');
const skin = require('../app/skin');

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push('  ok   ' + name); }
  catch (e) { fail++; results.push('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fake box ----------
const BASH = process.env.KC_BASH || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
function exec(cmd, { stdin, timeout = 30000, onData } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(BASH, ['-c', cmd]);
    const out = [], err = [];
    const t = timeout ? setTimeout(() => { p.kill(); reject(new Error('Timed out: ' + cmd.slice(0, 60))); }, timeout) : null;
    p.stdout.on('data', d => { if (onData) onData(d); else out.push(d); });
    p.stderr.on('data', d => err.push(d));
    p.on('close', code => { if (t) clearTimeout(t); resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }); });
    if (stdin != null) p.stdin.end(stdin); else p.stdin.end();
  });
}
const sh = async (cmd, o) => (await exec(cmd, o)).out.toString();

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-test-')).replace(/\\/g, '/');
const KH = ROOT + '/.kodi';
const DEST = ROOT + '/pulled';
const LOG = KH + '/temp/kodi.log';
const w = (rel, data) => { const f = path.join(KH, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
w('temp/kodi.log', '2026-10-17 10:00:00.000 T:1 info <general>: Starting Kodi\n');
w('userdata/guisettings.xml', '<settings/>');
w('userdata/keymaps/remote.xml', '<keymap/>');
w('userdata/keymaps/sub dir/it\'s odd.xml', '<keymap>odd</keymap>');
w('userdata/addon_data/a/notes.LOG', 'x'.repeat(5000));
w('userdata/.hidden.txt', 'h');
w('userdata/big.bin', Buffer.alloc(300000, 7));

const calls = { rpc: [], builtin: [] };
const settings = { 'debug.showloginfo': false };
let rpcFails = false;
async function rpc(method, params) {
  calls.rpc.push([method, params]);
  if (rpcFails) throw new Error('rpc down');
  if (method === 'Settings.GetSettingValue') return { value: settings[params.setting] };
  if (method === 'Settings.SetSettingValue') { settings[params.setting] = params.value; return true; }
  return {};
}
async function builtin(cmd) {
  calls.builtin.push(cmd);
  const m = /^TakeScreenshot\(([^,]+),sync\)$/.exec(cmd);
  // write the "PNG" in two steps so the size-stable poll has to wait for it
  if (m) setTimeout(() => exec(`printf '\\211PNG' > ${q(m[1])}; sleep 0.1; head -c 4000 /dev/zero >> ${q(m[1])}; printf 'IENDcrc!' >> ${q(m[1])}`), 50);
  if (cmd === 'ToggleDebug') settings['debug.showloginfo'] = !settings['debug.showloginfo'];
  return 'mock';
}
const sent = [];
const F = features.make({
  exec, sh, q, rpc, builtin, cfg: { conn: {} }, saveCfg() {}, kh: () => KH, has: () => true, app: { getPath: () => ROOT },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [DEST] }), showSaveDialog: async () => ({ canceled: true }) },
  win: () => null, send: (ch, d) => sent.push([ch, d]),
});
const appendLog = text => fs.appendFileSync(LOG, text);

// ---------- sample Aeon Nox style skin ----------
const AEON = {
  'skin.aeon.nox.silvo/16x9/Variables.xml': `<includes>
    <variable name="MediaFlagRes"><value condition="true">flags/resolution/$INFO[ListItem.VideoResolution].png</value></variable>
    <variable name="InfoLine"><value>$INFO[ListItem.Year] • $VAR[Runtime]</value></variable>
    <variable name="Runtime"><value>$INFO[ListItem.Duration]</value></variable>
  </includes>`,
  'skin.aeon.nox.silvo/16x9/Includes_Info.xml': `<includes>
    <include name="InfoRow"><control type="label" id="1"><label>$VAR[InfoLine]</label></control></include>
    <include name="Plot"><control type="textbox"><label>$INFO[ListItem.Plot]</label></control></include>
    <include name="Flag"><control type="image"><texture>$VAR[MediaFlagRes]</texture></control></include>
    <include name="StarIcon"><control type="image"><width>40</width><height>40</height><texture>icons/star.png</texture></control></include>
    <include name="Genre"><param name="info" default="x"/><control type="label"><label>$PARAM[info]</label></control></include>
  </includes>`,
  'skin.aeon.nox.silvo/16x9/MyVideoNav.xml': `<window><controls>
    <include>InfoRow</include><include>Plot</include><include>Flag</include><include>StarIcon</include>
    <include content="Genre"><param name="info" value="$INFO[ListItem.Genre]"/></include>
    <control type="image"><texture>background.jpg</texture></control>
  </controls></window>`,
  'skin.aeon.nox.silvo/16x9/VideoOSD.xml': `<window><controls><include>OSDButtons</include>
    <control type="button" id="900"><label>Root button</label></control></controls></window>`,
  'skin.aeon.nox.silvo/16x9/Includes_OSD.xml': `<includes>
    <include name="OSDButtons"><control type="grouplist">
      <control type="button" id="601"><label>$LOCALIZE[31001]</label><onclick>PlayerControl(Play)</onclick><texturenofocus>osd/play.png</texturenofocus></control>
      <control type="togglebutton" id="602"><label>Subtitles</label><onclick>ActivateWindow(osdsubtitlesettings)</onclick></control>
    </control></include>
    <include name="Unrelated"><control type="button" id="601"><label>Elsewhere</label></control></include>
  </includes>`,
};

(async () => {
  // ----- key log parsing -----
  await test('parse keyboard OnKey line (Kodi 21)', () => {
    const [k] = features.parseKeys('2026-10-17 10:00:01.123 T:1 debug <general>: CInputManager::OnKey: up (0xf080) pressed, window 10000, action is Up');
    eq([k.kind, k.device, k.key, k.id, k.window, k.current, k.time], ['key', 'keyboard', 'up', '61568', '10000', 'Up', '10:00:01.123']);
  });
  await test('parse IR remote OnKey line maps id to remote name', () => {
    const [k] = features.parseKeys('x 10:00:02 T:1 debug: OnKey: 168 (0xa8) pressed, action is Right');
    eq([k.device, k.key, k.id], ['remote', 'right', '168']);
  });
  await test('parse long press', () => {
    const [k] = features.parseKeys('x 10:00:03 T:1 debug: CInputManager::OnKey: long-226 (0xe2) pressed, window 12005, action is Rewind');
    eq([k.key, k.long, k.window], ['reverse', true, '12005']);
  });
  await test('last key matches Keymap Editor: key-up raw lines after HandleKey are dropped (real CoreELEC log)', () => {
    const ks = features.parseKeys([
      '2026-10-17 20:42:56.782 T:8622    debug <general>: void CLibInputKeyboard::ProcessKey(libinput_event_keyboard*): libinput key: 0x6c, xkb keysym: 0xff54 (Down)',
      '2026-10-17 20:42:56.817 T:8616    debug <general>: Keyboard: scancode: 0x6c, sym: 0x112 (down), unicode: 0x00, modifier: 0x0',
      '2026-10-17 20:42:56.817 T:8616    debug <general>: bool CInputManager::HandleKey(const CKey&): down (0xf081) pressed, window 12000, action is Down',
      '2026-10-17 20:42:56.942 T:8616    debug <general>: Keyboard: scancode: 0x6c, sym: 0x112 (down), unicode: 0x00, modifier: 0x0',
    ].join('\n'));
    eq(ks.map(k => [k.key, k.id, k.current]), [['down', '61569', 'Down']]);
  });
  await test('Keymap Editor key codes read as names', () => {
    eq([61526, 61569, 61616, 0xf090, 0x10000 | 0xf041, 168].map(features.keyName), ['v', 'down', 'browser_back', 'f1', 'ctrl+a', '']);
  });
  await test('parse raw keyboard / LIRC / CEC lines', () => {
    const ks = features.parseKeys([
      'x 10:00:04 T:1 debug: Keyboard: scancode: 0x1e, sym: 0x0061, unicode: 0x0061, modifier: 0x0',
      'x 10:00:05 T:1 debug: LIRC: Update - NEW at 1:KEY_OK (KEY_OK)',
      'x 10:00:06 T:1 debug: CecLogMessage - key pressed: select (0) current(ff) duration(0)',
      'x 10:00:07 T:1 info: nothing to see here',
    ].join('\n'));
    eq(ks.map(k => [k.kind, k.device, k.key]), [['raw', 'keyboard', 'a'], ['raw', 'remote', 'ok'], ['raw', 'remote', 'select']]);
  });
  await test('HandleKey (older Kodi) is parsed', () => {
    eq(features.parseKeyLine('HandleKey: 61448 (0xf008) pressed, action is Back').key, '61448');
  });

  // ----- skin: Hide info (Aeon Nox) -----
  await test('infoItems finds text, variable-driven text, icons, static icons and include params', () => {
    const keys = skin.infoItems(AEON).map(i => i.key);
    for (const k of ['t:Year', 't:Duration', 't:Plot', 'i:VideoResolution', 's:icons/star.png', 'p:Genre']) ok(keys.includes(k), 'missing ' + k + ' in ' + keys.join(','));
    ok(!keys.some(k => k.includes('background')), 'background picked up as an icon');
  });
  await test('applyAll hideItems hides the chosen text and icons only', () => {
    const { changed, report } = skin.applyAll(AEON, { hideItems: ['t:Plot', 'i:VideoResolution', 's:icons/star.png', 'p:Genre'] });
    const inc = changed['skin.aeon.nox.silvo/16x9/Includes_Info.xml'];
    ok(inc, 'Includes_Info.xml not changed: ' + JSON.stringify(report));
    eq((inc.match(/item hidden --><visible>false/g) || []).length, 3, 'hidden control count');
    ok(/<control type="label" id="1"><label>\$VAR\[InfoLine\]/.test(inc), 'InfoRow should stay visible');
    ok(/kodicontrol: item hidden <include content="Genre"/.test(changed['skin.aeon.nox.silvo/16x9/MyVideoNav.xml']), 'Genre include not commented out');
    const again = skin.applyAll({ ...AEON, ...changed }, { hideItems: ['t:Plot'] });
    eq(Object.keys(again.changed).length, 0, 'second apply should be a no-op');
  });

  // ----- skin: video OSD -----
  await test('osdFiles follows VideoOSD includes into Includes_OSD.xml', () => {
    eq(skin.osdFiles(AEON).map(f => f.split('/').pop()).sort(), ['Includes_OSD.xml', 'VideoOSD.xml']);
  });
  await test('osdButtons lists OSD buttons, not same-id buttons outside the OSD', () => {
    const b = skin.osdButtons(AEON);
    eq(b.map(x => [x.id, x.label]), [['900', 'Root button'], ['601', 'string 31001'], ['602', 'Subtitles']]);
  });
  await test('applyAll osdHide only touches buttons inside the OSD', () => {
    const { changed } = skin.applyAll(AEON, { osdHide: ['601'] });
    const x = changed['skin.aeon.nox.silvo/16x9/Includes_OSD.xml'];
    eq((x.match(/button hidden/g) || []).length, 1);
    ok(/<control type="button" id="601"><label>Elsewhere/.test(x), 'unrelated 601 was hidden');
  });
  // the real Aeon Nox SiLVO OSD files (from the skin's GitHub repo)
  const REAL = {};
  for (const f of fs.readdirSync(path.join(__dirname, 'fixtures/aeon-osd'))) REAL['skin.aeon.nox.silvo/16x9/' + f] = fs.readFileSync(path.join(__dirname, 'fixtures/aeon-osd', f));
  await test('Transparent OSD on real Aeon Nox clears the bottom bar in Includes_OSD.xml', () => {
    const { changed, report } = skin.applyAll(REAL, { osdClear: true });
    const inc = changed['skin.aeon.nox.silvo/16x9/Includes_OSD.xml'] || '';
    ok(/bottombar\.png<\/texture>\s*<colordiffuse>00FFFFFF<\/colordiffuse>/.test(inc),'bottombar.png not cleared: ' + JSON.stringify(report));
    ok(/<texture[^>]*colordiffuse="00FFFFFF"[^>]*>dialogs\/default\/bg\.png/.test(changed['skin.aeon.nox.silvo/16x9/VideoOSD.xml'] || ''), 'VideoOSD top bar not cleared');
    ok(/<texture>osd\/btn_pause\.png<\/texture>/.test(inc), 'pause button should stay');
    ok(!/D9FFFFFF/.test(inc), 'a texture colordiffuse attribute still shows the bar');
    ok(/<texture flipx="true">osd\/ff\.png<\/texture>\s*<colordiffuse>FFe5e5e5/.test(changed['skin.aeon.nox.silvo/16x9/DialogSeekBar.xml'] || REAL['skin.aeon.nox.silvo/16x9/DialogSeekBar.xml'].toString()), 'ff icon should stay');
    const again = skin.applyAll({ ...REAL, ...changed }, { osdClear: true });
    eq(Object.keys(again.changed).length, 0, 'second apply should be a no-op');
  });
  await test('Progress bar height on real Aeon Nox reaches the seekbar in Includes_OSD.xml', () => {
    const { changed } = skin.applyAll(REAL, { osdBarH: 10 });
    ok(/<control type="progress">\s*<width>100%<\/width>\s*<height>10<\/height>/.test(changed['skin.aeon.nox.silvo/16x9/Includes_OSD.xml'] || ''), 'seekbar progress not thinned');
  });

  // ----- pull files -----
  await test('files:list lists folders first, sizes, hidden files, odd names', async () => {
    const r = await F['files:list'](KH + '/userdata');
    eq(r.items.map(i => [i.dir, i.name]), [[true, 'addon_data'], [true, 'keymaps'], [false, '.hidden.txt'], [false, 'big.bin'], [false, 'guisettings.xml']]);
    eq(r.items.find(i => i.name === 'big.bin').size, 300000);
  });
  await test('files:list on a missing folder throws', async () => {
    let e; try { await F['files:list'](KH + '/nope'); } catch (x) { e = x; }
    ok(e && /Cannot open/.test(e.message), 'expected Cannot open');
  });
  await test('files:find matches extensions case-insensitively, with spaces and quotes in names', async () => {
    const r = await F['files:find']({ dir: KH, ext: '.xml, log' });
    const rel = r.items.map(i => i.path.slice(KH.length + 1)).sort();
    eq(rel, ['temp/kodi.log', 'userdata/addon_data/a/notes.LOG', 'userdata/guisettings.xml', "userdata/keymaps/remote.xml", "userdata/keymaps/sub dir/it's odd.xml"]);
    eq(r.items.find(i => i.path.endsWith('notes.LOG')).size, 5000);
  });
  await test('files:find depth limit', async () => {
    const r = await F['files:find']({ dir: KH, ext: 'xml', depth: 2 });
    eq(r.items.map(i => i.path.slice(KH.length + 1)).sort(), ['userdata/guisettings.xml']);
  });
  await test('files:find with no extension throws', async () => {
    let e; try { await F['files:find']({ dir: KH, ext: ' ,. ' }); } catch (x) { e = x; }
    ok(e, 'expected an error');
  });
  await test('files:pull keeps sub-folders under base, copies bytes exactly, reports progress', async () => {
    sent.length = 0;
    const paths = [KH + "/userdata/keymaps/sub dir/it's odd.xml", KH + '/userdata/big.bin'];
    const r = await F['files:pull']({ paths, base: KH + '/userdata' });
    eq([r.done, r.failed.length, r.bytes], [2, 0, 300000 + 20]);
    eq(fs.readFileSync(path.join(DEST, 'keymaps', 'sub dir', "it's odd.xml"), 'utf8'), '<keymap>odd</keymap>');
    ok(fs.readFileSync(path.join(DEST, 'big.bin')).equals(Buffer.alloc(300000, 7)), 'big.bin differs');
    eq(sent.filter(s => s[1].op === 'pull').map(s => s[1].done), [1, 2]);
  });
  await test('files:pull reports a missing file as failed and leaves no empty file', async () => {
    const r = await F['files:pull']({ paths: [KH + '/gone.txt'] });
    eq([r.done, r.failed.length], [0, 1]);
    ok(!fs.existsSync(path.join(DEST, 'gone.txt')), 'empty file left behind');
  });

  // ----- last key monitor -----
  await test('keys:watch turns debug logging on, keys:poll sees new presses, watch(false) restores it', async () => {
    settings['debug.showloginfo'] = false;
    const w0 = await F['keys:watch'](true);
    eq(settings['debug.showloginfo'], true, 'debug not switched on');
    appendLog('2026-10-17 10:01:00.000 T:1 debug <general>: CInputManager::OnKey: left (0xf082) pressed, window 10025, action is Left\n');
    const p = await F['keys:poll'](w0.off);
    eq(p.keys.map(k => k.key), ['left']);
    eq((await F['keys:poll'](p.off)).keys.length, 0, 'same press reported twice');
    await F['keys:watch'](false);
    eq(settings['debug.showloginfo'], false, 'debug not restored');
  });
  await test('keys:poll survives log rotation (file got smaller)', async () => {
    const big = fs.statSync(LOG).size;
    fs.writeFileSync(LOG, 'x 10:02:00 T:1 debug: OnKey: 11 (0xb) pressed, action is Select\n');
    eq((await F['keys:poll'](big)).keys.map(k => k.key), ['select']);
  });

  // ----- Learn a key (the reported bug) -----
  await test('Learn: switches debug on even when reading the setting fails', async () => {
    settings['debug.showloginfo'] = false;
    calls.builtin.length = 0;
    rpcFails = true;
    setTimeout(() => appendLog('x 10:03:00 T:1 debug: CInputManager::OnKey: down (0xf081) pressed, window 10000, action is Down\n'), 500);
    const k = await F['keymap:learn']();
    rpcFails = false;
    eq(k.key, 'down');
    ok(calls.builtin.includes('ToggleDebug'), 'debug logging was never turned on');
  });
  await test('Learn: returns the first press after it starts, ignoring older lines', async () => {
    appendLog('x 10:04:00 T:1 debug: OnKey: 230 (0xe6) pressed, action is Pause\n');
    setTimeout(() => appendLog('x 10:04:01 T:1 debug: CecLogMessage - key pressed: up (1)\nx 10:04:01 T:1 debug: OnKey: 166 (0xa6) pressed, window 10000, action is Up\n'), 400);
    const k = await F['keymap:learn']();
    eq([k.kind, k.device, k.key], ['key', 'remote', 'up']);
  });
  await test('Learn: an unmapped CEC key (raw line only) is still returned', async () => {
    setTimeout(() => appendLog('x 10:05:00 T:1 debug: CecLogMessage - key pressed: channel up (48)\n'), 300);
    const k = await F['keymap:learn']();
    eq([k.kind, k.key], ['raw', 'channelup']);
  });

  // ----- live view -----
  await test('live view screenshot: one builtin call, waits for the file to finish, cleans up', async () => {
    calls.builtin.length = 0;
    const t0 = Date.now();
    const url = await F['preview:shot']();
    ok(url.startsWith('data:image/png;base64,'), 'not a data url');
    eq(Buffer.from(url.split(',')[1], 'base64').length, 4012, 'got a half-written file');
    eq(calls.builtin.length, 1);
    const left = await sh(`ls /tmp/kodicontrol-shot-${process.pid}-* 2>/dev/null | wc -l`);
    eq(left.trim(), '0', 'screenshot file left behind');
    results.push(`       (one frame took ${Date.now() - t0} ms against the local fake box)`);
  });
  await test('live view: back-to-back shots use distinct files', async () => {
    const [a, b] = await Promise.all([F['preview:shot'](), F['preview:shot']()]);
    ok(a && b);
    const names = calls.builtin.slice(-2);
    ok(names[0] !== names[1], 'same filename reused');
  });

  // ---------- skin logic (pure XML, no box) ----------
  const T0 = { radius: 12, speed: 100, anim: '', bgs: [], hbItems: [], menuId: 9000, hideInfo: [], hideItems: [], osdHide: [], osdBarH: 0, winAnimFiles: [] };
  await test('OSD names: icon-font glyph labels, conditional onclicks, template buttons, commented-out buttons', async () => {
    const files = { 'xml/VideoOSD.xml': `<window><controls>
      <control type="button" id="602"><label></label><onclick>PlayerControl(Play)</onclick></control>
      <control type="radiobutton" id="601"><onclick condition="Player.Paused">PlayerControl(Play)</onclick><onclick condition="!Player.Paused">PlayerControl(Rewind)</onclick></control>
      <control type="button" id="708"><onclick>SetProperty(CustomSelect,avsettings,Home)</onclick><onclick>ActivateWindow(1129)</onclick></control>
      <include content="OSDRound"><param name="id" value="604" /><param name="icon" value="glyphs/skipback.png" /><param name="onclick" value="Seek(-10)" /></include>
      <!-- <control type="button" id="999"><onclick>Stop</onclick></control> -->
      <control type="button" id="810"><onclick>Dialog.Close(VideoOSD)</onclick><onclick>ActivateWindow(PVROSDChannels)</onclick><visible>VideoPlayer.Content(livetv)</visible></control>
    </controls></window>` };
    const b = Object.fromEntries(skin.osdButtons(files).map(x => [x.id, x.name + (x.section ? ' / ' + x.section : '')]));
    eq(JSON.stringify(b), JSON.stringify({ 602: 'Play / Pause', 601: 'Rewind', 708: 'A/V settings menu', 810: 'Channel list / Live TV', 604: 'Skip back' }));
  });
  await test('OSD hide: template buttons dropped with include condition="false", XML stays valid', async () => {
    const files = { 'xml/VideoOSD.xml': '<window><controls><include content="OSDRound"><param name="id" value="604" /><param name="icon" value="a.png" /></include><include content="OSDRound"><param name="id" value="605" /></include></controls></window>' };
    const r = skin.applyAll({ ...files }, { ...T0, osdHide: ['604'] }, { dirs: ['xml'], res: [1920, 1080] });
    const x = r.changed['xml/VideoOSD.xml'];
    ok(/<include condition="false" content="OSDRound"><!-- kodicontrol: button hidden --><param name="id" value="604"/.test(x), x);
    ok(/<include content="OSDRound"><param name="id" value="605"/.test(x), '605 touched');
    const again = skin.applyAll({ ...files, ...r.changed }, { ...T0, osdHide: ['604'] }, { dirs: ['xml'], res: [1920, 1080] });
    eq((again.changed['xml/VideoOSD.xml'] || x).split('button hidden').length, 2, 'hidden twice');
  });
  await test('rounded episodes: dimmer and label overlays over rounded art get the same mask', async () => {
    const files = { 'xml/View.xml': `<includes>
      <include name="Thumb"><control type="image"><width>480</width><height>270</height><texture background="true">$INFO[ListItem.Art(thumb)]</texture></control>
        <control type="image"><width>480</width><height>270</height><texture>homewidgets/label_back_landscape.png</texture></control></include>
      <include name="Dimmer"><param name="width" default="268" /><param name="height" default="390" /><definition><control type="image"><width>$PARAM[width]</width><height>$PARAM[height]</height><texture border="20">colors/black.png</texture></control></definition></include>
      <include name="L"><include content="Dimmer"><param name="width">480</param><param name="height">270</param></include></include>
    </includes>` };
    const x = skin.applyAll({ ...files }, { ...T0, posters: true }, { dirs: ['xml'], res: [1920, 1080] }).changed['xml/View.xml'];
    ok(/diffuse="special:\/\/skin\/extras\/kc\/mask_wide.png">homewidgets\/label_back_landscape/.test(x), 'label backing not masked');
    ok(/<param name="kcmask" default="mask.png" \/>/.test(x), 'no default mask param');
    ok(/diffuse="special:\/\/skin\/extras\/kc\/\$PARAM\[kcmask\]">colors\/black.png/.test(x), 'dimmer not masked');
    ok(/<include content="Dimmer"><param name="kcmask">mask_wide.png<\/param>/.test(x), 'call has no wide mask');
    ok(!/border="20"/.test(x), 'masked dimmer kept its border (Kodi slices the mask into a cross)');
  });
  await test('rounded art: bordered textures lose the border so the mask is not sliced into a cross', async () => {
    const files = { 'xml/Wall.xml': `<includes><include name="W">
      <control type="image"><width>268</width><height>390</height><texture border="8" background="true">$VAR[PosterThumb]</texture></control>
      <control type="image"><width>268</width><height>390</height><texture border="6" infill="false" colordiffuse="FFFFFFFF">colors/white.png</texture></control>
    </include></includes>` };
    const x = skin.applyAll({ ...files }, { ...T0, posters: true }, { dirs: ['xml'], res: [1920, 1080] }).changed['xml/Wall.xml'];
    ok(/<texture background="true" diffuse="special:\/\/skin\/extras\/kc\/mask.png">\$VAR\[PosterThumb\]/.test(x), 'poster not masked without border');
    ok(/<texture border="6" infill="false" colordiffuse="FFFFFFFF">colors\/white.png/.test(x), 'focus frame was changed');
  });
  await test('artwork across the top: stops at the poster row and adds a fade + solid band', async () => {
    const files = { 'xml/Bg.xml': '<includes><include name="B"><control type="multiimage"><right>-120</right><width>1280</width><height>720</height><imagepath background="true" diffuse="views/myflix/fanart_diffuse.png">$INFO[ListItem.Art(fanart)]</imagepath><visible>Control.IsVisible(509)</visible></control></include></includes>',
      'xml/View.xml': '<includes><include name="V"><control type="wraplist" id="509"><include>Content</include></control></include><include name="Content"><top>530</top><width>1920</width></include></includes>' };
    const x = skin.applyAll({ ...files }, { ...T0, fullArt: true, fullArtMode: 'top', fullArtColor: 'FF101010' }, { dirs: ['xml'], res: [1920, 1080] }).changed['xml/Bg.xml'];
    ok(/<width>1920<\/width><height>530<\/height>/.test(x), 'art not stopped at 530');
    ok(!/fanart_diffuse/.test(x), 'side fade kept');
    ok(/<top>530<\/top><width>1920<\/width><height>550<\/height><texture colordiffuse="FF101010">special:\/\/skin\/extras\/kc\/white.png/.test(x), 'no solid band');
    ok(/fade_v.png/.test(x), 'no fade');
  });
  await test('OSD move: source skin settings fixed in, settings the OSD switches stay live and get seeded', async () => {
    const other = { 'xml/VideoOSD.xml': `<window><controls>
      <control type="group"><visible>String.IsEqual(Skin.String(OSDStyle),0)</visible><control type="button" id="700"><onclick>Skin.SetString(OSDStyle,1)</onclick></control></control>
      <control type="group"><visible>Skin.HasSetting(ShowClock)</visible></control></controls></window>`,
      'xml/Home.xml': '<window><onload condition="String.IsEmpty(Skin.String(OSDStyle))">Skin.SetString(OSDStyle,0)</onload></window>' };
    const r = skin.applyAll({ 'xml/Home.xml': '<window/>' }, { ...T0, osdFrom: 'skin.x' }, { dirs: ['xml'], res: [1920, 1080], otherSkin: other, otherExtra: { colors: '', strings: '', media: [], settings: '<settings><setting id="ShowClock" type="bool">true</setting></settings>' } });
    const x = r.changed['xml/VideoOSD.xml'];
    ok(/String\.IsEqual\(Skin\.String\(OSDStyle\),0\)/.test(x), 'live setting frozen');
    ok(/<onload condition="String.IsEmpty\(Skin.String\(OSDStyle\)\)">Skin.SetString\(OSDStyle,0\)<\/onload>/.test(x), 'not seeded');
    ok(/<visible>true<\/visible>/.test(x), 'ShowClock not fixed to the source value');
  });
  await test('xbt: LZO1X frames decode (literal run + back reference)', async () => {
    const xbt = require('../app/xbt');
    // "abcabcabc": 3 literals, then a match of 6 at distance 3, then end of stream
    const src = Buffer.from([17 + 3, 0x61, 0x62, 0x63, 0x20 | 4, (2 << 2) & 0xff, 0x00, 0x11, 0x00, 0x00]);
    eq(xbt.lzo1x(src, 9).toString(), 'abcabcabc');
  });

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
