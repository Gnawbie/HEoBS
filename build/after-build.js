// After a build: keep the installer, delete the rest of the build output.
// The unpacked copy and other intermediate files in dist/ come to roughly
// 480 MB and are recreated by the next build anyway.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const built = path.join(root, 'dist', 'HEoBS_Setup.exe');
if (!fs.existsSync(built)) { console.error('after-build: installer not found, leaving dist/ alone.'); process.exit(1); }
fs.copyFileSync(built, path.join(root, 'HEoBS_Setup.exe'));
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
console.log('after-build: HEoBS_Setup.exe is in the project folder; dist/ removed.');
