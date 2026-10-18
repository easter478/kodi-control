// Title editor (Tools → Edit titles) and the font switch for Korean, Japanese and Chinese titles.
// Titles are changed straight in Kodi's library over JSON-RPC: no .nfo, no rescan, the artwork stays.
// The first value of every field changed is kept in cfg.titleUndo, so each change can be put back.
// The font switch only changes Kodi's lookandfeel.font setting; the old value is kept in cfg.fontOrig.

const FIELDS = ['title', 'originaltitle', 'sorttitle', 'year'];
const KIND = {
  movie: { get: 'VideoLibrary.GetMovies', list: 'movies', set: 'VideoLibrary.SetMovieDetails', idKey: 'movieid', one: 'VideoLibrary.GetMovieDetails', oneKey: 'moviedetails' },
  tvshow: { get: 'VideoLibrary.GetTVShows', list: 'tvshows', set: 'VideoLibrary.SetTVShowDetails', idKey: 'tvshowid', one: 'VideoLibrary.GetTVShowDetails', oneKey: 'tvshowdetails' },
};
// Hangul, kana, CJK ideographs and full-width forms: what the skins' default fonts usually can't draw
const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

function make({ rpc, sh, q, cfg, saveCfg, listSkins, skinInfo, artData, builtin }) {
  const key = (kind, id) => `${kind}:${id}`;
  const undo = () => (cfg().titleUndo = cfg().titleUndo || {});
  const refresh = () => builtin('Container.Refresh').catch(() => {});

  async function setFields(kind, id, fields) {
    const k = KIND[kind];
    if (!k) throw new Error('Unknown kind ' + kind);
    const clean = {};
    for (const f of FIELDS) if (fields[f] !== undefined) clean[f] = f === 'year' ? (+fields[f] || 0) : String(fields[f]).trim();
    if (clean.title === '') throw new Error('The title can\'t be empty');
    await rpc(k.set, { [k.idKey]: id, ...clean }, 20000);
    return clean;
  }

  // which fontset in the active skin is built on Kodi's arial.ttf (it has Korean, Japanese and Chinese letters)
  async function fontInfo() {
    const { current } = await listSkins();
    const s = await skinInfo(current);
    const dir = (s.res.find(r => r.def) || s.res[0]).folder;
    const xml = await sh(`cat ${q(s.path + '/' + dir + '/Font.xml')} 2>/dev/null || cat ${q(s.path + '/' + dir + '/font.xml')} 2>/dev/null`);
    const sets = [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<fontset\b([^>]*)>([\s\S]*?)<\/fontset>/gi)].map(m => ({
      id: (/id\s*=\s*"([^"]*)"/i.exec(m[1]) || [])[1],
      unicode: /unicode\s*=\s*"true"/i.test(m[1]),
      arial: (m[2].match(/<filename>\s*arial\.ttf\s*<\/filename>/gi) || []).length,
      fonts: (m[2].match(/<font>/gi) || []).length,
    })).filter(x => x.id);
    const wide = sets.filter(x => x.arial && x.arial >= x.fonts / 2).sort((a, b) => (b.unicode - a.unicode) || (b.arial - a.arial));
    let font = 'Default';
    try { font = (await rpc('Settings.GetSettingValue', { setting: 'lookandfeel.font' })).value; } catch {}
    const orig = (cfg().fontOrig || {})[current];
    return { skin: current, skinName: s.name, font, sets: sets.map(x => x.id), cjkSet: wide[0] ? wide[0].id : '', on: !!wide[0] && font === wide[0].id, orig };
  }

  return {
    'titles:list': async ({ movies = true, shows = true } = {}) => {
      const props = ['title', 'originaltitle', 'sorttitle', 'year', 'art', 'file'];
      const [m, t] = await Promise.all([
        movies ? rpc(KIND.movie.get, { properties: props, sort: { method: 'sorttitle', ignorearticle: true } }, 120000) : {},
        shows ? rpc(KIND.tvshow.get, { properties: props.filter(p => p !== 'file').concat('episode'), sort: { method: 'sorttitle', ignorearticle: true } }, 120000) : {},
      ]);
      const u = undo();
      const row = (kind, x) => {
        const was = u[key(kind, x[KIND[kind].idKey])];
        return { kind, id: x[KIND[kind].idKey], title: x.title, originaltitle: x.originaltitle || '', sorttitle: x.sorttitle || '', year: x.year || 0,
          poster: (x.art || {}).poster || (x.art || {}).thumb || '', file: x.file || '', episodes: x.episode, cjk: CJK.test(x.title + (x.originaltitle || '')), was: was || null };
      };
      const items = [...(m.movies || []).map(x => row('movie', x)), ...(t.tvshows || []).map(x => row('tvshow', x))];
      return { items, changed: Object.keys(u).length };
    },
    'titles:poster': url => url ? artData(url) : '',
    'titles:set': async ({ kind, id, fields }) => {
      const k = KIND[kind];
      const cur = (await rpc(k.one, { [k.idKey]: id, properties: FIELDS }))[k.oneKey];
      const want = {};
      for (const f of FIELDS) if (fields[f] !== undefined && String(fields[f]).trim() !== String(cur[f] ?? '')) want[f] = fields[f];
      if (!Object.keys(want).length) return { text: 'Nothing changed', item: cur };
      const u = undo(), kk = key(kind, id);
      u[kk] = u[kk] || {};
      for (const f of Object.keys(want)) if (!(f in u[kk])) u[kk][f] = cur[f] ?? '';
      saveCfg();
      await setFields(kind, id, want);
      // drop the undo entry when every field is back at its first value
      const now = (await rpc(k.one, { [k.idKey]: id, properties: FIELDS }))[k.oneKey];
      if (Object.entries(u[kk]).every(([f, v]) => String(now[f] ?? '') === String(v))) { delete u[kk]; saveCfg(); }
      await refresh();
      return { text: `Changed ${Object.keys(want).join(', ')} of "${cur.title}" in Kodi's library`, item: now, was: u[kk] || null };
    },
    'titles:undo': async ({ kind, id } = {}) => {
      const u = undo(), keys = kind ? [key(kind, id)] : Object.keys(u);
      let n = 0; const bad = [];
      for (const kk of keys) {
        if (!u[kk]) continue;
        const [kd, i] = kk.split(':');
        try { await setFields(kd, +i, u[kk]); delete u[kk]; n++; } catch (e) { bad.push(`${kk}: ${e.message}`); if (/not found|invalid/i.test(e.message)) delete u[kk]; }
      }
      saveCfg(); await refresh();
      return `${n} title${n === 1 ? '' : 's'} put back${bad.length ? ' · ' + bad.join(', ') : ''}`;
    },
    'font:status': fontInfo,
    'font:cjk': async on => {
      const f = await fontInfo();
      const orig = cfg().fontOrig = cfg().fontOrig || {};
      if (on) {
        if (!f.cjkSet) throw new Error(`${f.skinName} has no fontset built on Kodi's Arial font, so it can't show Korean or Japanese letters`);
        if (f.font === f.cjkSet) return `${f.skinName} already uses its ${f.cjkSet} font`;
        if (!(f.skin in orig)) orig[f.skin] = f.font;
        saveCfg();
        await rpc('Settings.SetSettingValue', { setting: 'lookandfeel.font', value: f.cjkSet });
        return `${f.skinName} now uses its "${f.cjkSet}" font, which has Korean, Japanese and Chinese letters. Kodi reloads the skin.`;
      }
      const back = f.skin in orig ? orig[f.skin] : 'Default';
      await rpc('Settings.SetSettingValue', { setting: 'lookandfeel.font', value: back });
      delete orig[f.skin]; saveCfg();
      return `${f.skinName} font put back to "${back}"`;
    },
  };
}

module.exports = { make, CJK };
