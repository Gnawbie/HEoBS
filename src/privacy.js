// Tracker blocking and request hygiene for a session.
const fs = require('node:fs');
const path = require('node:path');

const LIST_URL = 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext';
const LIST_HOST = 'pgl.yoyo.org';
const WEEK = 7 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

// Safe browsing: lists of known phishing / malware hostnames, downloaded
// and checked entirely on this PC. The address you visit is never sent
// anywhere to be checked.
const THREAT_LISTS = [
  { host: 'phishing.army', kind: 'phishing', url: 'https://phishing.army/download/phishing_army_blocklist.txt' },
  { host: 'malware-filter.gitlab.io', kind: 'malware', url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts.txt' },
];

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'mc_eid', 'mc_cid', 'igshid', '_hsenc', '_hsmi', 'vero_id', 'oly_enc_id', 'oly_anon_id', 's_cid',
]);

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** Approximate registrable domain ("site") of a hostname. */
function site(host) {
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host || '';
  const p = host.split('.');
  if (p.length <= 2) return host;
  const n = p[p.length - 1].length === 2 && SECOND_LEVEL.has(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join('.');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

class Privacy {
  constructor({ settings, userData, bundledList, fetch, onBlocked, onExtensionRequest, onDangerous }) {
    this.settings = settings;
    this.userList = path.join(userData, 'blocklist.txt');
    this.bundledList = bundledList;
    this.fetch = fetch;
    this.onBlocked = onBlocked;
    this.onExtensionRequest = onExtensionRequest;
    this.domains = new Set();
    this.listDate = 0;
    this.blockedTotal = 0;
    this.blockedHosts = new Map();
    this.onDangerous = onDangerous;
    this.threatFile = path.join(userData, 'threats.txt');
    this.threats = new Map(); // hostname -> 'phishing' | 'malware'
    this.threatDate = 0;
    this.threatAllowed = new Set(); // "proceed anyway", until HEoBS closes
    this.loadList();
    this.loadThreats();
  }

  loadList() {
    const file = fs.existsSync(this.userList) ? this.userList : this.bundledList;
    const text = fs.readFileSync(file, 'utf8');
    this.domains = new Set(text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(l)));
    this.listDate = fs.statSync(file).mtimeMs;
  }

  /** Weekly refresh of the blocklist (only if the user left it enabled). */
  async maybeUpdate() {
    if (!this.settings.data.autoUpdateBlocklist || Date.now() - this.listDate < WEEK) return;
    try {
      const res = await this.fetch(LIST_URL, { credentials: 'omit' });
      const text = await res.text();
      const good = text.split(/\r?\n/).filter((l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l.trim()));
      if (!res.ok || good.length < 1000) return;
      fs.writeFileSync(this.userList, good.join('\n'));
      this.loadList();
    } catch { /* offline: keep the current list */ }
  }

  loadThreats() {
    this.threats = new Map();
    this.threatDate = 0;
    let text;
    try { text = fs.readFileSync(this.threatFile, 'utf8'); this.threatDate = fs.statSync(this.threatFile).mtimeMs; } catch { return; }
    for (const line of text.split('\n')) {
      const i = line.indexOf(' ');
      if (i > 0) this.threats.set(line.slice(i + 1).trim(), line.slice(0, i));
    }
  }

  /** Daily refresh of the phishing / malware lists (only while safe browsing is on). */
  async maybeUpdateThreats() {
    if (!this.settings.data.safeBrowsing || Date.now() - this.threatDate < DAY) return;
    const out = [];
    for (const list of THREAT_LISTS) {
      try {
        const res = await this.fetch(list.url, { credentials: 'omit' });
        if (!res.ok) continue;
        for (const raw of (await res.text()).split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          const host = line.split(/\s+/).pop().toLowerCase();
          if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) out.push(list.kind + ' ' + host);
        }
      } catch { /* offline: keep what we have */ }
    }
    if (out.length < 500) return;
    fs.writeFileSync(this.threatFile, out.join('\n'));
    this.loadThreats();
  }

  threatFor(host) {
    const h = String(host).toLowerCase();
    if (this.threatAllowed.has(h)) return null;
    return this.threats.get(h) || this.threats.get(h.replace(/^www\./, '')) || null;
  }

  isListed(host) {
    let h = String(host).toLowerCase();
    while (h) {
      if (this.domains.has(h)) return true;
      const i = h.indexOf('.');
      if (i < 0) return false;
      h = h.slice(i + 1);
    }
    return false;
  }

  topUrl(d) {
    try { if (d.frame?.top?.url) return d.frame.top.url; } catch { /* frame gone */ }
    try { if (d.webContents && !d.webContents.isDestroyed()) return d.webContents.getURL(); } catch { /* gone */ }
    return d.referrer || '';
  }

  isThirdParty(d, host) {
    return site(hostOf(this.topUrl(d))) !== site(host);
  }

  stats() {
    return {
      listSize: this.domains.size,
      listDate: this.listDate,
      listHost: LIST_HOST,
      threatSize: this.threats.size,
      threatDate: this.threatDate,
      threatHosts: THREAT_LISTS.map((l) => l.host),
      blockedTotal: this.blockedTotal,
      topBlocked: [...this.blockedHosts].sort((a, b) => b[1] - a[1]).slice(0, 15),
    };
  }

  attach(ses) {
    const s = () => this.settings.data;

    ses.webRequest.onBeforeRequest((d, cb) => {
      let u;
      try { u = new URL(d.url); } catch { return cb({}); }
      if (!/^(https?|wss?):$/.test(u.protocol)) return cb({});

      // Record what add-on pages talk to, for the add-on disclosure screen.
      let frameUrl = '';
      try { frameUrl = d.frame?.url || ''; } catch { /* frame gone */ }
      const from = frameUrl.startsWith('chrome-extension://') ? frameUrl : (d.referrer || '');
      if (from.startsWith('chrome-extension://') && this.onExtensionRequest?.(hostOf(from), u.hostname)) {
        return cb({ cancel: true });
      }

      const threat = s().safeBrowsing && /^https?:$/.test(u.protocol) ? this.threatFor(u.hostname) : null;
      if (threat) {
        if (d.resourceType === 'mainFrame') this.onDangerous?.(d.webContents, d.url, threat);
        return cb({ cancel: true });
      }

      if (d.resourceType === 'mainFrame') {
        if (s().stripTrackingParams && u.search) {
          let changed = false;
          for (const key of [...u.searchParams.keys()]) {
            if (TRACKING_PARAMS.has(key.toLowerCase())) { u.searchParams.delete(key); changed = true; }
          }
          if (changed) return cb({ redirectURL: u.toString() });
        }
        return cb({});
      }

      if (s().blockTrackers && this.isListed(u.hostname) && this.isThirdParty(d, u.hostname)) {
        this.blockedTotal++;
        this.blockedHosts.set(u.hostname, (this.blockedHosts.get(u.hostname) || 0) + 1);
        this.onBlocked?.(d.webContents, u.hostname);
        return cb({ cancel: true });
      }
      cb({});
    });

    ses.webRequest.onBeforeSendHeaders((d, cb) => {
      const headers = d.requestHeaders;
      if (s().sendDoNotTrack) { headers.DNT = '1'; headers['Sec-GPC'] = '1'; }
      if (s().blockThirdPartyCookies && d.resourceType !== 'mainFrame' && this.isThirdParty(d, hostOf(d.url))) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'cookie') delete headers[k];
      }
      cb({ requestHeaders: headers });
    });

    ses.webRequest.onHeadersReceived((d, cb) => {
      const headers = d.responseHeaders;
      if (headers && s().blockThirdPartyCookies && d.resourceType !== 'mainFrame' && this.isThirdParty(d, hostOf(d.url))) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'set-cookie') delete headers[k];
      }
      cb({ responseHeaders: headers });
    });
  }
}

module.exports = { Privacy, site, hostOf, LIST_HOST, THREAT_LISTS };
