// Help → Check for updates: compares this KodiControl.exe with the one on the GitHub release.
// GitHub gives every release file a sha256 digest, so "newer" means "a different file is published", whatever the version number.
// Install = download next to this exe, then a small batch file swaps it in once this copy has closed, and starts it again.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');

const REPO = 'easter478/kodi-control', ASSET = 'KodiControl.exe';
const API = `https://api.github.com/repos/${REPO}`;
const gh = (url, ms = 15000) => fetch(url, { headers: { 'User-Agent': 'KodiControl', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(ms) })
  .then(async r => { if (!r.ok) throw new Error(r.status === 404 ? 'No release on GitHub yet' : r.status === 403 ? 'GitHub says to try again later (rate limit)' : `GitHub answered ${r.status}`); return r.json(); });

function make({ app, send }) {
  // the portable launcher unpacks to a temp folder; the real .exe the user double-clicked is in PORTABLE_EXECUTABLE_FILE
  const exe = () => process.env.PORTABLE_EXECUTABLE_FILE || '';
  let build = {};
  try { build = JSON.parse(fs.readFileSync(path.join(__dirname, 'build.json'), 'utf8')); } catch {}
  const hash = f => new Promise((ok, bad) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('error', bad).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))); });
  let found = null, downloaded = '';

  async function check() {
    const rel = await gh(`${API}/releases/latest`);
    const a = (rel.assets || []).find(x => x.name === ASSET);
    if (!a) throw new Error(`The latest release has no ${ASSET}`);
    const theirs = (a.digest || '').replace(/^sha256:/, '');
    const mine = exe() && fs.existsSync(exe()) ? await hash(exe()) : '';
    let same;
    // a different file that GitHub got before this exe was built is older, not an update
    const older = !!build.built && Date.parse(a.updated_at) < Date.parse(build.built);
    if (mine && theirs) same = mine === theirs || older;
    else if (build.built) same = Date.parse(a.updated_at) - Date.parse(build.built) < 45 * 60000; // no digest: published within 45 min of this build
    else same = null; // running from source: can't tell
    let commits = [];
    try {
      const c = build.commit ? await gh(`${API}/compare/${build.commit}...${rel.target_commitish || 'main'}`) : null;
      commits = (c ? c.commits.reverse() : await gh(`${API}/commits?per_page=8`)).slice(0, 8)
        .map(x => ({ msg: x.commit.message.split('\n')[0], when: x.commit.committer.date, sha: x.sha.slice(0, 7) }));
    } catch {}
    found = { url: a.browser_download_url, size: a.size, digest: theirs };
    return { upToDate: same, ahead: !!(mine && theirs && mine !== theirs && older), published: a.updated_at, size: a.size, page: rel.html_url, tag: rel.tag_name, commits: same ? [] : commits,
      canInstall: !!exe(), built: build.built || '', commit: build.commit || '', mine: mine.slice(0, 12), theirs: theirs.slice(0, 12) };
  }

  async function download() {
    if (!found) await check();
    const dir = exe() ? path.dirname(exe()) : app.getPath('downloads');
    const out = path.join(dir, exe() ? 'KodiControl.update.exe' : ASSET), tmp = out + '.part';
    const r = await fetch(found.url, { headers: { 'User-Agent': 'KodiControl' }, signal: AbortSignal.timeout(30 * 60000) });
    if (!r.ok || !r.body) throw new Error(`Download failed (${r.status})`);
    const total = +r.headers.get('content-length') || found.size;
    const f = fs.createWriteStream(tmp), h = crypto.createHash('sha256');
    let got = 0, lastSent = 0;
    for await (const chunk of r.body) {
      h.update(chunk); got += chunk.length;
      if (!f.write(chunk)) await new Promise(ok => f.once('drain', ok));
      if (Date.now() - lastSent > 250) { lastSent = Date.now(); send({ op: 'update', got, total }); }
    }
    await new Promise((ok, bad) => f.end(err => err ? bad(err) : ok()));
    const d = h.digest('hex');
    if (found.digest && d !== found.digest) { fs.rmSync(tmp, { force: true }); throw new Error('The download did not match GitHub\'s checksum, so it was thrown away'); }
    fs.renameSync(tmp, out);
    send({ op: 'update', got: total, total });
    downloaded = out;
    return { file: out, canInstall: !!exe() };
  }

  // swap the files once this copy has quit (Windows keeps a running .exe locked), then start the new one
  function install() {
    if (!downloaded || !exe()) throw new Error('Download the update first');
    const bat = path.join(app.getPath('temp'), 'kodicontrol-update.cmd');
    fs.writeFileSync(bat, [
      '@echo off',
      'for /l %%i in (1,1,60) do (',
      `  move /y "${downloaded}" "${exe()}" >nul 2>&1 && goto done`,
      '  ping -n 2 127.0.0.1 >nul',
      ')',
      ':done',
      `start "" "${exe()}"`,
      'del "%~f0"',
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.quit(), 300);
    return true;
  }

  return { 'update:check': check, 'update:download': download, 'update:install': install, 'update:info': () => ({ build, exe: exe() }) };
}

module.exports = { make };
