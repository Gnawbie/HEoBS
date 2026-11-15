const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, session,
  protocol, net, dialog, clipboard, shell, safeStorage, crashReporter,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { Vault } = require('./vault');
const hello = require('./hello');
const { Privacy, hostOf, site, LIST_HOST } = require('./privacy');
const { Addons } = require('./addons');
const { AdBlock, LIST_HOST: AD_LIST_HOST } = require('./adblock');
const { SafeBrowsing, API_HOST: GSB_HOST } = require('./gsb');
const importer = require('./importer');

app.setName('HEoBS');

// Chromium keeps copies of web files (images, scripts) to load pages faster.
// Left alone that cache can grow to hundreds of megabytes; cap it.
const CACHE_LIMIT_MB = 100;
app.commandLine.appendSwitch('disk-cache-size', String(CACHE_LIMIT_MB * 1024 * 1024));

const errorLog = require('./errorlog');
errorLog.init();

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
  blockAds: true,
  blockPopups: true,
  // Per-site exceptions, as site names such as "example.com"
  shieldsOffSites: [],
  popupAllowedSites: [],
  blockAddonTrackers: true,
  blockThirdPartyCookies: true,
  stripTrackingParams: true,
  sendDoNotTrack: true,
  autoUpdateBlocklist: true,
  safeBrowsing: true,
  // Google Safe Browsing: only does anything once the user has saved their own API key.
  googleSafeBrowsing: true,
  gsbKey: '', // the key, encrypted by Windows for this user account
  welcomeSeen: false, // the one-time welcome box on the start page
  spellcheck: true,
  crashReports: true,
  // Auto-clear: 0 = keep, -1 = clear when HEoBS closes, otherwise maximum age in milliseconds.
  historyKeepMs: 0,
  cookiesKeepMs: 0,
  clearCacheOnExit: false, // also empty the cache of web files each time HEoBS closes
  // Sites whose sign-in cookies survive every kind of clearing. Nothing else about them is kept.
  trustedSites: [],
  // Start-page shortcuts chosen by the user: [{ title, url }]
  shortcuts: [],
  addons: [],
};
const BOOLEAN_SETTINGS = ['blockTrackers', 'blockAds', 'blockPopups', 'blockAddonTrackers', 'blockThirdPartyCookies', 'stripTrackingParams', 'sendDoNotTrack', 'autoUpdateBlocklist', 'clearCacheOnExit', 'safeBrowsing', 'googleSafeBrowsing', 'spellcheck', 'crashReports'];

