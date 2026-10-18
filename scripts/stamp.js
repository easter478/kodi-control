// npm run dist runs this first: records when and from which commit this exe was built, for Help → Check for updates
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
let commit = '';
try { commit = execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch {}
fs.writeFileSync(path.join(__dirname, '..', 'app', 'build.json'), JSON.stringify({ built: new Date().toISOString(), commit, version: require('../package.json').version }));
