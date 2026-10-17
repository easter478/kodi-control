// Skin XML transforms. Every apply starts from the pristine copy of the skin's XML
// folders, so tweaks never stack and "Revert" is just restoring that copy.
// Skins differ a lot, so the generic tweaks are heuristics: each one reports what it touched.
const MASK = 'special://skin/extras/kc/mask.png';
const WHITE = 'special://skin/extras/kc/white.png';
const EMPTY_NOTE = '<!-- emptied by Kodi Control -->';

const base = f => f.split('/').pop();
const dirOf = f => f.split('/').slice(0, -1).join('/');
const isXml = f => /\.xml$/i.test(f);
const isColors = f => /(^|\/)colors\/[^/]+\.xml$/i.test(f);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cleanId = s => String(s || '').replace(/[^\w.\-]/g, '');
const cleanLabel = s => String(s || '').replace(/[(),&<>\[\]$]/g, '').trim();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function emptyWindow(xml) {
  const m = /<window\b[^>]*>/i.exec(xml || '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${EMPTY_NOTE}\n${m ? m[0] : '<window>'}\n\t<controls></controls>\n</window>\n`;
}

// time/delay on <animation>/<effect> tags plus list <scrolltime>. factor 0 = instant.
function scaleAnims(xml, factor) {
  let n = 0;
  xml = xml.replace(/<(animation|effect)\b[^>]*>/gi, tag => tag.replace(/\b(time|delay)(\s*=\s*)"(\d+(?:\.\d+)?)"/gi, (m, a, eq, v) => {
    n++;
    const nv = factor === 0 ? (a.toLowerCase() === 'time' ? 1 : 0) : Math.max(1, Math.round(+v * factor));
    return `${a}${eq}"${nv}"`;
  }));
  xml = xml.replace(/(<scrolltime\b[^>]*>)\s*(\d+)\s*(<\/scrolltime>)/gi, (m, a, v, b) => {
    n++;
    return a + (factor === 0 ? 0 : Math.round(+v * factor)) + b;
  });
  return { xml, n };
}

function animInventory(files) {
  const rows = [];
  for (const [k, buf] of Object.entries(files)) {
    if (!isXml(k)) continue;
    const x = buf.toString('utf8');
    const re = /<animation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/animation>)/gi;
    let m, line = 1, last = 0;
    while ((m = re.exec(x))) {
      for (let i = last; i < m.index; i++) if (x.charCodeAt(i) === 10) line++;
      last = m.index;
      const attrs = m[1], inner = m[2] || '';
      const attr = n => (new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs) || [])[1];
      const trigger = attr('type') || (inner.includes('<') ? '?' : inner.trim()) || '?';
      const effects = attr('effect') ? [attr('effect')] : [...inner.matchAll(/<effect\b[^>]*\btype\s*=\s*"([^"]+)"/gi)].map(e => e[1]);
      const times = [...m[0].matchAll(/\b(?:time|delay)\s*=\s*"(\d+)"/gi)].map(e => +e[1]);
      const before = x.slice(Math.max(0, m.index - 4000), m.index);
      const ctl = [...before.matchAll(/<control\b([^>]*)>/gi)].pop();
      const desc = [...before.matchAll(/<description>([^<]*)<\/description>/gi)].pop();
      let where = '';
      if (ctl) {
        const t = (/type\s*=\s*"([^"]+)"/i.exec(ctl[1]) || [])[1] || 'control';
        const id = (/id\s*=\s*"([^"]+)"/i.exec(ctl[1]) || [])[1];
        where = t + (id ? ' #' + id : '');
      }
      if (desc && (!ctl || desc.index > ctl.index)) where += (where ? ' · ' : '') + desc[1].trim();
      rows.push({ file: base(k), dir: dirOf(k), line, trigger, effects: effects.join(', '), time: times.length ? Math.max(...times) : 0, where: where || 'window' });
    }
  }
  return rows;
}

const TOP = /top.?bar|header.?bar|top.?panel|top.?info|top.?header|topmenu/i;
function hideTopbar(x) {
  let n = 0;
  const note = name => { n++; return `<!-- kodicontrol: top bar include "${String(name).replace(/-{2,}/g, '-')}" hidden -->`; };
  x = x.replace(/<include(\s+condition="[^"]*")?\s*>\s*([\w.\-]+)\s*<\/include>/gi, (m, c, name) => TOP.test(name) ? note(name) : m);
  x = x.replace(/<include\s+content="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/include>)/gi, (m, name, inner) =>
    TOP.test(name) && !/<include\b/i.test(inner || '') ? note(name) : m);
  x = x.replace(/(<control\s+type="group"[^>]*>\s*<description>([^<]*)<\/description>)/gi, (m, head, d) => {
    if (!TOP.test(d)) return m;
    n++;
    return head + '<visible>false</visible>';
  });
  return { xml: x, n };
}

const BAR_TEX = /(menu|bar|nav|home).*?(back|bg|panel|fill|fade)|ribbon|panel|homebar|menubar|bar_?bg|[_\-/]bar\.png/i;
function homebarTransparent(x) {
  let n = 0;
  x = x.replace(/<control\s+type="image"[^>]*>[\s\S]*?<\/control>/gi, block => {
    const tex = (/<texture\b[^>]*>([^<]*)<\/texture>/i.exec(block) || [])[1] || '';
    if (!tex || /\$INFO|\$VAR|\$PARAM|ListItem|Art\(/i.test(tex) || !BAR_TEX.test(tex)) return block;
    n++;
    if (/<colordiffuse>/i.test(block)) return block.replace(/<colordiffuse>[^<]*<\/colordiffuse>/i, '<colordiffuse>00FFFFFF</colordiffuse>');
    return block.replace(/<\/control>\s*$/i, '<colordiffuse>00FFFFFF</colordiffuse></control>');
  });
  return { xml: x, n };
}

// Full-screen artwork: background fanart that a view draws on one side through a fade mask (Aeon Nox MyFlix:
// right -120, 1280x720, diffuse="views/myflix/fanart_diffuse.png") is made full screen with no mask.
const BG_ART = /\$VAR\[[^\]]*(?:background|fanart)[^\]]*\]|Art\((?:fanart|tvshow\.fanart|landscape)\)/i;
// opts.mode 'top': the art fills the width above the view's poster row and fades into a solid band behind
// the posters (opts.color), so the row sits on one surface instead of over a cut-off picture.
// opts.tops: {containerId: top} for the views, read once from all files (containerTops).
function fullArt(x, W, H, opts = {}) {
  let n = 0;
  x = x.replace(/<control\s+type="(image|multiimage)"[^>]*>[\s\S]*?<\/control>/gi, block => {
    const tex = /<(texture|imagepath)\b([^>]*)>([^<]*)<\//i.exec(block);
    if (!tex || !BG_ART.test(tex[3])) return block;
    const d = (/\bdiffuse\s*=\s*"([^"]*)"/i.exec(' ' + tex[2]) || [])[1] || '';
    const masked = /fade|gradient|diffuse|myflix|mask/i.test(d) && !/extras\/kc\//.test(d);
    if (!masked) return block; // framed fanart previews (info panels) are meant to stay small
    n++;
    const vis = (block.match(/<visible\b[^>]*>[^<]*<\/visible>/gi) || []).join('');
    let artH = H;
    if (opts.mode === 'top') {
      const ids = [...vis.matchAll(/Control\.IsVisible\((\d+)\)/gi)].map(m => m[1]);
      const top = ids.map(i => (opts.tops || {})[i]).find(v => v > 0);
      artH = Math.round(Math.min(H * 0.75, Math.max(H * 0.35, top || H * 0.55)));
    }
    let out = block.replace(new RegExp(`(<${tex[1]}\\b[^>]*?)\\s+diffuse\\s*=\\s*"[^"]*"`, 'i'), '$1')
      .replace(/<(left|right|top|bottom|width|height|centerleft|centertop|centerright|centerbottom)>[^<]*<\/\1>\s*/gi, '')
      .replace(/(<control\b[^>]*>)/i, `$1<left>0</left><top>0</top><width>${W}</width><height>${artH}</height>`);
    if (opts.mode !== 'top') return out;
    // keep the picture's top (faces, titles) when it is cropped to the shorter band
    out = /<aspectratio\b/i.test(out) ? out.replace(/<aspectratio\b[^>]*>[^<]*<\/aspectratio>/i, '<aspectratio aligny="top">scale</aspectratio>') : out.replace(/(<control\b[^>]*>)/i, '$1<aspectratio aligny="top">scale</aspectratio>');
    const col = /^[0-9a-f]{8}$/i.test(opts.color || '') ? opts.color : 'FF0B0B0F';
    const fadeH = Math.round(H * 0.2);
    const img = (top, h, file) => `<control type="image"><!-- kodicontrol: fullart band --><left>0</left><top>${top}</top><width>${W}</width><height>${h}</height><texture colordiffuse="${col}">special://skin/extras/kc/${file}</texture>${vis}</control>`;
    return out + img(artH - fadeH, fadeH, 'fade_v.png') + img(artH, H - artH, 'white.png');
  });
  return { xml: x, n };
}
// top of each list / panel container by id, following <include> content for the ones that keep it there
function containerTops(files) {
  const all = Object.values(files).map(String).join('\n');
  const defs = {};
  for (const m of all.matchAll(/<include\s+name="([^"]+)"[^>]*>/gi)) {
    const end = balancedEnd(all, m.index, 'include');
    if (end > 0) defs[m[1]] = all.slice(m.index, end);
  }
  const topOf = (body, depth = 0) => {
    const own = /^[\s\S]*?<\/?control/.exec(body.replace(/^<[^>]*>/, ''));
    const head = own ? own[0] : body;
    const t = /<top>\s*(\d+(?:\.\d+)?)\s*<\/top>/i.exec(head);
    if (t) return +t[1];
    if (depth > 3) return 0;
    for (const m of head.matchAll(/<include(?:\s+content="([^"]+)"[^>]*>|[^>]*>([^<]+)<\/include>)/gi)) { const d = defs[(m[1] || m[2]).trim()]; if (d) { const v = topOf(d, depth + 1); if (v) return v; } }
    return 0;
  };
  const tops = {};
  for (const m of all.matchAll(/<control\s+type="(?:panel|list|fixedlist|wraplist)"\s+id="(\d+)"[^>]*>/gi)) {
    if (tops[m[1]]) continue;
    const end = balancedEnd(all, m.index, 'control');
    const v = end > 0 ? topOf(all.slice(m.index, end)) : 0;
    if (v) tops[m[1]] = v;
  }
  return tops;
}

