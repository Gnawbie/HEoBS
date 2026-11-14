const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, session,
  protocol, net, dialog, clipboard, shell, safeStorage, crashReporter,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { Vault } = require('./vault');
const hello = require('./hello');
const { Privacy, hostOf, LIST_HOST } = require('./privacy');
const { Addons } = require('./addons');
const importer = require('./importer');

app.setName('HEoBS');

const NEWTAB = 'heobs://newtab/';
const HISTORY_URL = 'heobs://history/';
const SETTINGS_URL = 'heobs://settings/';
const PASSWORDS_URL = 'heobs://passwords/';
const PAGES_DIR = path.join(__dirname, 'pages');
const HISTORY_LIMIT = 5000;

// `note` is shown in Settings > Upfront so the choice is an informed one.
const ENGINES = [
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', note: 'Says it does not track or profile searches.' },
  { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', note: 'Says it does not track or profile searches.' },
  { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', note: 'Google results fetched anonymously; says it does not log searches.' },
  { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', note: 'Ad-funded; shares search data with its results partner.' },
  { name: 'Google', url: 'https://www.google.com/search?q=%s', note: 'Tracks searches and links them to your Google account or cookies for ad profiling.' },
  { name: 'Bing', url: 'https://www.bing.com/search?q=%s', note: 'Tracks searches and links them to your Microsoft account or cookies for ad profiling.' },
];

const DEFAULT_SETTINGS = {
  searchUrl: ENGINES[0].url,
  blockTrackers: true,
  blockAddonTrackers: true,
  blockThirdPartyCookies: true,
  stripTrackingParams: true,
  sendDoNotTrack: true,
  autoUpdateBlocklist: true,
  safeBrowsing: true,
  spellcheck: true,
  crashReports: true,
  addons: [],
};
const BOOLEAN_SETTINGS = ['blockTrackers', 'blockAddonTrackers', 'blockThirdPartyCookies', 'stripTrackingParams', 'sendDoNotTrack', 'autoUpdateBlocklist', 'safeBrowsing', 'spellcheck', 'crashReports'];

protocol.registerSchemesAsPrivileged([
  { scheme: 'heobs', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------------------------------------------------------------- storage

class Store {
  constructor(name, fallback) {
    this.file = path.join(app.getPath('userData'), name);
    this.data = fallback;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.timer = null;
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }
  flush() {
    clearTimeout(this.timer);
    try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (err) { console.error(err); }
  }
}

let settings;    // see DEFAULT_SETTINGS
let bookmarks;   // { bar: [node], other: [node] }; node = { title, url, favicon? } | { title, children }
let history;     // [{ url, title, time }] newest first
let lastSession; // { urls: [] }
let vault;
let privacy;
let addons;

// ---------------------------------------------------------------- helpers

function searchURL(query) {
  return settings.data.searchUrl.replace('%s', encodeURIComponent(query));
}

function toURL(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^(https?|file|heobs|view-source:https?):\/\//i.test(s) || /^about:blank$/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s)) return 'https://' + s;
  return searchURL(s);
}

function displayURL(url) {
  if (!url || url.startsWith(NEWTAB)) return '';
  if (url.startsWith('heobs://error/') || url.startsWith('heobs://blocked/')) {
    try { return new URL(url).searchParams.get('url') || ''; } catch { return ''; }
  }
  return url;
}

function isInternal(url) {
  return typeof url === 'string' && url.startsWith('heobs://');
}

/** Origin we are willing to save / fill passwords for, or null. */
function credentialOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return u.origin;
  } catch { /* not a URL */ }
  return null;
}

const menuLabel = (s) => {
  const t = String(s || '').replace(/&/g, '&&');
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
};

// ---- bookmark tree

function walkBookmarks(nodes, fn) {
  for (const n of nodes) { if (n.children) walkBookmarks(n.children, fn); else fn(n); }
}

function allBookmarks() {
  const out = [];
  walkBookmarks(bookmarks.data.bar, (n) => out.push(n));
  walkBookmarks(bookmarks.data.other, (n) => out.push(n));
  return out;
}

function removeBookmarkUrl(nodes, url) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].children) removeBookmarkUrl(nodes[i].children, url);
    else if (nodes[i].url === url) nodes.splice(i, 1);
  }
}

/** Merges imported nodes into dst, skipping duplicates. Returns how many links were added. */
function mergeBookmarks(dst, src) {
  let added = 0;
  for (const n of src) {
    if (n.children) {
      let folder = dst.find((d) => d.children && d.title === n.title);
      if (!folder) { folder = { title: String(n.title || 'Folder'), children: [] }; dst.push(folder); }
      added += mergeBookmarks(folder.children, n.children);
    } else if (/^(https?|file):/i.test(n.url || '') && !dst.some((d) => d.url === n.url)) {
      dst.push({ title: String(n.title || n.url), url: n.url });
      added++;
    }
  }
  return added;
}

function importBookmarks(data) {
  const added = mergeBookmarks(bookmarks.data.bar, data.bar) + mergeBookmarks(bookmarks.data.other, data.other);
  bookmarks.save();
  broadcastState();
  return added;
}

const wins = new Map(); // chrome webContents id -> BrowserWin

function tabFor(wc) {
  for (const bw of wins.values()) {
    const tab = bw.tabs.find((t) => t.view.webContents === wc);
    if (tab) return { bw, tab };
  }
  return null;
}