protocol.registerSchemesAsPrivileged([
  { scheme: 'heobs', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
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
let adblock;
let gsb;
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
      title: errorLog.enabled ? 'HEoBS (test build)' : 'HEoBS',
      backgroundColor: '#1b1d23',
      icon: path.join(PAGES_DIR, 'icon.png'),
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
    const tab = { id: nextTabId++, view, favicon: null, fullscreen: false, blank: false, peek: null, blocked: new Map(), userHint: null, lastInput: 0, lastPopupInput: -1, popups: [] };

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
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0] || null;
      update();
      const host = hostOf(wc.getURL());
      if (icons[0] && host && !siteIcons.data[host] && isShortcutHost(host)) {
        fetchIconAsData(icons[0]).then((icon) => { if (icon) { siteIcons.data[host] = icon; siteIcons.save(); } }).catch(() => {});
      }
    });
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { tab.favicon = null; tab.blocked = new Map(); tab.popups = []; }
    });
    wc.on('did-navigate', (_e, url) => { this.recordVisit(wc, url); pruneHistory(); update(); });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) { this.recordVisit(wc, url); update(); }
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || code === -20 || isInternal(url)) return;
      const q = new URLSearchParams({ url, desc, code: String(code) });
      wc.loadURL('heobs://error/?' + q).catch(() => {});
    });

    // Remember when the user last clicked or typed in this page: a window the
    // page opens without that is a pop-up nobody asked for.
    wc.on('input-event', (_e, input) => {
      if (['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'touchStart', 'touchEnd', 'gestureTap'].includes(input.type)) tab.lastInput = Date.now();
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^(https?|heobs|about):/i.test(url)) return { action: 'deny' };
      const reason = this.popupBlockReason(tab, url);
      if (reason) {
        if (tab.popups.length < 50) tab.popups.push({ url, reason });
        this.sendState();
      } else {
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

  /** Why a window the page wants to open should be blocked, or null to allow it. */
  popupBlockReason(tab, url) {
    if (!settings.data.blockPopups) return null;
    const opener = toSite(tab.view.webContents.getURL());
    if (opener && settings.data.popupAllowedSites.includes(opener)) return null;
    if (Date.now() - tab.lastInput > 1500) return 'opened without a click';
    if (tab.lastPopupInput === tab.lastInput) return 'more than one window from a single click';
    const host = hostOf(url);
    if (host && site(host) !== opener && privacy.isListed(host)) return 'leads to a known ad server';
    tab.lastPopupInput = tab.lastInput;
    return null;
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
        blocked: [...blocked.values()].reduce((a, b) => a + b, 0) + (active && !active.blank ? active.popups.length : 0),
        shieldOn: (settings.data.blockTrackers || settings.data.blockAds) && !settings.data.shieldsOffSites.includes(toSite(url)),
        vaultLocked: vault.locked,
      });
    });
  }

  // ---- menus

  shieldMenu() {
    const tab = this.active;
    const hosts = tab && !tab.blank ? [...tab.blocked].sort((a, b) => b[1] - a[1]) : [];
    const total = hosts.reduce((a, [, n]) => a + n, 0);
    const here = toSite(this.nav?.getURL());
    const off = !!here && settings.data.shieldsOffSites.includes(here);
    const anyOn = settings.data.blockTrackers || settings.data.blockAds;
    const head = off ? `Blocking is switched off for ${here}`
      : !anyOn ? 'Ad and tracker blocking is turned off'
        : total ? `${total} ad / tracker request${total === 1 ? '' : 's'} blocked on this page` : 'No ads or trackers blocked on this page';
    const popups = tab && !tab.blank ? tab.popups : [];
    const toggleSite = (key, name, on) => {
      const list = new Set(settings.data[key]);
      if (on) list.add(name); else list.delete(name);
      settings.data[key] = [...list].sort();
      settings.save();
      broadcastState();
    };
    Menu.buildFromTemplate([
      { label: head, enabled: false },
      ...hosts.slice(0, 15).map(([h, n]) => ({ label: menuLabel(`${h}  ×${n}`), enabled: false })),
      ...(popups.length ? [
        { type: 'separator' },
        { label: `${popups.length} pop-up${popups.length === 1 ? '' : 's'} blocked on this page`, enabled: false },
        ...popups.slice(0, 6).map((p) => ({ label: menuLabel(`Open anyway: ${hostOf(p.url) || p.url} (${p.reason})`), click: () => this.newTab(p.url, { after: tab }) })),
      ] : []),
      { type: 'separator' },
      ...(here ? [
        {
          label: menuLabel(`Block ads and trackers on ${here}`),
          type: 'checkbox',
          checked: !off,
          click: (item) => { toggleSite('shieldsOffSites', here, !item.checked); this.reload(); },
        },
        {
          label: menuLabel(`Allow pop-ups from ${here}`),
          type: 'checkbox',
          checked: settings.data.popupAllowedSites.includes(here),
          click: (item) => toggleSite('popupAllowedSites', here, item.checked),
        },
      ] : []),
      ...(() => {
        const name = toSite(this.nav?.getURL());
        if (!name) return [];
        return [{
          label: menuLabel(`Trusted site: keep me signed in to ${name}`),
          type: 'checkbox',
          checked: settings.data.trustedSites.includes(name),
          click: (item) => setTrusted(name, item.checked),
        }];
      })(),
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
      { label: 'Send crash reports…', click: () => sendCrashReports(this) },
      ...(errorLog.enabled ? [{ label: 'Open error log (test build)', click: () => { fs.appendFileSync(errorLog.logFile, ''); shell.openPath(errorLog.logFile); } }] : []),
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
    detail: 'This removes history, cookies, cache and site storage. You will be signed out of websites, except your trusted sites, whose sign-in cookies are kept. Bookmarks and saved passwords are kept.',
  });
  if (response !== 0) return;
  history.data = [];
  history.flush();
  const ses = session.defaultSession;
  const keep = (await ses.cookies.get({})).filter(isTrustedCookie);
  await ses.clearStorageData();
  await ses.clearCache();
  for (const c of keep) {
    await ses.cookies.set({
      url: cookieUrl(c), name: c.name, value: c.value, path: c.path,
      domain: c.hostOnly ? undefined : c.domain,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate,
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------- shortcut icons

// Each shortcut shows its site's own icon. The icon is fetched once, when the
// shortcut is added (or the first time you visit the site), and kept on this
// PC, so opening the start page never contacts any of those sites.
let siteIcons; // { host: "data:image/...;base64,..." }
const MAX_SHORTCUTS = 20;
const ICON_DATA = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp|svg\+xml);base64,/;

async function fetchIconAsData(url) {
  const res = await net.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length || body.length > 200 * 1024) return null;
  if (!type.startsWith('image/')) {
    if (/\.ico(\?|$)/i.test(url)) type = 'image/x-icon'; else return null;
  }
  const data = `data:${type};base64,${body.toString('base64')}`;
  return ICON_DATA.test(data) ? data : null;
}

/** Finds a site's own icon: the one its home page declares, else /favicon.ico. */
async function findSiteIcon(pageUrl) {
  const origin = new URL(pageUrl).origin;
  try {
    const res = await net.fetch(origin + '/', { credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (res.ok && (res.headers.get('content-type') || '').includes('html')) {
      const html = (await res.text()).slice(0, 300000);
      const tags = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /rel\s*=\s*["']?[^"'>]*icon/i.test(t));
      tags.sort((a, b) => (/apple-touch/i.test(b) ? 1 : 0) - (/apple-touch/i.test(a) ? 1 : 0)); // larger artwork first
      for (const tag of tags.slice(0, 4)) {
        const href = /href\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
        if (!href) continue;
        const icon = await fetchIconAsData(new URL(href[1].replace(/&amp;/g, '&'), res.url || origin).toString()).catch(() => null);
        if (icon) return icon;
      }
    }
  } catch { /* fall through to favicon.ico */ }
  return fetchIconAsData(origin + '/favicon.ico').catch(() => null);
}

async function cacheSiteIcon(url) {
  const host = hostOf(url);
  if (!host || siteIcons.data[host]) return;
  const icon = await findSiteIcon(url).catch(() => null);
  if (icon) { siteIcons.data[host] = icon; siteIcons.save(); }
}

const isShortcutHost = (host) => settings.data.shortcuts.some((s) => hostOf(s.url) === host);

function dropUnusedIcons() {
  for (const host of Object.keys(siteIcons.data)) if (!isShortcutHost(host)) delete siteIcons.data[host];
  siteIcons.save();
}

// ---------------------------------------------------------------- auto-clear

const MINUTE = 60 * 1000;
const MAX_KEEP = 3650 * 24 * 60 * MINUTE;
let cookieTimes; // { "domain|path|name": time the cookie was first set }

const cookieKey = (c) => `${c.domain}|${c.path}|${c.name}`;
const cookieUrl = (c) => `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`;

/** True for cookies belonging to a site the user marked as trusted. */
function isTrustedCookie(c) {
  return settings.data.trustedSites.includes(site(c.domain.replace(/^\./, '').toLowerCase()));
}

/** Turns "https://www.example.com/login" or "example.com" into "example.com". */
function toSite(input) {
  let text = String(input || '').trim().toLowerCase();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = 'https://' + text;
  let host = '';
  try { const u = new URL(text); if (/^https?:$/.test(u.protocol)) host = u.hostname; } catch { /* not an address */ }
  return host && (host.includes('.') || host === 'localhost') ? site(host) : '';
}

function setTrusted(name, on) {
  const list = new Set(settings.data.trustedSites);
  if (on) list.add(name); else list.delete(name);
  settings.data.trustedSites = [...list].sort();
  settings.save();
  if (!on) pruneCookies().catch(() => {});
}

/** Drops history entries older than the chosen age. */
function pruneHistory() {
  const keep = settings.data.historyKeepMs;
  if (!(keep > 0)) return;
  const cutoff = Date.now() - keep;
  const before = history.data.length;
  history.data = history.data.filter((h) => h.time >= cutoff);
  if (history.data.length !== before) history.save();
}

/** Deletes cookies that were first set longer ago than the chosen age. */
async function pruneCookies() {
  const keep = settings.data.cookiesKeepMs;
  if (!(keep > 0)) return;
  const ses = session.defaultSession;
  const cutoff = Date.now() - keep;
  const live = new Set();
  for (const c of await ses.cookies.get({})) {
    const key = cookieKey(c);
    const first = cookieTimes.data[key] ?? (cookieTimes.data[key] = Date.now());
    if (first < cutoff && !isTrustedCookie(c)) await ses.cookies.remove(cookieUrl(c), c.name).catch(() => {});
    else live.add(key);
  }
  for (const key of Object.keys(cookieTimes.data)) if (!live.has(key)) delete cookieTimes.data[key];
  cookieTimes.save();
}

/** Removes every cookie except those of trusted sites. */
async function clearAllCookies() {
  const ses = session.defaultSession;
  if (!settings.data.trustedSites.length) {
    cookieTimes.data = {};
    cookieTimes.save();
    return ses.clearStorageData({ storages: ['cookies'] });
  }
  for (const c of await ses.cookies.get({})) {
    if (isTrustedCookie(c)) continue;
    await ses.cookies.remove(cookieUrl(c), c.name).catch(() => {});
    delete cookieTimes.data[cookieKey(c)];
  }
  cookieTimes.save();
  await ses.cookies.flushStore();
}

const CRASH_DUMP_MAX_AGE = 30 * 24 * 3600 * 1000;
const CRASH_DUMP_MAX_COUNT = 20;

/** Removes files HEoBS no longer needs. Runs at start-up. */
function tidyUp() {
  const userData = app.getPath('userData');
  // half-written files from an interrupted save
  for (const name of ['vault.json.tmp']) { try { fs.unlinkSync(path.join(userData, name)); } catch { /* none */ } }
  // crash dumps: keep the newest few, and none older than a month
  const dumps = listCrashDumps()
    .map((file) => { try { return { file, time: fs.statSync(file).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.time - a.time);
  dumps.forEach((d, i) => {
    if (i >= CRASH_DUMP_MAX_COUNT || Date.now() - d.time > CRASH_DUMP_MAX_AGE) { try { fs.unlinkSync(d.file); } catch { /* in use */ } }
  });
  // downloaded Google lists are useless without a key
  if (!gsbKey()) {
    for (const name of fs.readdirSync(userData)) {
      if (/^gsb-.*\.(bin|json)$/.test(name)) { try { fs.unlinkSync(path.join(userData, name)); } catch { /* in use */ } }
    }
  }
}

async function clearWebCache() {
  const ses = session.defaultSession;
  await ses.clearCache();
  await ses.clearCodeCaches({}).catch(() => {});
}

function setupAutoClear() {
  try { tidyUp(); } catch (err) { console.error('Tidy-up failed:', err && err.message); }
  const ses = session.defaultSession;
  // Remember when each cookie first appeared; the cookie store itself does not say.
  ses.cookies.on('changed', (_e, cookie, cause, removed) => {
    const key = cookieKey(cookie);
    if (removed) {
      if (cause === 'overwrite') return; // the site refreshed it: keep the original date
      delete cookieTimes.data[key];
    } else if (!cookieTimes.data[key]) cookieTimes.data[key] = Date.now();
    else return;
    cookieTimes.save();
  });
  // "When HEoBS closes" is also enforced at start-up, in case the last exit was a crash.
  if (settings.data.historyKeepMs === -1) { history.data = []; history.flush(); }
  if (settings.data.cookiesKeepMs === -1) clearAllCookies();
  const sweep = () => { pruneHistory(); pruneCookies().catch(() => {}); };
  sweep();
  setInterval(sweep, 5 * MINUTE);
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

const REPORT_URL = 'https://github.com/Gnawbie/HEoBS/issues/new';
const REPORT_MAX_CRASHES = 25;

/** The text of a crash report: versions and the list of crashes. No addresses, no page content, no dump files. */
function crashReportText() {
  const lines = [
    'HEoBS ' + app.getVersion() + (errorLog.enabled ? ' (test mode)' : ''),
    'Electron ' + process.versions.electron + ', Chromium ' + process.versions.chrome,
    'Windows ' + require('node:os').release() + ' ' + process.arch,
    '',
    'Crashes (newest first):',
  ];
  for (const c of crashLog.data.slice(0, REPORT_MAX_CRASHES)) {
    lines.push('- ' + new Date(c.time).toISOString() + ' | ' + c.what + ' | ' + c.reason + ' | exit code ' + c.code);
  }
  if (crashLog.data.length > REPORT_MAX_CRASHES) lines.push('(' + (crashLog.data.length - REPORT_MAX_CRASHES) + ' older crashes not listed)');
  return lines.join('\n');
}

/** Menu: "Send crash reports". Nothing leaves the PC until the user submits the form on GitHub themselves. */
async function sendCrashReports(bw) {
  if (!crashLog.data.length) {
    dialog.showMessageBox(bw.win, {
      type: 'info', buttons: ['OK'], message: 'No crashes to report',
      detail: settings.data.crashReports
        ? 'HEoBS has not recorded any crashes on this PC.'
        : 'Crash reports are switched off. Turn them on under Settings → Crash Reports to record future crashes.',
    });
    return;
  }
  const text = crashReportText();
  const { response } = await dialog.showMessageBox(bw.win, {
    type: 'question',
    buttons: ['Open report on GitHub', 'Copy report', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: 'Send crash reports to the HEoBS developer?',
    detail: 'This is everything that will be in the report:\n\n' + text +
      '\n\nIt has no web addresses, page content or crash dump files. HEoBS opens a pre-filled report form on github.com in a new tab; ' +
      'nothing is sent until you press the submit button there. Reports on GitHub are public and need a free GitHub account. ' +
      '"Copy report" puts the text on the clipboard instead, to send some other way.',
  });
  if (response === 1) { clipboard.writeText(text); return; }
  if (response !== 0) return;
  const q = new URLSearchParams({
    title: 'Crash report: HEoBS ' + app.getVersion(),
    body: 'What I was doing when it crashed:\n\n(please describe)\n\n---\n```\n' + text + '\n```\n',
  });
  bw.newTab(REPORT_URL + '?' + q);
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
    builtIn: 'None. HEoBS has no analytics, telemetry, automatic crash reporting, advertising IDs, accounts or sync. Nothing about how you use it is sent to its authors or anyone else unless you send it yourself.',
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
        control: 'Toggle "Update the tracker blocklist weekly" under Ads & trackers.',
      },
      {
        who: AD_LIST_HOST,
        why: 'Ad blocking. When HEoBS starts and its ad filter lists are more than 4 days old, it downloads fresh ones (EasyList, EasyPrivacy and uBlock Origin lists, mirrored by the Ghostery project on GitHub). Plain downloads with no cookies or identifiers; GitHub can see your IP address, never the sites you visit. Filtering itself happens on this PC.',
        note: s.blockAds ? (privacy.stats().adEngineReady ? 'Currently ON.' : 'Currently ON — lists not loaded yet (first start or offline).') : 'Currently OFF — nothing is downloaded.',
        control: 'Toggle "Block ads" under Ads & trackers.',
      },
      {
        who: privacy.stats().threatHosts.join(', '),
        why: 'Safe browsing. Once a day HEoBS downloads lists of known phishing and malware sites and checks every address against them on this PC. Plain downloads with no cookies or identifiers; those servers can see your IP address, but never which sites you visit.',
        note: s.safeBrowsing ? `Currently ON — ${privacy.stats().threatSize.toLocaleString()} dangerous sites known.` : 'Currently OFF — no lists are downloaded and nothing is checked.',
        control: 'Toggle "Warn me about dangerous sites" under Ads & trackers.',
      },
      {
        who: GSB_HOST,
        why: 'Google Safe Browsing (optional). Only if you saved your own Google API key: HEoBS downloads Google\'s lists of 4-byte fingerprints of dangerous addresses about every 30 minutes and checks addresses against them on this PC. Only when a fingerprint matches does it ask Google to confirm, sending that 4-byte fingerprint and never the address. Google sees your IP address, your API key, and those occasional fingerprints.',
        note: !gsb.status().hasKey ? 'Currently OFF — no key saved, so nothing is sent to Google.' : (s.safeBrowsing && s.googleSafeBrowsing ? 'Currently ON.' : 'Currently OFF — switched off.'),
        control: 'Ads & trackers: "Also check sites with Google Safe Browsing", or remove the key.',
      },
      {
        who: 'Google dictionary servers (redirector.gvt1.com / dl.google.com)',
        why: 'Spell-check. The first time spell-check needs a language, the Chromium engine downloads that dictionary file from Google. What you type is checked on this PC and is never sent. Google can see your IP address and which language was fetched.',
        note: s.spellcheck ? 'Currently ON.' : 'Currently OFF — no dictionary is downloaded.',
        control: 'Toggle "Check spelling as I type" under Ads & trackers.',
      },
      {
        who: 'Websites you open',
        why: 'Pages you visit, plus their icons for the tab strip and bookmarks bar. When you add or import a start-page shortcut, HEoBS fetches that site\'s icon once (no cookies sent) and keeps it on this PC; opening the start page afterwards contacts nobody. Sites can still do their own first-party analytics; HEoBS blocks known third-party trackers, third-party cookies and tracking link parameters, but no blocker catches everything.',
        note: '',
        control: 'Ads & trackers toggles above. The shield in the toolbar shows what was blocked on each page.',
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
      'Uploading crash reports by itself — they are saved on this PC only. "Send crash reports" in the menu shows you the report and opens a form on github.com; nothing is sent unless you submit that form.',
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

// Newer Electron versions return the clipboard text as a promise, older ones as a string.
async function readClipboardText() {
  try { return String((await clipboard.readText()) || ''); } catch { return ''; }
}

const internalHandlers = {
  history: () => history.data,
  bookmarks: () => allBookmarks(),
  resolve: (_e, text) => toURL(text),
  removeHistory: (_e, url, time) => {
    history.data = history.data.filter((h) => !(h.url === url && h.time === time));
    history.save();
  },
  clearHistory: () => { history.data = []; history.save(); },

  // ---- start-page shortcuts
  'shortcuts.list': () => settings.data.shortcuts.map((s) => ({ ...s, icon: siteIcons.data[hostOf(s.url)] || null })),
  'shortcuts.save': async (_e, index, title, address) => {
    let text = String(address || '').trim();
    if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
    let url = '';
    try { const u = new URL(text); if (/^https?:$/.test(u.protocol) && (u.hostname.includes('.') || u.hostname === 'localhost')) url = u.toString(); } catch { /* invalid */ }
    if (!url) throw new Error('Enter a web address such as example.com.');
    const name = String(title || '').trim().slice(0, 60) || hostOf(url).replace(/^www\./, '');
    const list = settings.data.shortcuts;
    if (Number.isInteger(index) && index >= 0 && index < list.length) list[index] = { title: name, url };
    else if (list.length >= MAX_SHORTCUTS) throw new Error('You can have up to 20 shortcuts. Remove one first.');
    else list.push({ title: name, url });
    settings.save();
    await cacheSiteIcon(url);
    dropUnusedIcons();
  },
  'shortcuts.remove': (_e, index) => {
    const list = settings.data.shortcuts;
    if (Number.isInteger(index) && index >= 0 && index < list.length) { list.splice(index, 1); settings.save(); dropUnusedIcons(); }
  },
  // Shortcuts set up on another browser's start page
  'shortcuts.sources': () => importer.detectShortcuts().map(({ list, ...rest }) => rest),
  'shortcuts.import': async (_e, id) => {
    const src = importer.detectShortcuts().find((s) => s.id === id);
    if (!src) throw new Error('That browser profile was not found.');
    const list = settings.data.shortcuts;
    const added = [];
    let skipped = 0;
    for (const item of src.list) {
      let url = '';
      try { const u = new URL(item.url); if (/^https?:$/.test(u.protocol)) url = u.toString(); } catch { /* skip */ }
      if (!url || list.some((s) => s.url === url) || list.length >= MAX_SHORTCUTS) { skipped++; continue; }
      const entry = { title: item.title.trim().slice(0, 60) || hostOf(url).replace(/^www\./, ''), url };
      list.push(entry);
      added.push(entry);
    }
    settings.save();
    await Promise.all(added.map((s) => cacheSiteIcon(s.url)));
    return { added: added.length, skipped };
  },

  // ---- per-site exceptions (blocking off / pop-ups allowed)
  'sites.list': (_e, key) => (['shieldsOffSites', 'popupAllowedSites'].includes(key) ? settings.data[key] : []),
  'sites.remove': (_e, key, name) => {
    if (!['shieldsOffSites', 'popupAllowedSites'].includes(key)) return;
    settings.data[key] = settings.data[key].filter((s) => s !== name);
    settings.save();
    broadcastState();
  },

  // ---- trusted sites
  'trusted.list': () => settings.data.trustedSites,
  'trusted.add': (_e, input) => {
    const name = toSite(input);
    if (!name) throw new Error('Enter a site such as example.com.');
    setTrusted(name, true);
    return name;
  },
  'trusted.remove': (_e, name) => setTrusted(String(name), false),

  // ---- storage used by cached web files
  'storage.usage': async () => ({ cacheBytes: await session.defaultSession.getCacheSize(), limitMB: CACHE_LIMIT_MB }),
  'storage.clearCache': async () => { await clearWebCache(); return session.defaultSession.getCacheSize(); },

  // ---- auto-clear
  'autoclear.get': () => ({ history: settings.data.historyKeepMs, cookies: settings.data.cookiesKeepMs }),
  'autoclear.set': async (_e, kind, ms) => {
    if (!['history', 'cookies'].includes(kind)) throw new Error('Unknown auto-clear type');
    const value = Number(ms);
    if (!(value === 0 || value === -1 || (Number.isFinite(value) && value >= MINUTE && value <= MAX_KEEP))) {
      throw new Error('Choose a time of at least 1 minute.');
    }
    settings.data[kind + 'KeepMs'] = Math.round(value);
    settings.save();
    if (kind === 'history') pruneHistory(); else await pruneCookies();
  },

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
      if ((key === 'safeBrowsing' || key === 'googleSafeBrowsing') && value) gsb.update().catch(() => {});
      if (key === 'blockAds' && value) startAdblock(session.defaultSession);
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

  // ---- one-time welcome box (start page)
  'welcome.state': () => ({ show: !settings.data.welcomeSeen && !gsbKey() }),
  'welcome.done': () => { settings.data.welcomeSeen = true; settings.save(); },

  // ---- Google Safe Browsing (the key itself is never returned)
  'gsb.status': () => gsb.status(),
  'gsb.setKey': (_e, key) => saveGsbKey(key),
  // "Paste key": the main process reads the clipboard itself, only when this is clicked.
  'gsb.pasteKey': async () => {
    const text = (await readClipboardText()).trim();
    if (!text) throw new Error('The clipboard is empty. Copy the key from Google first.');
    return saveGsbKey(text);
  },
  'gsb.removeKey': () => {
    settings.data.gsbKey = '';
    gsbKeyCache = null;
    settings.flush();
    gsb.reset();
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
    clipboardTimer = setTimeout(async () => { if ((await readClipboardText()) === secret) clipboard.clear(); }, 30000);
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

async function saveGsbKey(key) {
  const value = String(key || '').trim();
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(value)) throw new Error('That does not look like a Google API key. It is a single run of letters, digits, - and _, usually starting with "AIza".');
  gsb.reset();
  settings.data.gsbKey = safeStorage.encryptString(value).toString('base64');
  gsbKeyCache = value;
  settings.flush();
  await gsb.update();
  const st = gsb.status();
  if (st.error) throw new Error('The key was saved, but Google refused it: ' + st.error);
  return st;
}

// The Google API key is kept encrypted (Windows seals it to this user account)
// and is never handed to any page, HEoBS's own settings page included.
let gsbKeyCache;
function gsbKey() {
  if (gsbKeyCache !== undefined) return gsbKeyCache;
  gsbKeyCache = null;
  try { if (settings.data.gsbKey) gsbKeyCache = safeStorage.decryptString(Buffer.from(settings.data.gsbKey, 'base64')); } catch { /* unreadable: treat as no key */ }
  return gsbKeyCache;
}

// Stand-ins for blocked ad scripts are served from heobs://standin/<n>.
// (Chromium refuses to redirect a request straight to inline "data:" content.)
const standInIds = new Map(); // engine-provided data: URL -> index
const standInBodies = [];     // index -> { type, body }
function standInUrl(dataUrl) {
  let id = standInIds.get(dataUrl);
  if (id === undefined) {
    const m = /^data:([^,;]*)[^,]*?(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!m) return dataUrl;
    let body;
    try { body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])); } catch { return dataUrl; }
    id = standInBodies.length;
    standInBodies.push({ type: m[1] || 'text/plain', body });
    standInIds.set(dataUrl, id);
  }
  return `heobs://standin/${id}`;
}

let adblockStarting = false;
function startAdblock(ses) {
  if (adblockStarting) return;
  adblockStarting = true;
  adblock.load().then(() => {
    adblock.enable(ses);
    privacy.adblock = adblock;
    privacy.attach(ses); // re-install HEoBS's combined request handler on top of the engine's
  }).catch((err) => { adblockStarting = false; console.error('Ad filter lists could not be loaded:', err && err.message); });
}

function setupSession() {
  const ses = session.defaultSession;

  protocol.handle('heobs', (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'standin') {
      const item = standInBodies[Number(u.pathname.slice(1))];
      if (!item) return new Response('', { status: 404 });
      return new Response(item.body, { headers: { 'content-type': item.type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }
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
    standIn: standInUrl,
    onDangerous: (wc, url, kind, source) => {
      if (!wc || wc.isDestroyed() || !tabFor(wc)) return;
      const q = new URLSearchParams({ url, kind, source: source || 'local' });
      setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL('heobs://blocked/?' + q).catch(() => {}); });
    },
  });
  ses.setSpellCheckerEnabled(!!settings.data.spellcheck);
  setTimeout(() => privacy.maybeUpdateThreats(), 5000);
  setInterval(() => privacy.maybeUpdateThreats(), 6 * 3600 * 1000);
  addons = new Addons({ ses, settings, isTracker: (h) => privacy.isListed(h) });
  privacy.attach(ses);
  setTimeout(() => privacy.maybeUpdate(), 30000);

  gsb = new SafeBrowsing({
    userData: app.getPath('userData'),
    getKey: gsbKey,
    fetch: (url, init) => net.fetch(url, init),
    isEnabled: () => settings.data.safeBrowsing && settings.data.googleSafeBrowsing,
  });
  privacy.gsb = gsb;
  setTimeout(() => gsb.update().catch(() => {}), 8000);

  adblock = new AdBlock({
    userData: app.getPath('userData'),
    fetch: (url, init) => net.fetch(url, init),
    isActiveFor: (pageUrl) => settings.data.blockAds && !settings.data.shieldsOffSites.includes(toSite(pageUrl)),
  });
  if (settings.data.blockAds) startAdblock(ses);
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
  // Another HEoBS already owns this profile, so this copy would hand over to it and log nothing.
  if (errorLog.enabled) dialog.showErrorBox('HEoBS test build', 'HEoBS is already running. Close it first, then start HEoBS_Test.exe again so errors can be logged.');
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

    cookieTimes = new Store('cookie-times.json', {});
    siteIcons = new Store('site-icons.json', {});

    registerIpc();
    setupSession();
    setupAutoClear();
    setupMenu();
    const first = new BrowserWin(lastSession.data.urls);
    // First start after installing or updating to this version: make sure the
    // start page, which carries the welcome box, is the tab in front.
    // (Decided from the restored tab list: a tab's own address is still empty this early.)
    const restored = lastSession.data.urls || [];
    if (!settings.data.welcomeSeen && !gsbKey() && restored.length && restored[restored.length - 1] !== NEWTAB) {
      first.newTab(NEWTAB);
    }
  });

  let exitCleanupDone = false;
  app.on('before-quit', (e) => {
    if (history && settings.data.historyKeepMs === -1) history.data = [];
    settings?.flush(); bookmarks?.flush(); history?.flush(); cookieTimes?.flush(); siteIcons?.flush();
    if (exitCleanupDone || !cookieTimes) return;
    // "Clear ... when HEoBS closes": hold the exit until the clearing is finished.
    const jobs = [];
    if (settings.data.cookiesKeepMs === -1) jobs.push(clearAllCookies().catch(() => {}));
    if (settings.data.clearCacheOnExit) jobs.push(clearWebCache().catch(() => {}));
    if (!jobs.length) return;
    exitCleanupDone = true;
    e.preventDefault();
    const finish = () => { cookieTimes.flush(); app.quit(); };
    // never let a stuck clean-up keep HEoBS from closing
    Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 8000))]).then(finish, finish);
  });
  app.on('window-all-closed', () => app.quit());
}