// Rounded artwork: posters and also episode / landscape thumbnails (Aeon Nox draws episodes via $VAR[NoSpoilerIconVar]).
// The mask follows the image control's shape so 16:9 thumbs don't get stretched 2:3 corners.
const MASK_WIDE = 'special://skin/extras/kc/mask_wide.png';
const ART_TEX = /poster|\$VAR\[[^\]]*(?:thumb|icon|landscape|fanart)[^\]]*\]|ListItem(?:Absolute|NoWrap)?(?:\(-?\d+\))?\.(?:Art\((?:thumb|landscape|fanart|tvshow\.landscape|tvshow\.fanart|season\.landscape)\)|(?:Thumb|Icon)\b)|Player\.Art\((?:thumb|landscape)\)/i;
const NOT_ART = /logo|clearart|discart|cdart|flag|banner|studio|rating|resource:\/\/|characterart|keyart|\.png\b/i;
function roundPosters(x) {
  let n = 0, wide = 0;
  x = x.replace(/<control\s+type="image"[^>]*>[\s\S]*?<\/control>/gi, block => block.replace(/<texture\b([^>]*)>([^<]*)<\/texture>/i, (m, attrs, body) => {
    if (!ART_TEX.test(body) || NOT_ART.test(body)) return m;
    const w = +(/<width>\s*(\d+)\s*<\/width>/i.exec(block) || [])[1], h = +(/<height>\s*(\d+)\s*<\/height>/i.exec(block) || [])[1];
    const isWide = w && h ? w / h > 1.15 : !/poster/i.test(body);
    if (w && h && w / h >= 0.85 && w / h <= 1.15 && !/poster/i.test(body)) return m; // square: add-on / menu icons
    isWide ? wide++ : n++;
    attrs = attrs.replace(/\s+diffuse\s*=\s*"[^"]*"/i, ''); // \s+ so colordiffuse="..." is left alone
    // Kodi cuts a bordered texture into 9 slices and cuts the diffuse mask the same way, which draws a cross
    // through the picture; on artwork the border only keeps edge pixels unstretched, so drop it
    attrs = attrs.replace(/\s+border\s*=\s*"[^"]*"/i, '');
    return `<texture${attrs} diffuse="${isWide ? MASK_WIDE : MASK}">${body}</texture>`;
  }));
  return { xml: x, n: n + wide, wide };
}
// Squares drawn over rounded art: the dimmer on unfocused items and label backings (Aeon Nox's FlixDimmer
// and label_back_landscape on MyFlix episodes) keep sharp corners and make the thumbnails look unrounded.
// sizes: "w×h" of the art rounded above. Direct images of that size get the same mask; include templates
// sized by $PARAM[width]/$PARAM[height] get a kcmask param, set per call from the call's own size.
const OVERLAY_TEX = /dimmer|dim[_.]|label_?back|overlay|colors?\/(black|white)|black\.png|white\.png|shade|glass|highlight|select(ed)?_?(back|box)|focus_?(back|box)/i;
function roundOverlays(x, sizes) {
  let n = 0;
  const wideOf = (w, h) => w / h > 1.15;
  const sizeHit = (w, h) => sizes.has(`${w}x${h}`) || [...sizes].some(s => { const [a, b] = s.split('x').map(Number); return Math.abs(a - w) <= 2 && Math.abs(b - h) <= 2; });
  x = x.replace(/<control\s+type="image"[^>]*>[\s\S]*?<\/control>/gi, block => {
    const tex = /<texture\b([^>]*)>([^<]*)<\/texture>/i.exec(block);
    if (!tex || /\bdiffuse\s*=/i.test(' ' + tex[1].replace(/colordiffuse\s*=\s*"[^"]*"/gi, '')) || !OVERLAY_TEX.test(tex[2]) || ART_TEX.test(tex[2])) return block;
    // a bordered texture slices its mask into a cross: frames (infill="false") stay unmasked, fills lose the border
    if (/\sborder\s*=/i.test(tex[1]) && /infill\s*=\s*"false"/i.test(tex[1])) return block;
    tex[1] = tex[1].replace(/\s+border\s*=\s*"[^"]*"/i, '');
    const w = +(/<width>\s*(\d+)\s*<\/width>/i.exec(block) || [])[1], h = +(/<height>\s*(\d+)\s*<\/height>/i.exec(block) || [])[1];
    if (w && h) {
      if (!sizeHit(w, h)) return block;
      n++;
      return block.replace(tex[0], `<texture${tex[1]} diffuse="${wideOf(w, h) ? MASK_WIDE : MASK}">${tex[2]}</texture>`);
    }
    if (/\$PARAM\[width\]/i.test(block) && /\$PARAM\[height\]/i.test(block)) {
      n++;
      return block.replace(tex[0], `<texture${tex[1]} diffuse="special://skin/extras/kc/$PARAM[kcmask]">${tex[2]}</texture>`);
    }
    return block;
  });
  // give each templated overlay definition a kcmask default, and each call the mask that fits its size
  const templ = new Set();
  x = x.replace(/<include\s+name="([^"]+)"[^>]*>[\s\S]*?<\/include>/gi, def => {
    if (!/\$PARAM\[kcmask\]/.test(def) || /name="kcmask"/.test(def)) return def;
    const name = /name="([^"]+)"/.exec(def)[1];
    const dw = +(/<param\s+name="width"\s+default="(\d+)"/i.exec(def) || [])[1], dh = +(/<param\s+name="height"\s+default="(\d+)"/i.exec(def) || [])[1];
    const mask = dw && dh && wideOf(dw, dh) ? 'mask_wide.png' : 'mask.png';
    templ.add(name);
    return /<definition>/i.test(def) ? def.replace(/<definition>/i, `<param name="kcmask" default="${mask}" />\n\t\t<definition>`)
      : def.replace(/(<include\s+name="[^"]+"[^>]*>)([\s\S]*)<\/include>$/i, `$1<param name="kcmask" default="${mask}" /><definition>$2</definition></include>`);
  });
  return { xml: x, n, templ };
}
function maskCalls(x, templ) {
  let n = 0;
  x = x.replace(/<include\s+content="([^"]+)"[^>]*>[\s\S]*?<\/include>/gi, call => {
    const name = /content="([^"]+)"/.exec(call)[1];
    if (!templ.has(name) || /name="kcmask"/.test(call)) return call;
    const p = callParams(call), w = +p.width, h = +p.height;
    if (!w || !h) return call;
    n++;
    return call.replace(/(<include\s+content="[^"]+"[^>]*>)/i, `$1<param name="kcmask">${w / h > 1.15 ? 'mask_wide.png' : 'mask.png'}</param>`);
  });
  return { xml: x, n };
}