function focusedWin() {
  const w = BrowserWindow.getFocusedWindow();
  return (w && wins.get(w.webContents.id)) || [...wins.values()][0] || null;
}

// ---------------------------------------------------------------- window

let nextTabId = 1;

class BrowserWin {
  constructor(urls) {
    this.tabs = [];
    this.activeId = null;
    this.shown = null; // tab whose page is currently on screen
    this.chromeHeight = 84;
    this.closedUrls = [];
    this.pendingCred = null;
    this.statePending = false;

    this.win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 560,
      minHeight: 320,
      title: 'HEoBS',
      backgroundColor: '#1b1d23',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#1b1d23', symbolColor: '#c9ccd3', height: 40 },
      webPreferences: {
        preload: path.join(__dirname, 'chrome-preload.js'),
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.chromeId = this.win.webContents.id;
    wins.set(this.chromeId, this);

    this.win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    this.win.webContents.on('did-finish-load', () => this.sendState());
    // The browser's own UI must never navigate away or open windows itself.
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      this.win.on(ev, () => this.layout());
    }
    this.win.on('close', () => {
      const urls = this.tabs.map((t) => t.view.webContents.getURL()).filter((u) => u && !/^heobs:\/\/(error|blocked)\//.test(u));
      lastSession.data = { urls };
      lastSession.flush();
    });
    this.win.on('closed', () => {
      wins.delete(this.chromeId);
      for (const t of this.tabs) t.view.webContents.close();
      this.tabs = [];
    });

    const list = urls && urls.length ? urls : [NEWTAB];
    list.forEach((u, i) => this.newTab(u, { activate: i === list.length - 1 }));
  }

  get active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  /** webContents of the active tab, or null while it is still an empty new tab. */
  get nav() {
    const t = this.active;
    return t && !t.blank ? t.view.webContents : null;
  }

  // ---- tabs

  /**
   * Opens a tab. With no URL it opens an *empty* tab: only the address bar
   * changes, and the page you were on stays visible underneath so you can
   * still read and copy from it while typing the new address or search.
   */
  newTab(url = null, { activate = true, after = null } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'internal-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.webContents.setWebRTCIPHandlingPolicy('default_public_interface_only');
    const tab = { id: nextTabId++, view, favicon: null, fullscreen: false, blank: false, peek: null, blocked: new Map(), userHint: null };

    const current = this.active;
    if (!url && current) {
      tab.blank = true;
      tab.peek = current.blank ? current.peek : current;
    }
    const idx = after ? this.tabs.indexOf(after) + 1 : this.tabs.length;
    this.tabs.splice(idx, 0, tab);
    this.wire(tab);
    if (!tab.blank) view.webContents.loadURL(url || NEWTAB).catch(() => {});
    if (activate) this.select(tab.id);
    else this.sendState();
    return tab;
  }

  openInternal(url) {
    const existing = this.tabs.find((t) => t.view.webContents.getURL() === url);
    if (existing) this.select(existing.id);
    else this.newTab(url);
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const update = () => this.sendState();

    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('page-title-updated', (_e, title) => {
      const entry = history.data.find((h) => h.url === wc.getURL());
      if (entry && entry.title !== title) { entry.title = title; history.save(); }
      update();
    });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || null; update(); });
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { tab.favicon = null; tab.blocked = new Map(); }
    });
    wc.on('did-navigate', (_e, url) => { this.recordVisit(wc, url); update(); });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) { this.recordVisit(wc, url); update(); }
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || code === -20 || isInternal(url)) return;
      const q = new URLSearchParams({ url, desc, code: String(code) });
      wc.loadURL('heobs://error/?' + q).catch(() => {});
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^(https?|heobs|about):/i.test(url)) {
        this.newTab(url, { activate: disposition !== 'background-tab', after: tab });
      }
      return { action: 'deny' };
    });

    wc.on('enter-html-full-screen', () => { tab.fullscreen = true; this.layout(); });
    wc.on('leave-html-full-screen', () => { tab.fullscreen = false; this.layout(); });

    wc.on('found-in-page', (_e, r) => {
      if (tab === this.shown) this.sendChrome('find-result', { current: r.activeMatchOrdinal, total: r.matches });
    });

    wc.on('render-process-gone', (_e, details) => {
      if (['clean-exit', 'killed'].includes(details.reason)) return;
      logCrash('Tab', details.reason, details.exitCode);
    });

    wc.on('context-menu', (_e, p) => this.pageMenu(tab, p));
  }

  recordVisit(wc, url) {
    if (!/^https?:/i.test(url)) return;
    const top = history.data[0];
    if (top && top.url === url) { top.time = Date.now(); }
    else history.data.unshift({ url, title: wc.getTitle() || url, time: Date.now() });
    if (history.data.length > HISTORY_LIMIT) history.data.length = HISTORY_LIMIT;
    history.save();
  }

  /** The tab whose page should be on screen for `tab` (its own, or the one it peeks at). */
  pageTabFor(tab) {
    if (!tab.blank) return tab;
    if (tab.peek && this.tabs.includes(tab.peek) && !tab.peek.blank) return tab.peek;
    // The page it was peeking at is gone: fall back to the start page.
    tab.blank = false;
    tab.peek = null;
    tab.view.webContents.loadURL(NEWTAB).catch(() => {});
    return tab;
  }

  select(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    const next = this.pageTabFor(tab);
    if (this.shown !== next) {
      if (this.shown) {
        this.shown.view.webContents.stopFindInPage('clearSelection');
        this.win.contentView.removeChildView(this.shown.view);
      }
      this.shown = next;
      this.win.contentView.addChildView(next.view);
    }
    this.layout();
    if (tab.blank || tab.view.webContents.getURL() === NEWTAB || !tab.view.webContents.getURL()) this.focusAddress();
    else tab.view.webContents.focus();
    this.sendState();
  }

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [tab] = this.tabs.splice(idx, 1);
    const url = tab.view.webContents.getURL();
    if (url && !isInternal(url)) this.closedUrls.push(url);
    if (this.shown === tab) {
      this.win.contentView.removeChildView(tab.view);
      this.shown = null;
    }
    tab.view.webContents.close();
    if (!this.tabs.length) { this.win.close(); return; }
    const nextId = this.activeId === id ? this.tabs[Math.min(idx, this.tabs.length - 1)].id : this.activeId;
    this.select(nextId);
  }

  reopenClosed() {
    const url = this.closedUrls.pop();
    if (url) this.newTab(url);
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.select(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  // ---- navigation

  navigate(text) {
    const url = toURL(text);
    const tab = this.active;
    if (!url || !tab) return;
    const wasBlank = tab.blank;
    tab.blank = false;
    tab.peek = null;
    tab.view.webContents.loadURL(url).catch(() => {});
    if (wasBlank) this.select(tab.id);
    tab.view.webContents.focus();
  }

  back() { const h = this.nav?.navigationHistory; if (h?.canGoBack()) h.goBack(); }
  forward() { const h = this.nav?.navigationHistory; if (h?.canGoForward()) h.goForward(); }
  stop() { this.nav?.stop(); }

  reload(hard = false) {
    const wc = this.nav;
    if (!wc) return;
    const url = wc.getURL();
    if (url.startsWith('heobs://error/')) {
      const original = displayURL(url);
      if (original) wc.loadURL(original).catch(() => {});
    } else if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  }

  zoom(delta) {
    const wc = this.shown?.view.webContents;
    if (!wc) return;
    wc.setZoomLevel(delta === 0 ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + delta)));
  }

  // ---- bookmarks

  toggleBookmark() {
    const wc = this.nav;
    if (!wc) return;
    const url = wc.getURL();
    if (!/^(https?|file):/i.test(url)) return;
    if (allBookmarks().some((b) => b.url === url)) {
      removeBookmarkUrl(bookmarks.data.bar, url);
      removeBookmarkUrl(bookmarks.data.other, url);
    } else {
      bookmarks.data.bar.push({ url, title: wc.getTitle() || url, favicon: this.active.favicon });
    }
    bookmarks.save();
    broadcastState();
  }

  bookmarkNodesToMenu(nodes) {
    if (!nodes.length) return [{ label: '(empty)', enabled: false }];
    return nodes.map((n) => (n.children
      ? { label: menuLabel(n.title) || 'Folder', submenu: this.bookmarkNodesToMenu(n.children) }
      : { label: menuLabel(n.title || n.url), click: (_i, _w, ev) => (ev.ctrlKey ? this.newTab(n.url, { activate: false }) : this.navigate(n.url)) }));
  }

  /** Dropdown for a folder on the bar, the overflow chevron, or "Other bookmarks". */
  bookmarkDropdown(kind, index) {
    const bar = bookmarks.data.bar;
    let nodes;
    if (kind === 'folder') nodes = bar[index]?.children;
    else if (kind === 'overflow') nodes = bar.slice(Math.max(0, index | 0));
    else nodes = bookmarks.data.other;
    if (nodes) Menu.buildFromTemplate(this.bookmarkNodesToMenu(nodes)).popup({ window: this.win });
  }

  bookmarkMenu(index) {
    const bar = bookmarks.data.bar;
    const node = bar[index];
    if (!node) return;
    const remove = () => { bar.splice(bar.indexOf(node), 1); bookmarks.save(); broadcastState(); };
    const template = node.children
      ? [{ label: 'Remove folder', click: remove }]
      : [
        { label: 'Open in new tab', click: () => this.newTab(node.url) },
        { label: 'Copy address', click: () => clipboard.writeText(node.url) },
        { type: 'separator' },
        { label: 'Remove bookmark', click: remove },
      ];
    Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  // ---- passwords

  offerPassword(tab, origin, username, password) {
    if (vault.locked) return;
    const existing = vault.find(origin).find((e) => e.username === username);
    if (existing && existing.password === password) return;
    this.pendingCred = { origin, username, password };
    this.sendChrome('pw-prompt', { host: hostOf(origin), username, update: !!existing });
  }

  resolvePassword(save) {
    const c = this.pendingCred;
    this.pendingCred = null;
    if (save && c && !vault.locked) vault.save(c);
  }

  // ---- chrome plumbing

  focusAddress() {
    this.win.webContents.focus();
    this.sendChrome('focus-address');
  }

  openFind() {
    this.win.webContents.focus();
    this.sendChrome('open-find');
  }

  find(text, forward, findNext) {
    const wc = this.shown?.view.webContents;
    if (!wc) return;
    if (!text) { wc.stopFindInPage('clearSelection'); this.sendChrome('find-result', { current: 0, total: 0 }); return; }
    wc.findInPage(text, { forward, findNext });
  }

  stopFind() {
    const wc = this.shown?.view.webContents;
    if (!wc) return;
    wc.stopFindInPage('keepSelection');
    wc.focus();
  }

  layout() {
    const tab = this.shown;
    if (!tab || this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    const top = tab.fullscreen ? 0 : this.chromeHeight;
    tab.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  }

  sendChrome(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  sendState() {
    if (this.statePending) return;
    this.statePending = true;
    setImmediate(() => {
      this.statePending = false;
      if (this.win.isDestroyed()) return;
      const active = this.active;
      const wc = this.nav;
      const url = wc ? wc.getURL() : '';
      const blocked = active && !active.blank ? active.blocked : new Map();
      this.sendChrome('state', {
        tabs: this.tabs.map((t) => {
          const c = t.view.webContents;
          const u = c.getURL();
          return {
            id: t.id,
            title: t.blank || u.startsWith(NEWTAB) ? 'New Tab' : c.getTitle() || displayURL(u) || 'Loading…',
            favicon: isInternal(u) ? null : t.favicon,
            loading: !t.blank && c.isLoading(),
          };
        }),
        activeId: this.activeId,
        blank: !!active?.blank,
        url: displayURL(url),
        canGoBack: !!wc?.navigationHistory.canGoBack(),
        canGoForward: !!wc?.navigationHistory.canGoForward(),
        loading: !!wc?.isLoading(),
        bookmarked: !!url && allBookmarks().some((b) => b.url === url),
        bookmarks: bookmarks.data.bar.map((n) => ({ title: n.title, url: n.url, favicon: n.favicon, folder: !!n.children })),
        hasOtherBookmarks: bookmarks.data.other.length > 0,
        blocked: [...blocked.values()].reduce((a, b) => a + b, 0),
        shieldOn: settings.data.blockTrackers,
        vaultLocked: vault.locked,
      });
    });
  }

  // ---- menus

  shieldMenu() {
    const tab = this.active;
    const hosts = tab && !tab.blank ? [...tab.blocked].sort((a, b) => b[1] - a[1]) : [];
    const total = hosts.reduce((a, [, n]) => a + n, 0);
    const head = !settings.data.blockTrackers
      ? 'Tracker blocking is turned off'
      : total ? `${total} tracker request${total === 1 ? '' : 's'} blocked on this page` : 'No trackers blocked on this page';
    Menu.buildFromTemplate([
      { label: head, enabled: false },
      ...hosts.slice(0, 20).map(([h, n]) => ({ label: menuLabel(`${h}  ×${n}`), enabled: false })),
      { type: 'separator' },
      { label: 'Privacy settings', click: () => this.openInternal(SETTINGS_URL) },
    ]).popup({ window: this.win });
  }

  pageMenu(tab, p) {
    const wc = tab.view.webContents;
    const t = [];
    if (p.linkURL) {
      t.push(
        { label: 'Open link in new tab', click: () => this.newTab(p.linkURL, { activate: false, after: tab }) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      t.push(
        { label: 'Open image in new tab', click: () => this.newTab(p.srcURL, { after: tab }) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.misspelledWord) {
      for (const word of p.dictionarySuggestions.slice(0, 6)) {
        t.push({ label: menuLabel(word), click: () => wc.replaceMisspelling(word) });
      }
      if (!p.dictionarySuggestions.length) t.push({ label: 'No spelling suggestions', enabled: false });
      t.push(
        { label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      t.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    } else if (p.selectionText.trim()) {
      const sel = p.selectionText.trim();
      const short = sel.length > 30 ? sel.slice(0, 30) + '…' : sel;
      t.push(
        { role: 'copy' },
        { label: menuLabel(`Search for “${short}”`), click: () => this.newTab(searchURL(sel), { after: tab }) },
        { type: 'separator' },
      );
    }
    const nav = wc.navigationHistory;
    t.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'View page source', click: () => this.newTab('view-source:' + wc.getURL(), { after: tab }) },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(t).popup({ window: this.win });
  }

  appMenu() {
    const k = (label, accelerator, click, extra = {}) => ({ label, accelerator, registerAccelerator: false, click, ...extra });
    Menu.buildFromTemplate([
      k('New tab', 'Ctrl+T', () => this.newTab()),
      k('New window', 'Ctrl+N', () => new BrowserWin()),
      k('Reopen closed tab', 'Ctrl+Shift+T', () => this.reopenClosed(), { enabled: this.closedUrls.length > 0 }),
      { type: 'separator' },
      k('History', 'Ctrl+H', () => this.openInternal(HISTORY_URL)),
      { label: 'Passwords', click: () => this.openInternal(PASSWORDS_URL) },
      { label: 'Settings', click: () => this.openInternal(SETTINGS_URL) },
      { type: 'separator' },
      k('Find in page…', 'Ctrl+F', () => this.openFind()),
      k('Zoom in', 'Ctrl+Plus', () => this.zoom(0.5)),
      k('Zoom out', 'Ctrl+-', () => this.zoom(-0.5)),
      k('Reset zoom', 'Ctrl+0', () => this.zoom(0)),
      { type: 'separator' },
      k('Developer tools', 'F12', () => this.shown?.view.webContents.toggleDevTools()),
      { label: 'Clear browsing data…', click: () => clearBrowsingData(this) },
      { type: 'separator' },
      { label: 'Exit', click: () => app.quit() },
    ]).popup({ window: this.win });
  }
}

function broadcastState() {
  for (const bw of wins.values()) bw.sendState();
}

async function clearBrowsingData(bw) {
  const { response } = await dialog.showMessageBox(bw.win, {
    type: 'warning',
    buttons: ['Clear', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Clear browsing data?',
    detail: 'This removes history, cookies, cache and site storage. You will be signed out of websites. Bookmarks and saved passwords are kept.',
  });
  if (response !== 0) return;
  history.data = [];
  history.flush();
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
}

// ---------------------------------------------------------------- crash reports

let crashLog; // [{ time, what, reason, code }]
let crashReportsActive = false;

function logCrash(what, reason, code) {
  if (!settings.data.crashReports) return;
  crashLog.data.unshift({ time: Date.now(), what, reason: String(reason), code });
  crashLog.data.length = Math.min(crashLog.data.length, 200);
  crashLog.save();
}

function listCrashDumps() {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
      else if (e.name.endsWith('.dmp')) out.push(p);
    }
  };
  walk(app.getPath('crashDumps'), 0);
  return out;
}

// ---------------------------------------------------------------- IPC: browser UI

const chromeCommands = {
  newTab: (bw) => bw.newTab(),
  closeTab: (bw, id) => bw.closeTab(id),
  selectTab: (bw, id) => bw.select(id),
  navigate: (bw, text) => bw.navigate(text),
  back: (bw) => bw.back(),
  forward: (bw) => bw.forward(),
  reload: (bw) => bw.reload(),
  stop: (bw) => bw.stop(),
  toggleBookmark: (bw) => bw.toggleBookmark(),
  openBookmark: (bw, index, inNewTab) => {
    const node = bookmarks.data.bar[index];
    if (!node || !node.url) return;
    if (inNewTab) bw.newTab(node.url, { activate: false }); else bw.navigate(node.url);
  },
  bookmarkMenu: (bw, index) => bw.bookmarkMenu(index),
  bookmarkDropdown: (bw, kind, index) => bw.bookmarkDropdown(kind, index),
  appMenu: (bw) => bw.appMenu(),
  shieldMenu: (bw) => bw.shieldMenu(),
  openPasswords: (bw) => bw.openInternal(PASSWORDS_URL),
  passwordAnswer: (bw, save) => bw.resolvePassword(!!save),
  find: (bw, text, forward, findNext) => bw.find(String(text || ''), !!forward, !!findNext),
  stopFind: (bw) => bw.stopFind(),
  focusPage: (bw) => bw.shown?.view.webContents.focus(),
  showDownload: (_bw, file) => { if (typeof file === 'string' && file) shell.showItemInFolder(file); },
  chromeHeight: (bw, h) => {
    if (Number.isFinite(h) && h > 0 && h < 400) { bw.chromeHeight = Math.round(h); bw.layout(); }
  },
};

// ---------------------------------------------------------------- IPC: heobs:// pages

function upfrontReport() {
  const s = settings.data;
  const engineHost = hostOf(s.searchUrl.replace('%s', 'x'));
  const engine = ENGINES.find((e) => e.url === s.searchUrl);
  return {
    builtIn: 'None. HEoBS has no analytics, telemetry, crash reporting, advertising IDs, accounts or sync. Nothing about how you use it is sent to its authors or anyone else.',
    connections: [
      {
        who: engineHost,
        why: `Your search engine (${engine ? engine.name : 'custom'}). It receives what you type in the address bar when it is not a web address — only when you press Enter. Nothing is sent while you type.`,
        note: engine ? engine.note : 'Custom engine: HEoBS cannot vouch for how it treats your searches.',
        control: 'Change it under Search engine above.',
      },
      {
        who: LIST_HOST,
        why: 'Tracker blocklist update, at most once a week. A plain download with no cookies or identifiers; that server can see your IP address and that the request came from HEoBS.',
        note: s.autoUpdateBlocklist ? 'Currently ON.' : 'Currently OFF — the built-in list is used and never refreshed.',
        control: 'Toggle "Update the tracker blocklist weekly" under Trackers.',
      },
      {
        who: privacy.stats().threatHosts.join(', '),
        why: 'Safe browsing. Once a day HEoBS downloads lists of known phishing and malware sites and checks every address against them on this PC. Plain downloads with no cookies or identifiers; those servers can see your IP address, but never which sites you visit.',
        note: s.safeBrowsing ? `Currently ON — ${privacy.stats().threatSize.toLocaleString()} dangerous sites known.` : 'Currently OFF — no lists are downloaded and nothing is checked.',
        control: 'Toggle "Warn me about dangerous sites" under Trackers.',
      },
      {
        who: 'Google dictionary servers (redirector.gvt1.com / dl.google.com)',
        why: 'Spell-check. The first time spell-check needs a language, the Chromium engine downloads that dictionary file from Google. What you type is checked on this PC and is never sent. Google can see your IP address and which language was fetched.',
        note: s.spellcheck ? 'Currently ON.' : 'Currently OFF — no dictionary is downloaded.',
        control: 'Toggle "Check spelling as I type" under Trackers.',
      },
      {
        who: 'Websites you open',
        why: 'Pages you visit, plus their icons for the tab strip and bookmarks bar. Sites can still do their own first-party analytics; HEoBS blocks known third-party trackers, third-party cookies and tracking link parameters, but no blocker catches everything.',
        note: '',
        control: 'Trackers toggles above. The shield in the toolbar shows what was blocked on each page.',
      },
      {
        who: 'Add-ons you install',
        why: 'Add-ons are third-party code and can contact their own servers. HEoBS shows each add-on\'s permissions, every domain its code mentions, which of those are known trackers, and what it actually contacted — before install and afterwards.',
        note: `${(s.addons || []).length} installed.`,
        control: 'Trackers: "Auto-block trackers from add-ons". Add-ons section: turn any add-on off, or block just its trackers.',
      },
    ],
    absent: [
      'Search suggestions as you type — nothing is sent until you press Enter.',
      'Sending the addresses you visit to anyone for checking — safe browsing compares them against lists stored on this PC.',
      'Uploading crash reports — they are saved on this PC only (see Crash Reports).',
      'Usage statistics or telemetry of any kind.',
      'Cloud anything — HEoBS is an on-machine browser. Bookmarks, history and passwords exist only on this PC; there is no account and no sync.',
      'Silent updates — HEoBS does not check for updates yet. When it does, it will only tell you one is available and ask; it will never update itself.',
    ],
    engineNote: 'HEoBS is built on the Chromium engine through Electron, which ships without Google service keys. The list above covers everything HEoBS itself adds; it has not been independently audited.',
  };
}

function vaultStatus() {
  return hello.available().then((helloAvailable) => ({
    mode: vault.mode,
    locked: vault.locked,
    count: vault.locked ? null : vault.entries.length,
    helloAvailable,
  }));
}

let clipboardTimer = null;

const internalHandlers = {
  history: () => history.data,
  bookmarks: () => allBookmarks(),
  resolve: (_e, text) => toURL(text),
  removeHistory: (_e, url, time) => {
    history.data = history.data.filter((h) => !(h.url === url && h.time === time));
    history.save();
  },
  clearHistory: () => { history.data = []; history.save(); },

  // ---- settings
  'settings.get': async () => ({
    settings: settings.data,
    engines: ENGINES,
    privacy: privacy.stats(),
    upfront: upfrontReport(),
    addons: addons.list(),
    versions: { heobs: app.getVersion(), chromium: process.versions.chrome, electron: process.versions.electron },
  }),
  'settings.set': (_e, key, value) => {
    if (BOOLEAN_SETTINGS.includes(key)) {
      settings.data[key] = !!value;
      if (key === 'spellcheck') session.defaultSession.setSpellCheckerEnabled(!!value);
      if (key === 'safeBrowsing' && value) privacy.maybeUpdateThreats();
    }
    else if (key === 'searchUrl') {
      const v = String(value || '').trim();
      let ok = false;
      try { ok = /^https?:$/.test(new URL(v).protocol) && v.includes('%s'); } catch { /* invalid */ }
      if (!ok) throw new Error('A search address must start with https:// (or http://) and contain %s where the search words go.');
      settings.data.searchUrl = v;
    } else throw new Error('Unknown setting');
    settings.save();
    broadcastState();
  },

  // ---- safe browsing warning page
  'threat.proceed': (_e, url) => {
    const host = hostOf(String(url));
    if (host) privacy.threatAllowed.add(host.toLowerCase());
  },

  // ---- crash reports (kept on this PC, never uploaded)
  'crash.list': () => ({
    enabled: !!settings.data.crashReports,
    active: crashReportsActive,
    folder: app.getPath('crashDumps'),
    dumps: listCrashDumps().length,
    log: crashLog.data.slice(0, 50),
  }),
  'crash.openFolder': () => { fs.mkdirSync(app.getPath('crashDumps'), { recursive: true }); shell.openPath(app.getPath('crashDumps')); },
  'crash.clear': () => {
    for (const f of listCrashDumps()) { try { fs.unlinkSync(f); } catch { /* in use */ } }
    crashLog.data = [];
    crashLog.save();
  },

  // ---- import
  'import.detect': () => importer.detectBrowsers().map(({ file, ...rest }) => rest),
  'import.bookmarks': (_e, id) => {
    const src = importer.detectBrowsers().find((b) => b.id === id);
    if (!src) throw new Error('That browser profile was not found.');
    return importBookmarks(importer.readChromiumBookmarks(src.file));
  },
  'import.bookmarksHtml': async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || undefined, {
      title: 'Import bookmarks file',
      filters: [{ name: 'Bookmarks', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return importBookmarks(importer.parseBookmarksHtml(fs.readFileSync(r.filePaths[0], 'utf8')));
  },
  'import.passwordsCsv': async (e) => {
    if (vault.locked) throw new Error('Unlock your passwords first.');
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || undefined, {
      title: 'Import passwords (CSV export from another browser)',
      filters: [{ name: 'Password export', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const rows = importer.parsePasswordCsv(fs.readFileSync(r.filePaths[0], 'utf8'));
    let added = 0;
    for (const row of rows) if (vault.save(row, { persist: false })) added++;
    vault.persist();
    return { added, total: rows.length, file: r.filePaths[0] };
  },

  // ---- add-ons
  'addons.pick': async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const r = await dialog.showOpenDialog(parent, {
      title: 'Choose the add-on folder (the one containing manifest.json)',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('That folder has no manifest.json, so it is not an add-on.');
    return addons.inspect(dir);
  },
  // Only reachable after the page has shown the disclosure from addons.pick.
  'addons.install': async (_e, dir) => { await addons.install(String(dir)); },
  'addons.setEnabled': async (_e, dir, on) => { await addons.setEnabled(String(dir), !!on); },
  'addons.setBlockTrackers': (_e, dir, on) => addons.setBlockTrackers(String(dir), !!on),
  'addons.remove': (_e, dir) => addons.remove(String(dir)),

  // ---- password vault
  'vault.status': () => vaultStatus(),
  'vault.unlock': (_e, password) => {
    if (vault.mode !== 'master') return false;
    const ok = vault.unlockMaster(String(password || ''));
    if (ok) broadcastState();
    return ok;
  },
  'vault.unlockHello': async () => {
    if (vault.mode !== 'hello') return false;
    if (!(await hello.verify('HEoBS wants to unlock your saved passwords'))) return false;
    vault.unlockSealed();
    broadcastState();
    return true;
  },
  'vault.lock': () => { vault.lock(); broadcastState(); },
  'vault.setMode': async (_e, mode, password) => {
    if (mode === 'hello') {
      if (!(await hello.available())) throw new Error('Windows Hello is not set up on this PC. Add a PIN in Windows Settings > Accounts > Sign-in options.');
      if (!(await hello.verify('Confirm Windows Hello for HEoBS passwords'))) throw new Error('Windows Hello verification did not succeed, so nothing was changed.');
    }
    vault.setMode(mode, password);
    broadcastState();
  },
  'vault.list': () => {
    if (vault.locked) return null;
    return vault.entries
      .map(({ id, origin, username, created }) => ({ id, origin, username, created }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  },
  'vault.reveal': (_e, id) => (vault.locked ? null : vault.entries.find((x) => x.id === id)?.password ?? null),
  'vault.copy': (_e, id) => {
    const secret = vault.locked ? null : vault.entries.find((x) => x.id === id)?.password;
    if (!secret) return false;
    clipboard.writeText(secret);
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(() => { if (clipboard.readText() === secret) clipboard.clear(); }, 30000);
    return true;
  },
  'vault.remove': (_e, id) => { if (!vault.locked) vault.remove(String(id)); },
};

function registerIpc() {
  ipcMain.on('chrome', (e, cmd, ...args) => {
    const bw = wins.get(e.sender.id);
    if (!bw || !Object.hasOwn(chromeCommands, cmd)) return;
    chromeCommands[cmd](bw, ...args);
  });

  // heobs:// pages only; anything else calling this is refused.
  ipcMain.handle('heobs', (e, name, ...args) => {
    if (!isInternal(e.senderFrame?.url) || e.senderFrame.parent) throw new Error('forbidden');
    if (!Object.hasOwn(internalHandlers, name)) throw new Error('unknown call');
    return internalHandlers[name](e, ...args);
  });

  // ---- password capture / autofill, from the preload running in web pages.
  // The origin always comes from the frame itself, never from the message.
  const credContext = (e) => {
    const frame = e.senderFrame;
    if (!frame || frame.parent) return null; // top-level pages only
    const origin = credentialOrigin(frame.url);
    const found = tabFor(e.sender);
    return origin && found ? { origin, ...found } : null;
  };
  ipcMain.on('pw:hint', (e, username) => {
    const c = credContext(e);
    if (c && typeof username === 'string') c.tab.userHint = { origin: c.origin, username: username.slice(0, 300) };
  });
  ipcMain.on('pw:submit', (e, cred) => {
    const c = credContext(e);
    if (!c || typeof cred?.password !== 'string' || !cred.password || cred.password.length > 1000) return;
    let username = String(cred.username || '').slice(0, 300);
    if (!username && c.tab.userHint?.origin === c.origin) username = c.tab.userHint.username;
    c.bw.offerPassword(c.tab, c.origin, username, cred.password);
  });
  ipcMain.handle('pw:query', (e) => {
    const c = credContext(e);
    if (!c || vault.locked) return [];
    return vault.find(c.origin).map(({ username, password }) => ({ username, password }));
  });
}

// ---------------------------------------------------------------- session

function setupSession() {
  const ses = session.defaultSession;

  protocol.handle('heobs', (req) => {
    const u = new URL(req.url);
    const pages = { newtab: 'newtab.html', history: 'history.html', error: 'error.html', blocked: 'blocked.html', settings: 'settings.html', passwords: 'passwords.html' };
    const name = u.pathname === '/' ? pages[u.hostname] : path.basename(u.pathname);
    const file = name && path.join(PAGES_DIR, name);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  privacy = new Privacy({
    settings,
    userData: app.getPath('userData'),
    bundledList: path.join(__dirname, 'blocklist.txt'),
    fetch: (url, init) => net.fetch(url, init),
    onBlocked: (wc, host) => {
      const found = wc && tabFor(wc);
      if (!found) return;
      found.tab.blocked.set(host, (found.tab.blocked.get(host) || 0) + 1);
      found.bw.sendState();
    },
    onExtensionRequest: (extensionId, host) => addons.record(extensionId, host),
    onDangerous: (wc, url, kind) => {
      if (!wc || wc.isDestroyed() || !tabFor(wc)) return;
      const q = new URLSearchParams({ url, kind });
      setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL('heobs://blocked/?' + q).catch(() => {}); });
    },
  });
  ses.setSpellCheckerEnabled(!!settings.data.spellcheck);
  setTimeout(() => privacy.maybeUpdateThreats(), 5000);
  setInterval(() => privacy.maybeUpdateThreats(), 6 * 3600 * 1000);
  addons = new Addons({ ses, settings, isTracker: (h) => privacy.isListed(h) });
  privacy.attach(ses);
  setTimeout(() => privacy.maybeUpdate(), 30000);
  addons.loadSaved();

  const decided = new Map();
  ses.setPermissionRequestHandler(async (wc, permission, cb, details) => {
    if (['fullscreen', 'pointerLock', 'clipboard-sanitized-write'].includes(permission)) return cb(true);
    let origin = '';
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { return cb(false); }
    const key = origin + '|' + permission;
    if (decided.has(key)) return cb(decided.get(key));
    const found = tabFor(wc);
    if (!found) return cb(false);
    const { response } = await dialog.showMessageBox(found.bw.win, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      message: `${origin} wants permission: ${permission}`,
    });
    decided.set(key, response === 0);
    cb(response === 0);
  });

  ses.on('will-download', (_e, item, wc) => {
    const bw = tabFor(wc)?.bw || focusedWin();
    const send = (state) => bw?.sendChrome('download', {
      name: item.getFilename(),
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      path: item.getSavePath(),
      state,
    });
    item.on('updated', (_ev, state) => send(state));
    item.once('done', (_ev, state) => send(state));
  });
}

// ---------------------------------------------------------------- shortcuts

function setupMenu() {
  const on = (fn) => () => { const bw = focusedWin(); if (bw) fn(bw); };
  const item = (label, accelerator, fn) => ({ label, accelerator, click: on(fn) });
  // The menu bar is never shown (custom title bar); this menu exists so the
  // accelerators work no matter which web page has keyboard focus.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        item('New Tab', 'Ctrl+T', (bw) => bw.newTab()),
        { label: 'New Window', accelerator: 'Ctrl+N', click: () => new BrowserWin() },
        item('Reopen Closed Tab', 'Ctrl+Shift+T', (bw) => bw.reopenClosed()),
        item('Close Tab', 'Ctrl+W', (bw) => bw.closeTab(bw.activeId)),
        item('Focus Address Bar', 'Ctrl+L', (bw) => bw.focusAddress()),
        item('Focus Address Bar', 'Alt+D', (bw) => bw.focusAddress()),
        item('Bookmark Page', 'Ctrl+D', (bw) => bw.toggleBookmark()),
        item('History', 'Ctrl+H', (bw) => bw.openInternal(HISTORY_URL)),
        item('Find', 'Ctrl+F', (bw) => bw.openFind()),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Reload', 'Ctrl+R', (bw) => bw.reload()),
        item('Reload', 'F5', (bw) => bw.reload()),
        item('Hard Reload', 'Ctrl+Shift+R', (bw) => bw.reload(true)),
        item('Back', 'Alt+Left', (bw) => bw.back()),
        item('Forward', 'Alt+Right', (bw) => bw.forward()),
        item('Next Tab', 'Ctrl+Tab', (bw) => bw.cycle(1)),
        item('Previous Tab', 'Ctrl+Shift+Tab', (bw) => bw.cycle(-1)),
        item('Zoom In', 'Ctrl+Plus', (bw) => bw.zoom(0.5)),
        item('Zoom In', 'Ctrl+=', (bw) => bw.zoom(0.5)),
        item('Zoom Out', 'Ctrl+-', (bw) => bw.zoom(-0.5)),
        item('Reset Zoom', 'Ctrl+0', (bw) => bw.zoom(0)),
        item('Developer Tools', 'F12', (bw) => bw.shown?.view.webContents.toggleDevTools()),
        item('Developer Tools', 'Ctrl+Shift+I', (bw) => bw.shown?.view.webContents.toggleDevTools()),
        { role: 'togglefullscreen' },
      ],
    },
  ]));
}

// ---------------------------------------------------------------- boot

// Settings are needed before start-up so crash capture can begin early.
settings = new Store('settings.json', {});
settings.data = { ...DEFAULT_SETTINGS, ...settings.data };
if (settings.data.crashReports) {
  // Local only: dumps are written to disk and never sent anywhere.
  crashReporter.start({ uploadToServer: false, submitURL: '', productName: 'HEoBS' });
  crashReportsActive = true;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => new BrowserWin());

  app.whenReady().then(() => {
    // Present as a plain Chromium build: fewer bits for fingerprinting, and
    // some sites reject unknown product tokens.
    app.userAgentFallback = app.userAgentFallback
      .split(' ')
      .filter((tok) => !/^(electron|heobs[\w-]*)\//i.test(tok))
      .join(' ');

    crashLog = new Store('crashes.json', []);
    app.on('child-process-gone', (_e, d) => {
      if (!['clean-exit', 'killed'].includes(d.reason)) logCrash(d.name || d.type, d.reason, d.exitCode);
    });
    bookmarks = new Store('bookmarks.json', { bar: [], other: [] });
    if (Array.isArray(bookmarks.data)) bookmarks.data = { bar: bookmarks.data, other: [] };
    bookmarks.data.bar ||= [];
    bookmarks.data.other ||= [];
    history = new Store('history.json', []);
    lastSession = new Store('session.json', { urls: [] });
    vault = new Vault(path.join(app.getPath('userData'), 'vault.json'), safeStorage);
    vault.init();

    registerIpc();
    setupSession();
    setupMenu();
    new BrowserWin(lastSession.data.urls);
  });

  app.on('before-quit', () => { settings?.flush(); bookmarks?.flush(); history?.flush(); });
  app.on('window-all-closed', () => app.quit());
}
