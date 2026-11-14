// Error log for the test build.
//
// The test build is the same program as HEoBS; logging switches on when it
// is started with --test (the "HEoBS Test" shortcut does this), when the exe
// has "_Test" in its name, or when HEOBS_TEST=1 is set. Every error is
// appended to HEoBS_Test.log in HEoBS's data folder (%APPDATA%\HEoBS). The log stays on this PC. It can contain
// addresses of pages you had open, so read it before sharing it.
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const launchedFrom = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const enabled = process.argv.includes('--test') || /_test/i.test(path.basename(launchedFrom)) || process.env.HEOBS_TEST === '1';
const logFile = path.join(
  process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? app.getPath('userData') : process.cwd()),
  'HEoBS_Test.log',
);

let count = 0;

function write(kind, ...parts) {
  if (!enabled) return;
  const text = parts
    .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} [${kind}] ${text}\n`); } catch { /* folder not writable */ }
}

function error(kind, ...parts) {
  count++;
  write(kind, ...parts);
}

function attach(wc) {
  const where = () => { try { return wc.getURL() || '(blank)'; } catch { return '(closed)'; } };

  // Errors printed to a page's console (browser UI, heobs:// pages and websites).
  wc.on('console-message', (ev, level, message, line, source) => {
    const modern = typeof ev.level === 'string';
    const isError = modern ? ev.level === 'error' : level === 3;
    if (!isError) return;
    const msg = modern ? ev.message : message;
    const src = modern ? `${ev.sourceId}:${ev.lineNumber}` : `${source}:${line}`;
    if (/^Electron Security Warning/.test(msg)) return;
    error('console', msg, '| at', src, '| page', where());
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (code === -3) return; // navigation cancelled by the user
    error('load-failed', `${desc} (${code})`, url, isMainFrame ? '' : '(sub-frame)');
  });
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') error('tab-crashed', d.reason, 'exit code', d.exitCode, '| page', where());
  });
  wc.on('preload-error', (_e, preloadPath, err) => error('preload', preloadPath, err));
  wc.on('unresponsive', () => error('unresponsive', where()));
  wc.on('certificate-error', (_e, url, err) => error('certificate', err, url));
}

function init() {
  if (!enabled) return;
  write('start', '----------------------------------------------------------------');
  write('start', `HEoBS ${app.getVersion()} test build | Electron ${process.versions.electron} | Chromium ${process.versions.chrome} | ${process.platform} ${process.getSystemVersion()}`);

  process.on('uncaughtException', (err) => {
    error('crash', err);
    try { dialog.showErrorBox('HEoBS error (logged)', `${err.stack || err}\n\nSaved to ${logFile}`); } catch { /* not ready */ }
  });
  process.on('unhandledRejection', (reason) => error('unhandled-rejection', reason));

  const original = console.error;
  console.error = (...args) => { error('main', ...args); original(...args); };

  app.on('web-contents-created', (_e, wc) => attach(wc));
  app.on('child-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') error('process-gone', d.type, d.name || '', d.reason, 'exit code', d.exitCode);
  });
  app.on('quit', () => write('exit', `closed with ${count} error${count === 1 ? '' : 's'} logged`));
}

module.exports = { enabled, logFile, init, error };