// Transplant another skin's video OSD into this one: VideoOSD, DialogSeekBar and the OSD's own custom windows,
// plus every include / variable / expression / constant they use, the fonts, colours and skin strings they need, and
// the loose textures (copied under media/kc_osd/). Same-named definitions that differ are renamed KC_<name>.
// extra = { colors: source colors/defaults.xml, strings: source en_gb strings.po, media: [paths under media/] }
const KC_TEX = 'kc_osd/';
// Skin settings belong to the skin that owns them: once the OSD runs inside another skin, Skin.String(X) and
// Skin.HasSetting(X) read the target's settings and are empty (Nimbus shows its OSD only when
// Skin.String(OSDStyleSetting) is 0 or 1). So the source's own values are fixed into the moved XML.
// Values: the source skin's settings.xml on the box (settingsXml), else defaults its XML sets when empty.
function sourceSkinSettings(srcFiles, settingsXml = '') {
  const s = { str: {}, bool: {} };
  const all = Object.values(srcFiles).join('\n');
  for (const m of all.matchAll(/<onload\b[^>]*condition="[^"]*String\.IsEmpty\(Skin\.String\(([^)]+)\)\)[^"]*"[^>]*>\s*Skin\.SetString\(\s*\1\s*,\s*([^)]*?)\s*\)\s*<\/onload>/gi)) s.str[m[1].toLowerCase()] ??= m[2];
  for (const m of all.matchAll(/<onload\b[^>]*condition="[^"]*!Skin\.HasSetting\(([^)]+)\)[^"]*"[^>]*>\s*Skin\.SetBool\(\s*\1\s*\)\s*<\/onload>/gi)) s.bool[m[1].toLowerCase()] ??= true;
  for (const m of String(settingsXml || '').matchAll(/<setting\s+id="([^"]+)"\s+type="(bool|string)"[^>]*?(?:\/>|>([^<]*)<\/setting>)/gi)) {
    const id = m[1].toLowerCase(), v = (m[3] || '').replace(/&amp;/g, '&');
    if (m[2] === 'bool') s.bool[id] = v === 'true'; else s.str[id] = v;
  }
  return s;
}
function freezeSkinSettings(x, s) {
  if (!s) return x;
  const str = id => s.str[id.toLowerCase()] ?? '';
  const live = id => s.live && s.live.has(id.trim().toLowerCase());
  // only inside conditions (visible, condition="", enable, selected, usealttexture …); labels keep $INFO as is
  const fix = c => c
    .replace(/String\.IsEqual\(\s*Skin\.String\(([^)]+)\)\s*,\s*([^)]*?)\s*\)/gi, (m, id, v) => live(id) ? m : (str(id).toLowerCase() === v.toLowerCase() ? 'true' : 'false'))
    .replace(/String\.Contains\(\s*Skin\.String\(([^)]+)\)\s*,\s*([^)]*?)\s*\)/gi, (m, id, v) => live(id) ? m : (str(id).toLowerCase().includes(v.toLowerCase()) ? 'true' : 'false'))
    .replace(/String\.IsEmpty\(\s*Skin\.String\(([^)]+)\)\s*\)/gi, (m, id) => live(id) ? m : (str(id) ? 'false' : 'true'))
    .replace(/Skin\.HasSetting\(([^)]+)\)/gi, (m, id) => live(id) ? m : (s.bool[id.trim().toLowerCase()] ? 'true' : 'false'));
  return x.replace(/(<(visible|enable|selected|usealttexture|animation|onclick|onfocus|onload|onunload|onup|ondown|onleft|onright|onback|include|value|param|item|expression|onunfocus)\b[^>]*\bcondition=")([^"]*)"/gi, (m, pre, t, c) => pre + fix(c) + '"')
    .replace(/(<(visible|enable|selected|usealttexture|expression)\b[^>]*>)([^<]*)(<\/\2>)/gi, (m, o, t, c, e) => o + fix(c) + e);
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function importOsd(out, dirs, other, extra = {}) {
  const str = v => (typeof v === 'string' ? v : v.toString('utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const srcFiles = Object.fromEntries(Object.entries(other).filter(([k]) => isXml(k)).map(([k, v]) => [k, str(v)]));
  const osdKey = Object.keys(srcFiles).find(k => /^VideoOSD\.xml$/i.test(base(k)));
  if (!osdKey) return { ok: false, text: 'Source skin has no VideoOSD.xml', assets: [] };
  const srcDir = dirOf(osdKey);
  const inSrc = k => dirOf(k) === srcDir;
  const TAGS = ['include', 'variable', 'expression', 'constant'];
  const defs = files => {
    const map = Object.fromEntries(TAGS.map(t => [t, {}]));
    for (const [k, v] of Object.entries(files)) {
      if (!isXml(k) || isColors(k)) continue;
      for (const t of TAGS) for (const m of v.matchAll(new RegExp(`<${t}\\s+name="([^"]+)"[^>]*?(/?)>`, 'gi'))) {
        if (map[t][m[1]]) continue;
        // includes nest <include>x</include> references, so find the matching close tag
        const end = m[2] ? m.index + m[0].length : balancedEnd(v, m.index, t);
        if (end > 0) map[t][m[1]] = v.slice(m.index, end);
      }
    }
    return map;
  };
  const src = defs(Object.fromEntries(Object.entries(srcFiles).filter(([k]) => inSrc(k))));
  const tgt = defs(out);
  const skinSet = sourceSkinSettings(srcFiles, extra.settings);
  skinSet.live = new Set(); skinSet.seed = [];
  const rx = n => new RegExp(`(^|[^\\w.])${reEsc(n)}(?![\\w.])`, 'g');

  // windows: VideoOSD, DialogSeekBar, then the custom windows the OSD opens (renumbered if the target uses the id)
  const tgtCustom = new Set(Object.keys(out).map(k => (/^custom_(\d+)_/i.exec(base(k)) || [])[1]).filter(Boolean));
  const wins = { 'VideoOSD.xml': srcFiles[osdKey] };
  const sb = Object.keys(srcFiles).find(k => inSrc(k) && /^DialogSeekBar\.xml$/i.test(base(k)));
  if (sb) wins['DialogSeekBar.xml'] = srcFiles[sb];
  const WIN_REF = /(?:ActivateWindow|ReplaceWindow|Dialog\.Close|Window\.Is\w*|Window)\((\d{4})\b/gi;
  const idMap = {}, usedIds = new Set();
  let free = 1199;
  const need = Object.fromEntries(TAGS.map(t => [t, new Set()]));
  const missing = new Set();
  const add = (t, n) => {
    if (need[t].has(n)) return;
    if (/\$PARAM\[/.test(n)) {
      // a name built from params (Bald_OSDSlot_$PARAM[play]_Play): bring every source definition it can resolve to
      const re = new RegExp('^' + n.split(/\$PARAM\[[^\]]*\]/).map(reEsc).join('[\\w.\\-]*') + '$');
      const hits = Object.keys(src[t]).filter(k => re.test(k));
      if (!hits.length) missing.add(n);
      for (const h of hits) add(t, h);
      return;
    }
    if (!src[t][n]) { if (!tgt[t][n] && t !== 'constant') missing.add(n); return; }
    need[t].add(n);
    scan(src[t][n]);
  };
  function scan(txt) {
    for (const m of txt.matchAll(/<include(?:\s+condition="[^"]*")?\s*>\s*([\w.\-]+)\s*<\/include>|<include\s+content="([^"]+)"/gi)) add('include', m[1] || m[2]);
    for (const m of txt.matchAll(/\$(?:ESC)?VAR\[([^\],]+)/g)) add('variable', m[1].trim()); // $VAR[name,prefix,postfix]
    for (const m of txt.matchAll(/\$EXP\[([^\]]+)\]/g)) add('expression', m[1]);
    for (const n of Object.keys(src.constant)) if (!need.constant.has(n) && new RegExp(`(^|[^\\w.])${reEsc(n)}(?![\\w.])`).test(txt)) add('constant', n);
    for (const m of txt.matchAll(WIN_REF)) {
      const id = m[1];
      if (+id < 1100 || +id > 1199 || usedIds.has(id)) continue;
      const ck = Object.keys(srcFiles).find(k => inSrc(k) && new RegExp(`^custom_${id}_`, 'i').test(base(k)));
      if (!ck) continue;
      usedIds.add(id);
      let nid = id;
      if (tgtCustom.has(id)) {
        while (tgtCustom.has(String(free)) || usedIds.has(String(free))) free--;
        nid = String(free--);
        idMap[id] = nid;
      }
      wins[base(ck).replace(new RegExp(`^custom_${id}_`, 'i'), `Custom_${nid}_`)] = srcFiles[ck];
      scan(srcFiles[ck]);
    }
  }
  for (const w of Object.values(wins)) scan(w);

  // same name in the target: identical → use the target's; different → bring the source's as KC_<name>
  const ren = Object.fromEntries(TAGS.map(t => [t, {}]));
  for (const t of TAGS) for (const n of [...need[t]]) {
    if (!tgt[t][n]) continue;
    if (str(tgt[t][n]).replace(/\s+/g, '') === src[t][n].replace(/\s+/g, '')) need[t].delete(n);
    else ren[t][n] = 'KC_' + n;
  }

  // fonts, colours, skin strings, loose textures
  const srcFonts = {};
  const fontKey = Object.keys(srcFiles).find(k => inSrc(k) && /^Font\.xml$/i.test(base(k)));
  if (fontKey) {
    const set = (/<fontset\b[^>]*>([\s\S]*?)<\/fontset>/i.exec(srcFiles[fontKey]) || [])[1] || '';
    for (const m of set.matchAll(/<font>\s*<name>([^<]+)<\/name>[\s\S]*?<\/font>/gi)) srcFonts[m[1].trim()] = srcFonts[m[1].trim()] || m[0];
  }
  const tgtFontKeys = Object.keys(out).filter(k => dirs.includes(dirOf(k)) && /^Font\.xml$/i.test(base(k)));
  const tgtFontNames = new Set(tgtFontKeys.flatMap(k => [...out[k].matchAll(/<name>([^<]+)<\/name>/gi)].map(m => m[1].trim())));
  const srcColors = Object.fromEntries([...(extra.colors || '').matchAll(/<color\s+name="([^"]+)"\s*>([^<]+)<\/color>/gi)].map(m => [m[1], m[2].trim()]));
  const tgtColorKey = Object.keys(out).find(k => /(^|\/)colors\/defaults\.xml$/i.test(k));
  const tgtColors = new Set(tgtColorKey ? [...out[tgtColorKey].matchAll(/<color\s+name="([^"]+)"/gi)].map(m => m[1]) : []);
  const strings = {};
  for (const m of (extra.strings || '').matchAll(/msgctxt\s+"#(\d+)"\s*\r?\n\s*msgid\s+"((?:[^"\\]|\\.)*)"/g)) strings[m[1]] = m[2].replace(/\\"/g, '"');
  const media = [...new Set((extra.media || []).map(x => x.replace(/^\.?\/?media\//, '')))];

  const all = [...Object.values(wins), ...TAGS.flatMap(t => [...need[t]].map(n => src[t][n]))].join('\n');
  // settings the moved OSD writes itself (style toggles, panel switches): keep them live, seeded on open
  for (const m of all.matchAll(/Skin\.(SetString|SetBool|ToggleSetting|Reset)\(\s*([^,)]+)/gi)) {
    const id = m[2].trim(), k = id.toLowerCase();
    if (skinSet.live.has(k)) continue;
    skinSet.live.add(k);
    if (/string|reset/i.test(m[1]) && skinSet.str[k]) skinSet.seed.push(`\n\t<onload condition="String.IsEmpty(Skin.String(${id}))">Skin.SetString(${id},${skinSet.str[k]})</onload>`);
    else if (/bool|toggle/i.test(m[1]) && skinSet.bool[k]) skinSet.seed.push(`\n\t<onload condition="String.IsEmpty(Skin.String(kc.seeded.${id}))">Skin.SetBool(${id})</onload><onload>Skin.SetString(kc.seeded.${id},1)</onload>`);
  }
  const fonts = Object.keys(srcFonts).filter(n => !tgtFontNames.has(n) && rx(n).test(all));
  const colors = Object.keys(srcColors).filter(n => !tgtColors.has(n) && n.length > 2 && rx(n).test(all));
  const texRe = m => new RegExp(`(^|[^\\w/.-])${reEsc(m)}(?![\\w/.-])`, 'gi');
  // texture paths the OSD names: loose files under media/ are copied, ones packed in Textures.xbt are unpacked
  const loose = new Set(media.map(m => m.toLowerCase()));
  const packed = extra.xbt || new Set();
  const refs = [...new Set([...all.matchAll(/(?:^|[>"',\s])([\w\-][\w\-\/ .]*\.(?:png|jpe?g|gif|webp))(?=[<"',\s]|$)/gim)].map(m => m[1]))]
    .filter(r => !/^special:|\$/i.test(r));
  const tex = refs.filter(r => loose.has(r.toLowerCase()) || packed.has(r.toLowerCase()));

  const scripts = new Set();
  const fix = x => {
    for (const [n, k] of Object.entries(ren.include)) {
      x = x.replace(new RegExp(`(<include(?:\\s+condition="[^"]*")?\\s*>\\s*)${reEsc(n)}(\\s*<\\/include>)`, 'g'), `$1${k}$2`)
        .replace(new RegExp(`((?:content|<include\\s+name)=")${reEsc(n)}"`, 'g'), `$1${k}"`);
    }
    for (const [n, k] of Object.entries(ren.variable)) x = x.replace(new RegExp(`(\\$(?:ESC)?VAR\\[)${reEsc(n)}(?=[\\],])`, 'g'), `$1${k}`).replace(new RegExp(`(<variable\\s+name=")${reEsc(n)}"`, 'g'), `$1${k}"`);
    for (const [n, k] of Object.entries(ren.expression)) x = x.replace(new RegExp(`(\\$EXP\\[)${reEsc(n)}\\]`, 'g'), `$1${k}]`).replace(new RegExp(`(<expression\\s+name=")${reEsc(n)}"`, 'g'), `$1${k}"`);
    for (const [n, k] of Object.entries(ren.constant)) x = x.replace(rx(n), (m, pre) => pre + k);
    for (const [id, nid] of Object.entries(idMap)) {
      x = x.replace(new RegExp(`((?:ActivateWindow|ReplaceWindow|Dialog\\.Close|Window\\.Is\\w*|Window)\\()${id}\\b`, 'gi'), `$1${nid}`)
        .replace(new RegExp(`(<window\\b[^>]*\\bid=")${id}"`, 'i'), `$1${nid}"`)
        // window ids handed to includes (Bald's <param name="owner">1120</param>) and window arguments of
        // SetProperty(k,v,1120) / ClearProperty(k,1120): left alone they point at the target's own window
        .replace(new RegExp(`(<param\\s+name="[^"]*"(?:\\s+default="${id}"\\s*/>|\\s*>\\s*${id}\\s*</param>))`, 'gi'), m => m.replace(id, nid))
        .replace(new RegExp(`((?:SetProperty|ClearProperty)\\([^()]*,\\s*)${id}\\)`, 'gi'), `$1${nid})`);
    }
    for (const m of tex) x = x.replace(texRe(m), (q, pre) => pre + KC_TEX + m);
    x = freezeSkinSettings(x, skinSet);
    // the source's own Python scripts (Bald's zoom button runs special://skin/scripts/zoom.py): copy their folder
    x = x.replace(/special:\/\/skin\/(?!media\/|extras\/kc\/|kcsrc\/)([\w.\-\/]+?\.py)\b/gi, (m, p) => { scripts.add(p.includes('/') ? p.replace(/\/[^/]*$/, '') : p); return 'special://skin/kcsrc/' + p; });
    // the source's skin strings (31000-31999) would otherwise show the target's text for the same number
    return x.replace(/\$LOCALIZE\[(3\d{4})\]/g, (m, n) => strings[n] != null ? strings[n] : m)
      .replace(/(<(label|label2|hinttext)>)\s*(3\d{4})\s*(<\/\2>)/gi, (m, o, t, n, c) => strings[n] != null ? o + strings[n] + c : m);
  };

  let hooked = 0;
  const nDefs = TAGS.reduce((n, t) => n + need[t].size, 0);
  for (const d of dirs) {
    for (const [name, x] of Object.entries(wins)) {
      // drop the target's own copy (any case) so Kodi can't pick the old one
      for (const k of Object.keys(out)) if (dirOf(k) === d && base(k).toLowerCase() === name.toLowerCase() && base(k) !== name) delete out[k];
      let w = fix(x);
      // settings the OSD switches itself stay live; they start from the source skin's value
      if (/^VideoOSD\.xml$/i.test(name) && skinSet.seed.length) w = w.replace(/(<window\b[^>]*>)/i, `$1\n\t<!-- kodicontrol: source skin settings -->${skinSet.seed.join('')}`);
      out[`${d}/${name}`] = w;
    }
    if (nDefs) {
      const body = TAGS.flatMap(t => [...need[t]].map(n => fix(src[t][n]))).join('\n');
      out[`${d}/Includes_KodiControlOSD.xml`] = `<?xml version="1.0" encoding="UTF-8"?>\n<includes>\n${body}\n</includes>\n`;
      const incKey = Object.keys(out).find(k => dirOf(k) === d && /^Includes\.xml$/i.test(base(k)));
      if (incKey && !out[incKey].includes('Includes_KodiControlOSD.xml')) {
        out[incKey] = out[incKey].replace(/<includes\b[^>]*>/i, m => `${m}\n\t<include file="Includes_KodiControlOSD.xml"/>`);
        hooked++;
      }
    }
  }
  if (fonts.length) for (const k of tgtFontKeys) out[k] = out[k].replace(/<\/fontset>/gi, fonts.map(n => srcFonts[n]).join('\n') + '\n</fontset>');
  if (colors.length && tgtColorKey) out[tgtColorKey] = out[tgtColorKey].replace(/<\/colors>/i, colors.map(n => `\t<color name="${n}">${srcColors[n]}</color>`).join('\n') + '\n</colors>');
  const fontFiles = [...new Set(fonts.map(n => (/<filename>([^<]+)<\/filename>/i.exec(srcFonts[n]) || [])[1]).filter(Boolean))];
  const assets = [...tex.map(m => loose.has(m.toLowerCase()) ? { from: 'media/' + m, to: 'media/' + KC_TEX + m } : { xbt: m, to: 'media/' + KC_TEX + m }),
    ...fontFiles.map(f => ({ from: 'fonts/' + f, to: 'fonts/' + f })),
    ...[...scripts].map(s => ({ from: s, to: 'kcsrc/' + s, dir: !/\.py$/i.test(s) }))];

  const nRen = TAGS.reduce((n, t) => n + Object.keys(ren[t]).length, 0);
  const parts = [`OSD moved over: ${Object.keys(wins).join(', ')}; ${plural(nDefs, 'definition')}, ${plural(fonts.length, 'font')}, ${plural(colors.length, 'colour')}, ${plural(tex.length, 'texture')}`];
  if (nRen) parts.push(`${nRen} clashing names renamed KC_…`);
  if (Object.keys(idMap).length) parts.push('custom windows renumbered ' + Object.entries(idMap).map(([a, b]) => `${a}→${b}`).join(', '));
  if (nDefs && !hooked) parts.push('could not hook the extra includes into Includes.xml');
  if (missing.size) parts.push(`not found in either skin: ${[...missing].slice(0, 6).join(', ')}${missing.size > 6 ? '…' : ''}`);
  if (!extra.media) parts.push('textures not copied (source media list unavailable)');
  return { ok: !(nDefs && !hooked), text: parts.join('; '), assets };
}

// Index just past the tag that closes the <tag> opened at `from`, counting nested same-name tags.
function balancedEnd(x, from, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
  re.lastIndex = from;
  let depth = 0, m;
  while ((m = re.exec(x))) {
    if (m[1]) depth--; else if (!m[2]) depth++;
    if (depth === 0) return re.lastIndex;
  }
  return -1;
}
const isStatic = tex => tex && !/\$INFO|\$VAR|\$PARAM|\$ESCINFO|ListItem|Art\(|Player\.|Skin\.String/i.test(tex);
const texOf = block => (/<texture\b[^>]*>([^<]*)<\/texture>/i.exec(block) || [])[1] || '';
function setDiffuse(block, c) {
  // a colordiffuse attribute on <texture> beats the control's <colordiffuse> (Aeon Nox: colordiffuse="D9FFFFFF")
  block = block.replace(/(<texture\b[^>]*\bcolordiffuse=")[^"]*"/gi, `$1${c}"`);
  if (/<colordiffuse>/i.test(block)) return block.replace(/<colordiffuse>[^<]*<\/colordiffuse>/i, `<colordiffuse>${c}</colordiffuse>`);
  return block.replace(/<\/control>\s*$/i, `<colordiffuse>${c}</colordiffuse></control>`);
}
const hideBlock = block => block.replace(/(<control\b[^>]*>)/i, '$1<visible>false</visible>');

// Item 1: gradient / shadow / vignette overlays on the home screen.
const GRAD_TEX = /gradient|shadow|fade|overlay|vignette|shade|dim(mer)?[_\-.]/i;
function hbGradients(x) {
  let n = 0;
  x = x.replace(/<control\s+type="image"[^>]*>[\s\S]*?<\/control>/gi, block => {
    const tex = texOf(block);
    if (!isStatic(tex) || !GRAD_TEX.test(tex)) return block;
    n++;
    return setDiffuse(block, '00FFFFFF');
  });
  return { xml: x, n };
}

// Items 2 / 15: window open/close animations (optionally Visible/Hidden too).
function winTrigger(attrs, inner) {
  return (/\btype\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || (inner && !inner.includes('<') ? inner.trim() : '');
}
const ANIM_RE = () => /<animation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/animation>)/gi;
function stripWinAnims(x, vis) {
  const want = vis ? /^(WindowOpen|WindowClose|Visible|Hidden|VisibleChange)$/i : /^(WindowOpen|WindowClose)$/i;
  let n = 0;
  x = x.replace(ANIM_RE(), (m, attrs, inner) => want.test(winTrigger(attrs, inner)) ? (n++, '') : m);
  return { xml: x, n };
}
function winAnimInventory(files) {
  const rows = [];
  for (const [k, buf] of Object.entries(files)) {
    if (!isXml(k) || isColors(k)) continue;
    const x = buf.toString('utf8');
    let open = 0, close = 0, vis = 0;
    for (const m of x.matchAll(ANIM_RE())) {
      const t = winTrigger(m[1], m[2]).toLowerCase();
      if (t === 'windowopen') open++; else if (t === 'windowclose') close++; else if (/^(visible|hidden|visiblechange)$/.test(t)) vis++;
    }
    if (open + close + vis) rows.push({ file: base(k), dir: dirOf(k), open, close, vis, include: /^includes/i.test(base(k)) });
  }
  return rows.sort((a, b) => b.open + b.close - (a.open + a.close));
}

// Item 10: hide plot / ratings / runtime and friends wherever the skin shows them.
const INFO_FIELDS = {
  plot: 'Plot|PlotOutline', rating: 'Rating|UserRating|Votes|RatingAndVotes|StarRating', duration: 'Duration|EndTime|Runtime',
  year: 'Year', genre: 'Genre', mpaa: 'Mpaa', studio: 'Studio', director: 'Director|Writer', cast: 'Cast|CastAndRole',
  tagline: 'Tagline', premiered: 'Premiered|FirstAired|Aired', flags: 'VideoResolution|VideoCodec|AudioCodec|AudioChannels|VideoAspect|HdrType',
};
function hideInfo(x, keys) {
  const alt = keys.map(k => INFO_FIELDS[k]).filter(Boolean).join('|');
  if (!alt) return { xml: x, n: 0 };
  const info = new RegExp(`(?:ListItem|VideoPlayer|MusicPlayer|Container\\(\\d+\\)\\.ListItem(?:Absolute)?(?:\\(-?\\d+\\))?)\\.(?:${alt})\\b`, 'i');
  const flagTex = keys.includes('flags') ? /flags?\//i : null;
  const starTex = keys.includes('rating') ? /stars?\/|rating/i : null;
  let n = 0;
  x = x.replace(/<control\s+type="(label|textbox|fadelabel|image)"[^>]*>[\s\S]*?<\/control>/gi, (block, type) => {
    if (/kodicontrol: info hidden/.test(block)) return block;
    const body = (block.match(/<(label|label2|info|texture)\b[^>]*>[^<]*<\/\1>/gi) || []).join(' ');
    let hit = info.test(body);
    if (!hit && type === 'image') { const tex = texOf(block); hit = (flagTex && flagTex.test(tex)) || (starTex && starTex.test(tex)); }
    if (!hit) return block;
    n++;
    return block.replace(/(<control\b[^>]*>)/i, '$1<!-- kodicontrol: info hidden --><visible>false</visible>');
  });
  return { xml: x, n };
}

// Hide any single item: scan every label/textbox and icon the skin draws, keyed by the info it shows.
// Follows $VAR[...] variables and include <param>s, which is how Aeon Nox and most modern skins build info rows.
const FIELD_RE = /\b(?:ListItem|VideoPlayer|MusicPlayer|Player|Container(?:\([^)]*\))?\.ListItem(?:Absolute|NoWrap|Position)?(?:\(-?\d+\))?)\.([A-Za-z]+)(?:\(([^)]*)\))?/g;
const TEXT_CTL = /<control\s+type="(label|textbox|fadelabel|image|multiimage)"[^>]*>[\s\S]*?<\/control>/gi;
const SKIP_FIELDS = /^(Label|Label2|Icon|Thumb|Art|ActualIcon|Overlay|Property|IsFolder|IsSelected|IsPlaying|IsCollection|IsParentFolder|IsResumable|HasVideoExtras|Path|FileNameAndPath|FolderPath|DBID|DBType|CurrentItem|NumItems|HasFocus|HasNext|HasPrevious|IsStereoscopic|IsRecording|HasTimer|IsPaused|IsPlaying|Paused|Playing|Seeking|ShowInfo|ShowTime|Rewinding|Forwarding|Caching|Volume|Muted|HasAudio|HasVideo|HasMedia|Time|TimeRemaining|Progress|ProgressCache|SeekBar|SeekTime|SeekOffset|Chapter|ChapterCount|ChapterName|Speed)$/;
function varMap(files) {
  const raw = {};
  for (const [k, x] of Object.entries(files)) {
    if (!isXml(k) || isColors(k)) continue;
    for (const m of x.matchAll(/<variable\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/variable>/gi)) raw[m[1]] = (raw[m[1]] || '') + m[2];
  }
  const out = {};
  const resolve = (name, seen = new Set()) => {
    if (out[name]) return out[name];
    if (seen.has(name) || raw[name] == null) return new Set();
    seen.add(name);
    const f = fieldsIn(raw[name], null);
    for (const m of raw[name].matchAll(/\$VAR\[([^\]]+)\]/g)) for (const x of resolve(m[1], seen)) f.add(x);
    return (out[name] = f);
  };
  for (const n of Object.keys(raw)) resolve(n);
  return out;
}
function fieldsIn(text, vars) {
  const f = new Set();
  for (const m of String(text).matchAll(FIELD_RE)) {
    let name = m[1];
    if (/^Art$/i.test(name) && m[2]) name = 'Art(' + m[2].toLowerCase() + ')';
    else if (/^Property$/i.test(name) && m[2]) name = 'Property(' + m[2] + ')';
    else if (SKIP_FIELDS.test(name)) continue;
    f.add(name);
  }
  if (vars) for (const m of String(text).matchAll(/\$VAR\[([^\]]+)\]/g)) for (const x of vars[m[1]] || []) f.add(x);
  return f;
}
// only the parts that decide what is drawn; <visible> conditions are ignored on purpose
const drawn = block => (block.match(/<(label|label2|info|texture|imagepath|fadelabel)\b[^>]*>[\s\S]*?<\/\1>/gi) || []).join(' ').replace(/<visible>[\s\S]*?<\/visible>/gi, '');
const num = (block, tag) => { const m = new RegExp('<' + tag + '>\\s*(\\d+)\\s*</' + tag + '>', 'i').exec(block); return m ? +m[1] : null; };
const staticIcon = block => {
  const tex = texOf(block).trim();
  if (!tex || /\$|^-$/.test(tex)) return '';
  const w = num(block, 'width'), h = num(block, 'height');
  const small = (w != null && w <= 90) && (h == null || h <= 90);
  if (!small && !/(^|\/)(icons?|flags?|studios?|ratings?|stars?|genres?|logos?|indicators?|overlays?)\//i.test(tex)) return '';
  if (/(^|\/)(white|black|dialog|panel|separator|divider|shadow|gradient|bg|background|frame|button|focus|nofocus|scroll)/i.test(tex.split('/').pop())) return '';
  return tex.replace(/\\/g, '/');
};
const INFO_SKIP_FILE = f => isColors(f) || /^(font|Variables?|Defaults|Settings|Custom_\d+_.*Settings|SkinSettings)\.xml$/i.test(base(f));

function infoItems(files) {
  const src = {};
  for (const [k, v] of Object.entries(files)) if (isXml(k)) src[k] = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  const vars = varMap(src);
  const items = new Map();
  const add = (key, kind, label, file) => {
    let it = items.get(key);
    if (!it) items.set(key, it = { key, kind, label, count: 0, files: new Set() });
    it.count++; it.files.add(base(file));
  };
  for (const [k, x] of Object.entries(src)) {
    if (INFO_SKIP_FILE(k)) continue;
    for (const m of x.matchAll(TEXT_CTL)) {
      const block = m[0], type = m[1].toLowerCase();
      const f = fieldsIn(drawn(block), vars);
      if (type === 'image' || type === 'multiimage') {
        for (const n of f) add('i:' + n, 'icon', n, k);
        const st = !f.size && staticIcon(block);
        if (st) add('s:' + st, 'icon', st, k);
      } else for (const n of f) add('t:' + n, 'text', n, k);
    }
    // include calls that pass info in as params (the control inside only says $PARAM[...])
    for (const m of x.matchAll(/<include\s+content="([^"]+)"[^>]*(?<!\/)>((?:(?!<include\b)[\s\S])*?)<\/include>/gi)) {
      const f = fieldsIn(m[2], vars);
      for (const n of f) add('p:' + n, 'text', n + ' (via include ' + m[1] + ')', k);
    }
  }
  return [...items.values()].map(it => ({ ...it, files: [...it.files].slice(0, 6) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}
function hideItems(x, keys, vars) {
  const sel = new Set(keys);
  const has = p => n => sel.has(p + n);
  let n = 0;
  const mark = block => { n++; return block.replace(/(<control\b[^>]*>)/i, '$1<!-- kodicontrol: item hidden --><visible>false</visible>'); };
  x = x.replace(TEXT_CTL, (block, type) => {
    if (/kodicontrol: (item|info) hidden/.test(block)) return block;
    const f = [...fieldsIn(drawn(block), vars)];
    if (/image/i.test(type)) {
      if (f.some(has('i:'))) return mark(block);
      const st = !f.length && staticIcon(block);
      return st && sel.has('s:' + st) ? mark(block) : block;
    }
    return f.some(has('t:')) ? mark(block) : block;
  });
  if (keys.some(k => k.startsWith('p:'))) {
    x = x.replace(/<include\s+content="([^"]+)"[^>]*(?<!\/)>((?:(?!<include\b)[\s\S])*?)<\/include>/gi, (call, name, body) => {
      if (![...fieldsIn(body, vars)].some(has('p:'))) return call;
      n++;
      return '<!-- kodicontrol: item hidden ' + call.replace(/--/g, '- -') + ' -->';
    });
  }
  return { xml: x, n };
}

// Item 16: Apple-style glass. Kodi has no blur, so this is translucency + rounded panels + iOS blue focus.
const GLASS = 'special://skin/extras/kc/glass.png';
function glassColors(x) {
  let n = 0;
  x = x.replace(/(<color\s+name="([^"]+)"[^>]*>)\s*([0-9a-f]{8})\s*(<\/color>)/gi, (m, open, name, v, close) => {
    if (/text|label|font|title/i.test(name)) return m;
    let nv = null;
    if (/focus|highlight|accent|select|primary|main|button_?f/i.test(name)) nv = 'FF0A84FF';
    else if (/bg|back|panel|dialog|dark|black|shade|overlay|fill|window|box|frame|dim/i.test(name)) {
      const a = Math.min(parseInt(v.slice(0, 2), 16), 0xA6);
      nv = a.toString(16).padStart(2, '0').toUpperCase() + v.slice(2).toUpperCase();
    }
    if (!nv || nv === v.toUpperCase()) return m;
    n++;
    return open + nv + close;
  });
  return { xml: x, n };
}
const PANEL_TEX = /dialog|panel|box|frame|window|osd|menu|bar|back|bg|card|tile|plate|list/i;
function glassPanels(x) {
  let n = 0;
  x = x.replace(/<control\s+type="image"[^>]*>[\s\S]*?<\/control>/gi, block => {
    const tex = texOf(block);
    if (!isStatic(tex) || !PANEL_TEX.test(tex) || /\.jpe?g$|backgrounds?\/|fanart|poster|icon|logo|flag|star/i.test(tex) || GRAD_TEX.test(tex)) return block;
    n++;
    block = block.replace(/<texture\b[^>]*>[^<]*<\/texture>/i, `<texture border="28">${GLASS}</texture>`);
    return setDiffuse(block, 'A62C2C2E');
  });
  x = x.replace(/<(texturefocus|texturenofocus|alttexturefocus|alttexturenofocus)\b([^>]*)>([^<]*)<\/\1>/gi, (m, tag, attrs, tex) => {
    if (!isStatic(tex) || !tex.trim() || /icon|logo|flag|star|arrow|check|radio/i.test(tex)) return m;
    n++;
    const tint = /nofocus/i.test(tag) ? '1FFFFFFF' : 'D90A84FF';
    attrs = attrs.replace(/\s*(border|colordiffuse)\s*=\s*"[^"]*"/gi, '');
    return `<${tag}${attrs} border="28" colordiffuse="${tint}">${GLASS}</${tag}>`;
  });
  return { xml: x, n };
}

// ---- OSD (items 3, 4, 9, 14) ----
const OSD_FILE = /^(VideoOSD|DialogSeekBar)\.xml$/i;
const BTN_RE = () => /<control\s+type="(?:radio|toggle)?button"[^>]*>[\s\S]*?<\/control>/gi;
// VideoOSD.xml plus every file holding an include it pulls in (recursively). Aeon Nox keeps
// its OSD buttons in Includes_OSD.xml, so reading VideoOSD.xml alone finds nothing.
function osdFiles(files, withParts = false, rootRe = /^VideoOSD\.xml$/i) {
  const txt = k => files[k].toString('utf8');
  const keys = Object.keys(files).filter(isXml);
  const roots = keys.filter(f => rootRe.test(base(f)));
  if (!roots.length) return [];
  const defs = {};
  for (const k of keys) for (const m of txt(k).matchAll(/<include\s+name="([^"]+)"/gi)) (defs[m[1]] = defs[m[1]] || new Set()).add(k);
  // definition text up to the next definition: good enough to find the includes it uses
  const span = (k, name) => { const x = txt(k), a = x.indexOf('<include name="' + name + '"'); if (a < 0) return null; const b = x.indexOf('<include name=', a + 10); return [a, b < 0 ? x.length : b]; };
  const body = (k, name) => { const r = span(k, name); return r ? txt(k).slice(r[0], r[1]) : ''; };
  const out = new Set(roots), seenInc = new Set(), parts = roots.map(k => ({ k, name: '' }));
  const walk = x => {
    for (const m of x.matchAll(/<include(?:\s+content="([^"]+)"[^>]*|\s*[^>]*)>([^<]*)<\/include>|<include\s+content="([^"]+)"/gi)) {
      const raw = (m[1] || m[3] || m[2] || '').trim();
      // Bald_OSDSlot_$PARAM[play]_Play: every definition the name can resolve to
      const names = /\$PARAM\[/i.test(raw) ? Object.keys(defs).filter(d => new RegExp('^' + raw.split(/\$PARAM\[[^\]]*\]/i).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(d)) : [raw];
      for (const name of names) {
        if (!name || seenInc.has(name) || !defs[name]) continue;
        seenInc.add(name);
        for (const k of defs[name]) { out.add(k); parts.push({ k, name }); walk(body(k, name)); }
      }
    }
  };
  for (const r of roots) walk(txt(r));
  return withParts ? parts.map(p => ({ ...p, span: p.name ? span(p.k, p.name) : [0, txt(p.k).length] })).filter(p => p.span) : [...out];
}
// VideoOSD text plus the bodies of the includes it reaches, as {k, span:[a,b]}
const osdParts = (files, rootRe) => osdFiles(files, true, rootRe);
// Run fn only inside those parts, so same-named controls elsewhere in Includes.xml stay put.
// Aeon Nox draws its OSD bottom bar in Includes_OSD.xml (DefaultSeekbar, pulled in by DialogSeekBar.xml),
// so patching VideoOSD.xml / DialogSeekBar.xml alone leaves the OSD looking unchanged.
function osdPatch(out, fn, rootRe) {
  let n = 0;
  const byFile = {};
  for (const p of osdParts(out, rootRe)) (byFile[p.k] = byFile[p.k] || []).push(p.span);
  for (const [k, spans] of Object.entries(byFile)) {
    let x = out[k];
    // a root file's whole-file span contains its own include definitions: keep only outermost spans
    const outer = spans.sort((p, q) => p[0] - q[0] || q[1] - p[1]).filter((p, i, a) => !a.slice(0, i).some(q => q[0] <= p[0] && q[1] >= p[1]));
    for (const [a, b] of outer.reverse()) {
      const r = fn(x.slice(a, b));
      x = x.slice(0, a) + r.xml + x.slice(b); n += r.n;
    }
    out[k] = x;
  }
  return n;
}
const hideOsdEverywhere = (out, ids) => osdPatch(out, x => hideOsdButtons(x, ids));
// Human names for OSD buttons. Icon-font skins (Aeon Nox, Arctic) leave <label> empty, so the name comes from
// what the button does: the most telling of its onclick actions, then the label, description or texture.
const OSD_ACTIONS = [
  [/PlayerControl\(Play(?:Pause)?\)|^Pause$|^PlayPause$/i, 'Play / Pause'], [/PlayerControl\(Stop\)|^Stop$/i, 'Stop'],
  [/PlayerControl\(Previous\)|PlayerControl\(Prev\)|^SkipPrevious$/i, 'Previous'], [/PlayerControl\(Next\)|^SkipNext$/i, 'Next'],
  [/PlayerControl\(Rewind\)|^Rewind$/i, 'Rewind'], [/PlayerControl\(Forward\)|^FastForward$/i, 'Fast forward'],
  [/PlayerControl\(Random|PlayerControl\(Shuffle/i, 'Shuffle'], [/PlayerControl\(Repeat/i, 'Repeat'],
  [/PlayerControl\(ShowVideoMenu\)/i, 'Disc menu'], [/PlayerControl\(Record\)|PVR\.ToggleRecordPlayingChannel/i, 'Record'],
  [/PlayerControl\(Tempo|PlayerControl\(Speed/i, 'Playback speed'],
  [/osdaudiosettings|AudioDelay/i, 'Audio settings'], [/osdvideosettings/i, 'Video settings'], [/osdcmssettings/i, 'Colour management'],
  [/OSDSubtitleSettings|subtitlesearch|ShowSubtitles|NextSubtitle/i, 'Subtitles'], [/videobookmarks|CreateBookmark/i, 'Bookmarks'],
  [/Teletext/i, 'Teletext'], [/PVROSDChannels|pvrchannels/i, 'Channel list'], [/pvrchannelguide|PVROSDGuide|tvguide/i, 'TV guide'],
  [/PVROSDTeletext/i, 'Teletext'], [/pvrrecordings/i, 'Recordings'], [/pvrtimer/i, 'Timers'],
  [/StereoMode|ToggleStereoMode/i, '3D mode'], [/ViewMode|AspectRatio|Zoom/i, 'Zoom / aspect'], [/AudioNextLanguage|osdaudio/i, 'Audio track'],
  [/playlist/i, 'Playlist'], [/Info\b|movieinformation|DialogVideoInfo|songinformation/i, 'Info'], [/script\.cinemavision|cinema/i, 'Cinema'],
  [/lyrics/i, 'Lyrics'], [/visualisation|osdvisset/i, 'Visualisation'], [/DialogSettings|SettingsCategory|osdsettings/i, 'Settings'],
  [/^(?:Close|Back|Dialog\.Close\((?:all|VideoOSD)[^)]*\)|PreviousMenu)$/i, 'Close OSD'],
];
// icon-font glyphs (private use area) and invisible marks: what icon skins put in <label>
const GLYPH = /[\uE000-\uF8FF\u200B-\u200F\u2060\uFEFF]|[\u{F0000}-\u{10FFFF}]/gu;
// Icon file names to button names (rewind.png, skipback.png, stereoscopic.png …)
const TEX_NAMES = [[/skip_?back|replay|back_?\d+|minus/i, 'Skip back'], [/skip_?f(or)?w(ar)?d|fwd_?\d+|plus/i, 'Skip forward'], [/rewind|^rw$|^rew/i, 'Rewind'], [/forward|^ff$/i, 'Fast forward'],
  [/^(play|pause|playpause)/i, 'Play / Pause'], [/^stop/i, 'Stop'], [/^next/i, 'Next'], [/^prev/i, 'Previous'], [/subtitle|^subs?$/i, 'Subtitles'], [/audio/i, 'Audio settings'],
  [/video|picture/i, 'Video settings'], [/stereo|3d/i, '3D mode'], [/seek/i, 'Seek bar'], [/bookmark|chapter/i, 'Bookmarks'], [/info/i, 'Info'], [/guide|epg/i, 'TV guide'],
  [/channel/i, 'Channel list'], [/record|rec$/i, 'Record'], [/teletext/i, 'Teletext'], [/zoom|aspect/i, 'Zoom / aspect'], [/setting|cog|gear/i, 'Settings'], [/playlist|queue/i, 'Playlist'], [/close|exit/i, 'Close OSD']];
OSD_ACTIONS.unshift([/ChapterOrBigStepBack|BigStepBack|SmallStepBack|^StepBack$|Seek\(-/i, 'Skip back'], [/ChapterOrBigStepForward|BigStepForward|SmallStepForward|^StepForward$|Seek\(\d/i, 'Skip forward'], [/PlayerControl\(FrameAdvance/i, 'Frame step']);
const isNoise = a => /^(SetProperty|ClearProperty|Skin\.(Set|Reset)String|SetFocus|Dialog\.Close\(VideoOSD|Dialog\.Close\(all|AlarmClock|Close$|Back$)/i.test(a);
function osdName(block, strings = {}) {
  const all = n => [...block.matchAll(new RegExp(`<${n}\\b[^>]*>([^<]*)</${n}>`, 'gi'))].map(m => m[1].trim()).filter(Boolean);
  const loc = s => s.replace(/&#x([0-9a-f]+);|&#(\d+);/gi, (_, h, d) => String.fromCodePoint(h ? parseInt(h, 16) : +d)).replace(GLYPH, '').replace(/\$LOCALIZE\[(\d+)\]/gi, (_, n) => strings[n] || `string ${n}`).replace(/\$(?:INFO|VAR|ESCINFO)\[[^\]]*\]/gi, '').replace(/\[\/?[A-Z]+[^\]]*\]/g, '').trim();
  // An onclick under a positive condition (Player.Paused, VideoPlayer.Content(livetv)) is the alternate use:
  // Estuary's rewind button resumes play when paused, Bald's back button opens the guide on live TV.
  const clicks = [...block.matchAll(/<onclick\b([^>]*)>([^<]*)<\/onclick>/gi)].map(m => ({ a: m[2].trim(), alt: /condition="\s*[^!"\s]/i.test(m[1]) }))
    .filter(c => c.a).sort((p, q) => p.alt - q.alt).map(c => c.a);
  const useful = clicks.filter(a => !isNoise(a));
  for (const a of [...useful, ...clicks]) { const hit = OSD_ACTIONS.find(([re]) => re.test(a)); if (hit) return hit[1]; }
  const label = loc(all('label')[0] || '') || loc(all('description')[0] || '');
  if (/[A-Za-z]/.test(label) && !/^string \d+$/.test(label) && label.length < 40) return label;
  const texs = [...block.matchAll(/<(?:texture\w*|param\s+name="(?:texture|icon|icon_off|icon_on|image)")[^>]*?(?:value="([^"]+)"[^>]*\/>|>([^<]+)<)/gi)].map(m => (m[1] || m[2] || '').trim()).filter(Boolean);
  const tex = (texs.find(t => !/^\$|circle|button|focus|back|bg|white|black|empty|blank/i.test(t.split(/[\\/]/).pop())) || '').split(/[\\/]/).pop()
    .replace(/\.(png|jpe?g|gif)$/i, '').replace(/^(osd_?|button_?|icon_?)/i, '').replace(/[-_]?(nf|fo|focus|nofocus)$/i, '');
  if (tex) { const hit = TEX_NAMES.find(([re]) => re.test(tex)); return hit ? hit[1] : tex.replace(/[_-]+/g, ' '); }
  const a = useful[0] || clicks[0] || '';
  const win = /ActivateWindow\(([^,)]+)/i.exec(a);
  const prop0 = /SetProperty\([^,]+,([^,)]+)/i.exec(clicks.join(' '));
  if (win && /^\d+$/.test(win[1]) && prop0) return `${prop0[1].replace(/settings$/i, ' settings').replace(/^av /i, 'A/V ')} menu`;
  if (win) return /^\d+$/.test(win[1]) ? `Custom dialog ${win[1]}` : win[1].replace(/^(osd|dialog)/i, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const prop = /SetProperty\([^,]+,([^,)]+)/i.exec(clicks.join(' '));
  if (prop && !/^$/.test(prop[1])) return `${prop[1]} menu`;
  if (prop) return 'Style toggle';
  if (/RunScript\(([^,)]+)/i.test(a)) return 'Script ' + /RunScript\(([^,)]+)/i.exec(a)[1].replace(/^script\./, '');
  if (/Skin\.ToggleSetting\(([^)]+)/i.test(a)) return 'Toggle ' + /Skin\.ToggleSetting\(([^)]+)/i.exec(a)[1];
  const v = /^\$VAR\[([^\],]+)/i.exec(a);
  if (v) return v[1].replace(/Var$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return (/[A-Za-z]/.test(label) && label) || a.replace(/\(.*/, '') || 'Button';
}
// Which part of the OSD a button lives in, from the include that holds it (LiveTV / PVR / Music / Video).
// Live TV only when a visible condition asks for it (not "!VideoPlayer.Content(livetv)").
const LIVE = /(?:^|[^!\w.])(?:VideoPlayer\.Content\(livetv\)|PVR\.IsPlaying\w*|VideoPlayer\.HasEpg)/i;
const osdSection = (name, block) => /pvr|live_?tv|(?:^|_)tv(?:_|$)/i.test(name.replace(/([a-z])([A-Z])/g, '$1_$2')) || (block.match(/<visible\b[^>]*>[^<]*<\/visible>|<param\s+name="visible"[^>]*>/gi) || []).some(v => LIVE.test(v.replace(/<[^>]*?(?:value=")?/, ' ')) && !/\|/.test(v)) ? 'Live TV' : /music/i.test(name) ? 'Music' : '';
// <param name="x" value="v"/> or <param name="x">v</param> of an include call
const callParams = body => {
  const o = {};
  for (const m of body.matchAll(/<param\s+name="([^"]+)"\s*(?:value="([^"]*)"\s*\/>|>([^<]*)<\/param>)/gi)) o[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  return o;
};
// Include calls with a numeric id param: the template buttons of Cupertino, Bald and other generated OSDs.
function templateCalls(x) {
  const out = [];
  for (const m of x.matchAll(/<include\s+content="[^"]+"[^>]*>/gi)) {
    const end = balancedEnd(x, m.index, 'include');
    if (end < 0) continue;
    const body = x.slice(m.index, end), p = callParams(body);
    if (/^\d+$/.test(p.id || '')) out.push({ at: m.index, end, body, p });
  }
  return out;
}
// Name a template button from its params: label, then onclick, then icon / texture file name.
function templateBlock(c) {
  const p = c.p, esc = s => String(s).replace(/</g, '&lt;');
  return `<control type="button" id="${p.id}"><label>${esc(p.label || p.text || '')}</label>` +
    ['onclick', 'onclick2', 'onclick3', 'action'].filter(k => p[k]).map(k => `<onclick>${esc(p[k])}</onclick>`).join('') +
    `<texturenofocus>${esc(p.icon || p.texture || p.image || p.icon_off || p.icon_on || '')}</texturenofocus>${p.visible ? `<visible>${esc(p.visible)}</visible>` : ''}` + c.body + '</control>';
}
function osdButtons(files, strings = {}) {
  const ps = osdParts(files);
  if (!ps.length) return [];
  const rows = [], seen = new Set();
  const add = (k, inc, block, kind) => {
    const id = (/id\s*=\s*"(\d+)"/i.exec(block) || [])[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    const tag = n => ((new RegExp(`<${n}\\b[^>]*>([^<]*)</${n}>`, 'i').exec(block) || [])[1] || '').trim();
    const clicks = [...block.matchAll(/<onclick\b[^>]*>([^<]*)<\/onclick>/gi)].map(x => x[1].trim()).filter(Boolean);
    const tex = tag('texturenofocus') || tag('texturefocus');
    rows.push({ id, kind, name: /HiddenObject/.test(block) ? 'Hidden seek / step control' : osdName(block, strings), section: osdSection(inc || '', block), label: tag('label').replace(GLYPH, '').replace(/\$LOCALIZE\[(\d+)\]/g, (_, n) => strings[n] || 'string ' + n),
      onclick: clicks.join(' ; '), visible: tag('visible'), texture: base(tex || ''), tex: tex || '', file: base(k), include: inc || '' });
  };
  for (const { k, span, name: inc } of ps) {
    // commented-out buttons (Nimbus keeps a whole old OSD in a comment) are not buttons
    const x = files[k].toString('utf8').slice(span[0], span[1]).replace(/<!--[\s\S]*?-->/g, m => ' '.repeat(m.length));
    for (const m of x.matchAll(BTN_RE())) add(k, inc, m[0], 'control');
    for (const c of templateCalls(x)) add(k, inc, templateBlock(c), 'template');
  }
  // Same name twice in one section (e.g. two Close buttons): add the id so the chips stay apart.
  const count = {};
  rows.forEach(r => { const key = r.section + r.name; count[key] = (count[key] || 0) + 1; });
  rows.forEach(r => { if (count[r.section + r.name] > 1) r.dup = true; });
  return rows;
}
// strings.po text to {id: text}
function parsePo(txt) {
  const o = {};
  for (const m = /msgctxt\s+"#(\d+)"\s*\nmsgid\s+"((?:[^"\\]|\\.)*)"\s*\nmsgstr\s+"((?:[^"\\]|\\.)*)"/g, x = String(txt || ''); ;) { const r = m.exec(x); if (!r) break; o[r[1]] = (r[3] || r[2]).replace(/\\"/g, '"'); }
  return o;
}
function hideOsdButtons(x, ids) {
  const set = new Set(ids.map(String));
  let n = 0;
  x = x.replace(BTN_RE(), block => {
    const id = (/id\s*=\s*"(\d+)"/i.exec(block) || [])[1];
    if (!id || !set.has(id) || /kodicontrol: button hidden/.test(block)) return block;
    n++;
    return block.replace(/(<control\b[^>]*>)/i, '$1<!-- kodicontrol: button hidden --><visible>false</visible>');
  });
  // template buttons: the include call is dropped at load time with condition="false"
  for (const c of templateCalls(x).reverse()) {
    if (!set.has(c.p.id) || /kodicontrol: button hidden/.test(c.body.slice(0, 200))) continue;
    const start = /^<include\b[^>]*>/i.exec(c.body)[0];
    const tagged = /\scondition="/i.test(start) ? start.replace(/\scondition="([^"]*)"/i, ' condition="false + [$1]"') : start.replace(/^<include\b/i, '<include condition="false"');
    x = x.slice(0, c.at) + tagged + '<!-- kodicontrol: button hidden -->' + x.slice(c.at + start.length);
    n++;
  }
  return { xml: x, n };
}
function thinBars(x, h) {
  let n = 0;
  x = x.replace(/<control\s+type="(?:progress|slider)"[^>]*>[\s\S]*?<\/control>/gi, block => {
    const hm = /<height>\s*(\d+(?:\.\d+)?)\s*<\/height>/i.exec(block);
    if (!hm || +hm[1] <= h) return block;
    n++;
    const shift = Math.round((+hm[1] - h) / 2);
    block = block.replace(hm[0], `<height>${h}</height>`);
    if (/<top>\s*-?\d+(?:\.\d+)?\s*<\/top>/i.test(block)) block = block.replace(/<top>\s*(-?\d+(?:\.\d+)?)\s*<\/top>/i, (m, v) => `<top>${Math.round(+v + shift)}</top>`);
    else if (/<bottom>\s*-?\d+(?:\.\d+)?\s*<\/bottom>/i.test(block)) block = block.replace(/<bottom>\s*(-?\d+(?:\.\d+)?)\s*<\/bottom>/i, (m, v) => `<bottom>${Math.round(+v + shift)}</bottom>`);
    return block;
  });
  return { xml: x, n };
}
function osdClear(x) {
  let n = 0;
  x = x.replace(/<control\s+type="image"[^>]*>[\s\S]*?<\/control>/gi, block => {
    const tex = texOf(block);
    if (!isStatic(tex) || /play|pause|icon|button|logo|flag|star|progress|nib|arrow|osd[_/]?(ff|rw|next|prev|stop|sub|audio|set)/i.test(tex)) return block;
    n++;
    return setDiffuse(block, '00FFFFFF');
  });
  return { xml: x, n };
}

// Item 4: a zoom button that shows up. Goes inside the OSD button row (a grouplist), even when that row
// lives in an include; falls back to a standalone button bottom-right when the skin builds buttons from params.
function zoomButtonXml(font, h) {
  return `<control type="button" id="9871">\n\t<description>Kodi Control zoom</description>\n\t<width>${Math.round(h * 1.8)}</width><height>${h}</height>\n\t<label>Zoom</label><font>${font}</font><align>center</align><aligny>center</aligny>\n\t<textcolor>FFFFFFFF</textcolor><focusedcolor>FFFFFFFF</focusedcolor>\n\t<texturefocus border="28" colordiffuse="D90A84FF">${GLASS}</texturefocus>\n\t<texturenofocus border="28" colordiffuse="33FFFFFF">${GLASS}</texturenofocus>\n\t<onclick>RunScript(script.kodicontrol,zoom)</onclick>\n</control>`;
}
function cloneAsZoom(btn, font) {
  let b = /\sid\s*=\s*"[^"]*"/i.test(btn) ? btn.replace(/\sid\s*=\s*"[^"]*"/i, ' id="9871"') : btn.replace(/<control\b/i, '<control id="9871"');
  b = b.replace(/<(onclick|visible|enable|selected|label|label2|description|altclick|onfocus|onunfocus|onleft|onright|onup|ondown)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // icon-font buttons (Aeon Nox: IconOSDButtons) would draw "Zoom" as blank glyphs; use the skin's text font
  if (font) b = b.replace(/<font>\s*([^<]*(?:icon|glyph|symbol|awesome)[^<]*)<\/font>/i, `<font>${font}</font>`);
  return b.replace(/(<control\b[^>]*>)/i, '$1\n\t<description>Kodi Control zoom</description>\n\t<label>Zoom</label>\n\t<onclick>RunScript(script.kodicontrol,zoom)</onclick>');
}
// Insert into the first grouplist of `x` (between from..to). Returns new xml or null.
function zoomIntoGrouplist(x, font, from = 0, to = x.length) {
  const re = /<control\s+type="grouplist"[^>]*>/gi;
  re.lastIndex = from;
  let g;
  while ((g = re.exec(x)) && g.index < to) {
    const end = balancedEnd(x, g.index, 'control');
    if (end < 0) continue;
    const body = x.slice(g.index, end);
    const btn = BTN_RE().exec(body);
    const closeAt = end - '</control>'.length;
    if (btn) {
      // insert after the grouplist's last direct button so it lands at the end of the row
      const all = [...body.matchAll(BTN_RE())];
      const last = all[all.length - 1];
      const at = g.index + last.index + last[0].length;
      return { xml: x.slice(0, at) + '\n' + cloneAsZoom(btn[0], font) + x.slice(at), note: 'added to the OSD button row' };
    }
    if (/<include\b/i.test(body) && /onclick|PlayerControl|button/i.test(body)) {
      const hm = /<height>\s*(\d+)\s*<\/height>/i.exec(body);
      return { xml: x.slice(0, closeAt) + '\n' + zoomButtonXml(font, Math.min(90, hm ? +hm[1] : 60)) + '\n' + x.slice(closeAt), note: 'added to the OSD button row (own style, skin builds its buttons from includes)' };
    }
  }
  return null;
}
// Zoom preset in place of an existing OSD button (default the Info button): the button keeps its spot, focus
// order and style, its actions become the zoom cycle and its icon the skin's own zoom icon when it has one.
// Template buttons (Bald: <include content="Bald_OSDButton"><param name="id">70043</param>) lose the actions
// passed to them, and so do the wrappers that call their definition (Bald_OSDSlot_Real_Info opens the info
// panel from <onfocus>), up to two levels out.
const ZOOM_CLICK = '<onclick>RunScript(script.kodicontrol,zoom)</onclick>';
const ACT_TAGS = /<(onclick|altclick|onfocus|onunfocus|onup)\b[^>]*>[\s\S]*?<\/\1>\s*/gi;
function zoomIcon(all) {
  for (const c of templateCalls(all)) if (/zoom/i.test(c.body) && (c.p.icon || c.p.texture)) return c.p.icon || c.p.texture;
  const m = /<control\s+type="(?:radio|toggle)?button"[^>]*>(?:(?!<\/control>)[\s\S])*?zoom(?:(?!<\/control>)[\s\S])*?<texturenofocus[^>]*>([^<$]+\.png)<\/texturenofocus>/i.exec(all);
  return m ? m[1] : '';
}
function replaceWithZoom(out, files, id) {
  id = String(id);
  const all = files.map(k => out[k]).join('\n');
  const icon = zoomIcon(all);
  let n = 0;
  const wrapNames = new Set();
  for (const k of files) {
    let x = out[k];
    x = x.replace(BTN_RE(), block => {
      if ((/\sid\s*=\s*"(\d+)"/i.exec(block) || [])[1] !== id || /kodicontrol: zoom/.test(block)) return block;
      n++;
      let b = block.replace(ACT_TAGS, '').replace(/(<control\b[^>]*>)/i, `$1<!-- kodicontrol: zoom -->${ZOOM_CLICK}`);
      if (icon) b = b.replace(/(<texture(?:no)?focus\b[^>]*>)([^<]*info[^<]*)(<\/texture(?:no)?focus>)/gi, `$1${icon}$3`);
      return b;
    });
    for (const c of templateCalls(x).reverse()) {
      if (c.p.id !== id || /kodicontrol: zoom/.test(c.body)) continue;
      const start = /^<include\b[^>]*>/i.exec(c.body)[0];
      let body = c.body.slice(start.length).replace(ACT_TAGS, '');
      if (icon) for (const k2 of ['icon', 'on', 'texture', 'icon_on', 'icon_off']) body = body.replace(new RegExp(`(<param\\s+name="${k2}"\\s*>)[^<]*(</param>)`, 'i'), `$1${icon}$2`);
      x = x.slice(0, c.at) + start + '<!-- kodicontrol: zoom -->' + ZOOM_CLICK + body + x.slice(c.end);
      n++;
      // the definition this call sits in: its callers may pass panel-opening actions in
      const def = [...x.slice(0, c.at).matchAll(/<include\s+name="([^"]+)"[^>]*>/gi)].pop();
      if (def && balancedEnd(x, def.index, 'include') > c.at) wrapNames.add(def[1]);
    }
    out[k] = x;
  }
  for (let lvl = 0; lvl < 2 && wrapNames.size; lvl++) {
    const next = new Set();
    for (const k of files) {
      let x = out[k];
      for (const m of [...x.matchAll(/<include\s+content="([^"]+)"[^>]*>/gi)].reverse()) {
        if (!wrapNames.has(m[1])) continue;
        const end = balancedEnd(x, m.index, 'include');
        if (end < 0) continue;
        const call = x.slice(m.index, end), cleaned = call.replace(ACT_TAGS, '');
        if (cleaned !== call) x = x.slice(0, m.index) + cleaned + x.slice(end);
        const def = [...x.slice(0, m.index).matchAll(/<include\s+name="([^"]+)"[^>]*>/gi)].pop();
        if (def && balancedEnd(x, def.index, 'include') > m.index) next.add(def[1]);
      }
      out[k] = x;
    }
    wrapNames.clear(); for (const w of next) wrapNames.add(w);
  }
  return n;
}
function addZoom(out, fontOf) {
  const k = Object.keys(out).find(f => /^VideoOSD\.xml$/i.test(base(f)));
  if (!k) return { n: 0, note: 'this skin has no VideoOSD.xml' };
  if (/script\.kodicontrol,zoom/.test(out[k])) return { n: 0, note: 'already present' };
  const font = fontOf(dirOf(k));
  let r = zoomIntoGrouplist(out[k], font);
  if (r) { out[k] = r.xml; return { n: 1, note: r.note }; }
  // The row may be defined in an include referenced from VideoOSD (possibly nested). Try the include with the
  // most PlayerControl() calls first and never a debug overlay (Aeon Nox's DebugWindow has a grouplist too).
  const incNames = x => [...x.matchAll(/<include(?:\s+condition="[^"]*")?\s*>\s*([\w.\-]+)\s*<\/include>|<include\s+content="([^"]+)"/gi)].map(m => m[1] || m[2]);
  const defs = [];
  for (const f of Object.keys(out)) {
    if (dirOf(f) !== dirOf(k) || !isXml(f)) continue;
    for (const m of out[f].matchAll(/<include\s+name="([^"]+)"[^>]*>/gi)) {
      const end = balancedEnd(out[f], m.index, 'include');
      if (end > 0) defs.push({ f, name: m[1], at: m.index, end });
    }
  }
  const seen = new Set(), queue = incNames(out[k]), cands = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || /debug/i.test(name)) continue;
    seen.add(name);
    for (const d of defs.filter(d => d.name === name)) {
      const body = out[d.f].slice(d.at, d.end);
      cands.push({ ...d, score: (body.match(/PlayerControl\(/gi) || []).length });
      queue.push(...incNames(body));
    }
  }
  for (const d of cands.sort((x, y) => y.score - x.score)) {
    if (!d.score) break;
    r = zoomIntoGrouplist(out[d.f], font, d.at, d.end);
    if (r) { out[d.f] = r.xml; return { n: 1, note: `${r.note}, inside include "${d.name}" (${base(d.f)})` }; }
  }
  // standalone fallback, bottom-right, visible whenever the OSD is open
  const btn = zoomButtonXml(font, 60).replace('<width>', '<right>40</right><bottom>40</bottom><width>');
  const at = out[k].search(/<\/controls>\s*<\/window>\s*$/i);
  if (at < 0) return { n: 0, note: 'could not find where to put it in VideoOSD.xml' };
  out[k] = out[k].slice(0, at) + btn + '\n' + out[k].slice(at);
  return { n: 1, note: 'added as a standalone button bottom-right (no button row found to join)' };
}

const BG_TARGETS = {
  movies: { label: 'Movies library', windows: ['MyVideoNav.xml'], cond: 'Container.Content(movies) | Container.Content(sets)' },
  tvshows: { label: 'TV shows library', windows: ['MyVideoNav.xml'], cond: 'Container.Content(tvshows) | Container.Content(seasons) | Container.Content(episodes)' },
  livetv: { label: 'Live TV', windows: ['MyPVRChannels.xml', 'MyPVRGuide.xml', 'MyPVRRecordings.xml', 'MyPVRTimers.xml', 'MyPVRSearch.xml'] },
  apps: { label: 'Apps / Add-on browser', windows: ['MyPrograms.xml', 'AddonBrowser.xml'] },
  favourites: { label: 'Favourites', windows: ['MyFavourites.xml', 'FavouritesBrowser.xml', 'DialogFavourites.xml'] },
  music: { label: 'Music library', windows: ['MyMusicNav.xml'] },
  weather: { label: 'Weather', windows: ['MyWeather.xml'] },
  settings: { label: 'Settings', windows: ['Settings.xml', 'SettingsCategory.xml', 'SkinSettings.xml'] },
};

function bgTarget(b, menuId) {
  if (b.target === 'home') {
    const id = cleanId(b.value), label = cleanLabel(b.value);
    return { windows: ['Home.xml'], cond: `String.IsEqual(Container(${+menuId || 9000}).ListItem.Property(defaultID),${id}) | String.IsEqual(Container(${+menuId || 9000}).ListItem.Label,${label})` };
  }
  if (b.target === 'addon') {
    const id = cleanId(b.value);
    return { windows: ['MyVideoNav.xml', 'MyMusicNav.xml', 'MyPrograms.xml', 'MyPics.xml'], cond: `String.StartsWith(Container.FolderPath,plugin://${id}/)` };
  }
  return BG_TARGETS[b.target];
}

function bgControls(b, cond, w, h) {
  const vis = cond ? `\n\t\t<visible>${esc(cond)}</visible>` : '';
  const pos = `<left>0</left><top>0</top><width>${w}</width><height>${h}</height>`;
  const folder = /\/$/.test(b.path);
  let s = folder
    ? `\t<control type="multiimage">\n\t\t<description>kodicontrol background</description>${pos}\n\t\t<imagepath background="true">${esc(b.path)}</imagepath><timeperimage>9000</timeperimage><fadetime>900</fadetime><randomize>true</randomize><aspectratio>scale</aspectratio>${vis}\n\t</control>\n`
    : `\t<control type="image">\n\t\t<description>kodicontrol background</description>${pos}\n\t\t<texture background="true">${esc(b.path)}</texture><aspectratio>scale</aspectratio><fadetime>300</fadetime>${vis}\n\t</control>\n`;
  const dim = Math.max(0, Math.min(95, +b.dim || 0));
  if (dim) {
    const a = Math.round(dim / 100 * 255).toString(16).padStart(2, '0').toUpperCase();
    s += `\t<control type="image">\n\t\t<description>kodicontrol background dim</description>${pos}\n\t\t<texture>${WHITE}</texture><colordiffuse>${a}000000</colordiffuse>${vis}\n\t</control>\n`;
  }
  return s;
}

function injectBackground(x, block) {
  const c = /<controls\s*>/i.exec(x);
  if (!c) return null;
  const from = c.index + c[0].length;
  const near = x.slice(from, from + 5000);
  const bg = /<include\b[^>]*>[^<]*(?:background|backdrop|wallpaper|fanart)[^<]*<\/include>|<include\s+content="[^"]*(?:background|backdrop|wallpaper|fanart)[^"]*"[^>]*\/>/i.exec(near);
  const at = bg ? from + bg.index + bg[0].length : from;
  return x.slice(0, at) + '\n' + block + x.slice(at);
}

function applyAll(files, t, opts = {}) {
  const src = {};
  for (const [k, v] of Object.entries(files)) if (isXml(k)) src[k] = v.toString('utf8');
  // Park XML comments as placeholders while patching: regexes must not match commented-out controls, and a
  // marker comment inserted inside an existing comment would close it early and break the file.
  const cmts = [];
  const park = x => x.replace(/<!--[\s\S]*?-->/g, m => /^<!-- kodicontrol:/.test(m) ? m : `\u0001${cmts.push(m) - 1}\u0001`); // our own markers stay visible
  const unpark = x => x.replace(/\u0001(\d+)\u0001/g, (_, i) => cmts[+i]);
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = park(v);
  const dirs = opts.dirs || [...new Set(Object.keys(src).filter(k => /^Home\.xml$/i.test(base(k))).map(dirOf))];
  const report = [];
  const add = (ok, text) => report.push({ ok, text });
  const each = (pred, fn) => {
    let n = 0;
    for (const k of Object.keys(out)) if (pred(k)) { const r = fn(out[k], k); out[k] = r.xml; n += r.n; }
    return n;
  };
  const [W, H] = opts.res || [1920, 1080];

  let assets = [];
  if (t.osdFrom && opts.otherSkin) {
    const r = importOsd(out, dirs, opts.otherSkin, opts.otherExtra);
    add(r.ok, r.text);
    assets = r.assets || [];
  }
  if (t.busy) {
    for (const d of dirs) out[`${d}/DialogBusy.xml`] = emptyWindow(out[`${d}/DialogBusy.xml`]);
    add(true, 'Busy spinner (DialogBusy) hidden');
  }
  if (t.vol) {
    for (const d of dirs) out[`${d}/DialogVolumeBar.xml`] = emptyWindow(out[`${d}/DialogVolumeBar.xml`]);
    add(true, 'Volume bar hidden');
  }
  if (t.topbar) {
    const n = each(isXml, hideTopbar);
    add(n > 0, n ? `Top bar: ${plural(n, 'element')} hidden` : 'Top bar: no include or group named like a top bar was found in this skin');
  }
  if (t.hbTransparent) {
    const n = each(k => /home/i.test(base(k)), homebarTransparent);
    add(n > 0, n ? `Home bar: ${plural(n, 'background image')} made transparent` : 'Home bar: no menu background textures recognised in this skin');
  }
  if (t.fullArt) {
    const top = t.fullArtMode === 'top', tops = top ? containerTops(out) : {};
    const n = each(isXml, x => fullArt(x, W, H, { mode: t.fullArtMode, color: t.fullArtColor, tops }));
    add(n > 0, n ? (top ? `Artwork across the top: ${plural(n, 'background')} fill the width above the posters and fade into a solid band behind them` : `Full-screen artwork: ${plural(n, 'background')} no longer faded or pushed to one side (MyFlix and similar views)`) : 'Full-screen artwork: no faded or one-sided background art found');
  }
  if (t.posters) {
    let wide = 0;
    const n = each(isXml, x => { const r = roundPosters(x); wide += r.wide; return r; });
    add(n > 0, n ? `Rounded artwork: ${plural(n - wide, 'poster image')} and ${plural(wide, 'episode / landscape thumbnail')}` : 'Rounded posters: no poster textures found (skin may build them inside $PARAM includes)');
    // overlays the same size as rounded art (dimmers, label backings) get the same corners
    const sizes = new Set();
    for (const k of Object.keys(out).filter(isXml)) for (const m of String(out[k]).matchAll(/<control\s+type="image"[^>]*>[\s\S]*?<\/control>/gi)) {
      if (!/extras\/kc\/mask/.test(m[0])) continue;
      const w = (/<width>\s*(\d+)\s*<\/width>/i.exec(m[0]) || [])[1], h = (/<height>\s*(\d+)\s*<\/height>/i.exec(m[0]) || [])[1];
      if (w && h) sizes.add(`${w}x${h}`);
    }
    const templ = new Set();
    const o = each(isXml, x => { const r = roundOverlays(x, sizes); r.templ.forEach(t => templ.add(t)); return r; });
    if (templ.size) each(isXml, x => maskCalls(x, templ));
    if (o) add(true, `Rounded ${plural(o, 'dimmer / label overlay')} drawn over the artwork, so unfocused posters and episodes keep their corners`);
  }
  if (t.anim === 'off' || (t.speed && +t.speed !== 100)) {
    const f = t.anim === 'off' ? 0 : +t.speed / 100;
    const n = each(isXml, x => scaleAnims(x, f));
    add(true, f === 0 ? `Animations made instant (${plural(n, 'timing')})` : `Animation timing scaled to ${t.speed}% (${plural(n, 'timing')})`);
  }
  const fontOf = d => {
    const f = Object.keys(out).find(k => dirOf(k) === d && /^Font\.xml$/i.test(base(k)));
    const names = f ? [...out[f].matchAll(/<name>\s*([^<]+?)\s*<\/name>/gi)].map(m => m[1]) : [];
    return names.find(n => /^font1[23]$/i.test(n)) || names.find(n => /^font1\d/i.test(n)) || names.find(n => /small|body|text/i.test(n)) || names[1] || names[0] || 'font13';
  };
  if (t.hbGradients) {
    const n = each(k => /home/i.test(base(k)), hbGradients);
    add(n > 0, n ? `Home gradients: ${plural(n, 'gradient/shadow layer')} hidden` : 'Home gradients: no gradient or shadow textures recognised in this skin');
  }
  if (t.winAnimOff) {
    const only = new Set((t.winAnimFiles || []).map(f => f.toLowerCase()));
    const n = each(k => isXml(k) && !isColors(k) && (!only.size || only.has(base(k).toLowerCase())), x => stripWinAnims(x, !!t.winAnimVis));
    add(n > 0, n ? `Window switch animations removed (${plural(n, 'animation')}${only.size ? `, in ${plural(only.size, 'chosen window')}` : ', all windows'}${t.winAnimVis ? ', incl. visible/hidden' : ''})` : 'Window switch animations: none found');
  }
  if (t.hideInfo && t.hideInfo.length) {
    const n = each(k => isXml(k) && !OSD_FILE.test(base(k)), x => hideInfo(x, t.hideInfo));
    add(n > 0, n ? `Info hidden (${t.hideInfo.join(', ')}): ${plural(n, 'control')}` : `Info hiding: no controls showing ${t.hideInfo.join(', ')} were found`);
  }
  if (t.hideItems && t.hideItems.length) {
    const vars = varMap(out);
    const n = each(k => isXml(k) && !INFO_SKIP_FILE(k), x => hideItems(x, t.hideItems, vars));
    add(n > 0, n ? `Hidden items: ${plural(n, 'control')} for ${plural(t.hideItems.length, 'chosen item')}` : 'Hidden items: none of the chosen items were found in this skin');
  }
  if (t.glass) {
    const c = each(k => isColors(k), glassColors);
    const p = each(k => isXml(k) && !isColors(k), glassPanels);
    add(c + p > 0, `Glass (experimental): ${plural(c, 'colour')} made translucent, ${plural(p, 'panel/button texture')} swapped for rounded glass. Kodi cannot blur, so it is a tint, not frosted glass`);
  }
  if (t.osdHide && t.osdHide.length) {
    const n = hideOsdEverywhere(out, t.osdHide);
    add(n > 0, n ? `OSD: ${plural(n, 'button')} hidden` : 'OSD: none of the chosen buttons were found (did the OSD source change?)');
  }
  if (+t.osdBarH > 0) {
    const n = osdPatch(out, x => thinBars(x, +t.osdBarH), OSD_FILE);
    add(n > 0, n ? `OSD progress bar: ${plural(n, 'bar')} set to ${t.osdBarH}px` : 'OSD progress bar: no bar taller than that was found');
  }
  if (t.osdClear) {
    const n = osdPatch(out, osdClear, OSD_FILE);
    add(n > 0, n ? `OSD transparent: ${plural(n, 'background image')} cleared, buttons kept` : 'OSD transparent: no static background images found');
  }
  if (t.osdZoom && t.zoomReplace) {
    const files = [...new Set(osdParts(out, OSD_FILE).map(p => p.k))];
    const n = replaceWithZoom(out, files, t.zoomReplace);
    add(n > 0, n ? `OSD zoom preset: put in place of button ${t.zoomReplace}${t.zoomReplaceName ? ` (${t.zoomReplaceName})` : ''}` : `OSD zoom preset: button ${t.zoomReplace} was not found in this OSD (did the OSD source change?); pick the button again`);
  } else if (t.osdZoom) {
    const r = addZoom(out, fontOf);
    add(r.n > 0 || r.note === 'already present', `OSD zoom button: ${r.note}`);
  }
  if (t.bgs && t.bgs.length) {
    for (const b of t.bgs) {
      if (!b.path) continue;
      const tg = bgTarget(b, t.menuId);
      if (!tg) { add(false, `Background: unknown target ${b.target}`); continue; }
      let hit = 0;
      for (const d of dirs) for (const wname of tg.windows) {
        const k = Object.keys(out).find(f => dirOf(f) === d && base(f).toLowerCase() === wname.toLowerCase());
        if (!k) continue;
        const r = injectBackground(out[k], bgControls(b, tg.cond, W, H));
        if (r) { out[k] = r; hit++; }
      }
      const name = b.target === 'home' ? `Home → ${b.value}` : b.target === 'addon' ? `Add-on ${b.value}` : tg.label;
      add(hit > 0, hit ? `Background for ${name}: added to ${plural(hit, 'window')}` : `Background for ${name}: this skin has none of ${tg.windows.join(', ')}`);
    }
  }

  const changed = {};
  for (const [k, p] of Object.entries(out)) { const v = unpark(p); if (v !== src[k]) changed[k] = v; }
  return { changed, report, assets };
}

// ---- Skin Shortcuts main menu (home bar items) ----
const LOCALIZED = { 0: 'Programs', 1: 'Pictures', 2: 'Music', 3: 'Videos', 5: 'Settings', 8: 'Weather', 342: 'Movies', 10134: 'Favourites', 19020: 'TV', 19021: 'Radio', 20343: 'TV shows', 24001: 'Add-ons' };
const tagOf = (b, n) => ((new RegExp(`<${n}>([\\s\\S]*?)</${n}>`, 'i').exec(b) || [])[1] || '').trim();

function guessKind(it) {
  const s = `${it.defaultID} ${it.label} ${it.action}`.toLowerCase();
  if (/videodb:\/\/movies|\bmovies?\b/.test(s)) return 'movies';
  if (/videodb:\/\/tvshows|tvshows|tv shows/.test(s)) return 'tvshows';
  if (/tvchannels|tvguide|pvr|live ?tv|\btv\b/.test(s)) return 'livetv';
  if (/favourite|favorite/.test(s)) return 'favourites';
  if (/programs|executable|addonbrowser|add-ons|addons|\bapps?\b/.test(s)) return 'apps';
  return '';
}

function parseMenu(xml) {
  return [...xml.matchAll(/<shortcut>([\s\S]*?)<\/shortcut>/gi)].map(m => {
    const b = m[1];
    const it = { defaultID: tagOf(b, 'defaultID'), label: tagOf(b, 'label'), action: tagOf(b, 'action'), disabled: /^true$/i.test(tagOf(b, 'disabled')) };
    it.key = it.defaultID || it.label || it.action;
    it.name = /^\d+$/.test(it.label) ? (LOCALIZED[it.label] || `$LOCALIZE[${it.label}]`) : it.label.replace(/\$LOCALIZE\[(\d+)\]/g, (x, n) => LOCALIZED[n] || x);
    it.kind = guessKind({ ...it, label: it.name });
    return it;
  });
}

function filterMenu(xml, keep) {
  const set = new Set(keep);
  return xml.replace(/<shortcut>([\s\S]*?)<\/shortcut>/gi, (m, b) => {
    const key = tagOf(b, 'defaultID') || tagOf(b, 'label') || tagOf(b, 'action');
    b = b.replace(/\s*<disabled>[\s\S]*?<\/disabled>/gi, '');
    if (!set.has(key)) b = b.replace(/\s*$/, '\n\t\t<disabled>True</disabled>\n\t');
    return `<shortcut>${b}</shortcut>`;
  });
}

module.exports = { osdFiles, infoItems, applyAll, animInventory, winAnimInventory, osdButtons, osdName, parsePo, INFO_FIELDS, parseMenu, filterMenu, BG_TARGETS, emptyWindow };
