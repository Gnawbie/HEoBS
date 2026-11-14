// Import bookmarks and passwords from other browsers.
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- bookmarks

function chromiumRoots() {
  const L = process.env.LOCALAPPDATA || '';
  const R = process.env.APPDATA || '';
  return [
    ['Google Chrome', path.join(L, 'Google', 'Chrome', 'User Data')],
    ['Microsoft Edge', path.join(L, 'Microsoft', 'Edge', 'User Data')],
    ['Brave', path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Vivaldi', path.join(L, 'Vivaldi', 'User Data')],
    ['Opera', path.join(R, 'Opera Software', 'Opera Stable')],
    ['Opera GX', path.join(R, 'Opera Software', 'Opera GX Stable')],
  ];
}

function countUrls(nodes) {
  return nodes.reduce((n, x) => n + (x.children ? countUrls(x.children) : 1), 0);
}

function convertChromium(node) {
  if (node.type === 'url') return { title: node.name || node.url, url: node.url };
  if (node.type === 'folder') return { title: node.name || 'Folder', children: (node.children || []).map(convertChromium).filter(Boolean) };
  return null;
}

function readChromiumBookmarks(file) {
  const roots = JSON.parse(fs.readFileSync(file, 'utf8')).roots || {};
  const kids = (r) => ((r && r.children) || []).map(convertChromium).filter(Boolean);
  const other = kids(roots.other);
  const mobile = kids(roots.synced);
  if (mobile.length) other.push({ title: 'Mobile bookmarks', children: mobile });
  return { bar: kids(roots.bookmark_bar), other };
}

/** Browsers found on this PC that we can read bookmarks from directly. */
function detectBrowsers() {
  const found = [];
  for (const [name, root] of chromiumRoots()) {
    let dirs = [];
    try {
      dirs = ['.', ...fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
        .map((d) => d.name)];
    } catch { continue; }
    for (const dir of dirs) {
      const file = path.join(root, dir, 'Bookmarks');
      try {
        const data = readChromiumBookmarks(file);
        found.push({
          id: `${name}|${dir}`,
          browser: name,
          profile: dir === '.' || dir === 'Default' ? '' : dir,
          bar: countUrls(data.bar),
          other: countUrls(data.other),
          file,
        });
      } catch { /* no bookmarks in this profile */ }
    }
  }
  return found;
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|apos);/g, (_m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", apos: "'" }[e]));
}

/** Parses the "bookmarks.html" export every browser (incl. Firefox, Safari) can produce. */
function parseBookmarksHtml(html) {
  const result = { bar: [], other: [] };
  const stack = [result.other];
  let pending = null; // folder whose <DL> has not opened yet
  const re = /<DT>\s*<H3([^>]*)>([\s\S]*?)<\/H3>|<DT>\s*<A([^>]*)>([\s\S]*?)<\/A>|<DL>|<\/DL>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0].slice(0, 4).toUpperCase();
    if (m[2] !== undefined && m[1] !== undefined) {
      const isBar = /PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i.test(m[1]);
      if (isBar) pending = result.bar;
      else {
        const folder = { title: decodeEntities(m[2].replace(/<[^>]+>/g, '').trim()) || 'Folder', children: [] };
        stack[stack.length - 1].push(folder);
        pending = folder.children;
      }
    } else if (m[3] !== undefined) {
      const href = /HREF\s*=\s*"([^"]*)"/i.exec(m[3]);
      if (href) {
        const url = decodeEntities(href[1]);
        stack[stack.length - 1].push({ title: decodeEntities(m[4].replace(/<[^>]+>/g, '').trim()) || url, url });
      }
    } else if (tag === '<DL>') {
      stack.push(pending || stack[stack.length - 1]);
      pending = null;
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return result;
}

// ---------------------------------------------------------------- passwords

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/**
 * Parses a password export (.csv) from Chrome, Edge, Brave, Firefox, Opera,
 * Bitwarden, 1Password, LastPass… Returns [{ origin, username, password }].
 */
function parsePasswordCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iUrl = col('url', 'origin', 'login_uri', 'website', 'web site', 'hostname', 'login url');
  const iUser = col('username', 'login_username', 'user', 'login', 'user name', 'email');
  const iPass = col('password', 'login_password', 'pass');
  if (iUrl < 0 || iPass < 0) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const password = r[iPass] || '';
    let raw = (r[iUrl] || '').trim();
    if (!password || !raw) continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
    let origin;
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) continue;
      origin = u.origin;
    } catch { continue; }
    out.push({ origin, username: iUser >= 0 ? (r[iUser] || '') : '', password });
  }
  return out;
}

module.exports = { detectBrowsers, readChromiumBookmarks, parseBookmarksHtml, parsePasswordCsv, countUrls };
