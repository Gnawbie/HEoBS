// Add-ons (unpacked Chromium extensions) with mandatory tracker disclosure.
//
// Before an add-on can be installed HEoBS scans every file in it and shows
// the user: the permissions it asks for, the sites it can run on, every
// domain its code mentions, and which of those are known trackers. While it
// runs, the domains its own pages contact are logged and shown as well.
const fs = require('node:fs');
const path = require('node:path');

const SCAN_EXT = new Set(['.js', '.mjs', '.json', '.html', '.htm', '.css']);
const MAX_FILE = 4 * 1024 * 1024;
const MAX_FILES = 3000;

function scanDomains(dir) {
  const hosts = new Set();
  let files = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (files >= MAX_FILES) return;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { if (ent.name !== '_metadata') walk(p); continue; }
      if (!SCAN_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      let text;
      try { if (fs.statSync(p).size > MAX_FILE) continue; text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      files++;
      for (const m of text.matchAll(/(?:https?|wss?):\\?\/\\?\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) {
        hosts.add(m[1].toLowerCase());
      }
    }
  };
  walk(dir);
  return [...hosts].sort();
}

/** Reads an unpacked extension folder and builds its disclosure report. */
function inspect(dir, isTracker) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const isHostPattern = (p) => typeof p === 'string' && (p === '<all_urls>' || p.includes('://'));
  const perms = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].filter((p) => typeof p === 'string');
  const sites = new Set([
    ...perms.filter(isHostPattern),
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
    ...(manifest.content_scripts || []).flatMap((c) => c.matches || []),
  ]);
  const domains = scanDomains(dir);
  let name = String(manifest.name || path.basename(dir));
  if (name.startsWith('__MSG_')) name = path.basename(dir);
  return {
    path: dir,
    name,
    version: String(manifest.version || ''),
    manifestVersion: manifest.manifest_version,
    permissions: perms.filter((p) => !isHostPattern(p)),
    sites: [...sites],
    domains,
    trackers: domains.filter((d) => isTracker(d)),
  };
}

class Addons {
  constructor({ ses, settings, isTracker }) {
    this.api = ses.extensions || ses;
    this.settings = settings;
    this.isTracker = isTracker;
    this.loaded = new Map();    // path -> { id, report }
    this.contacted = new Map(); // extension id -> Map(host -> { count, blocked })
    // Saved as [{ path, enabled, blockTrackers }]
    if (!Array.isArray(settings.data.addons)) settings.data.addons = [];
  }

  get saved() { return this.settings.data.addons; }
  entry(dir) { return this.saved.find((a) => a.path === dir); }

  inspect(dir) { return inspect(dir, this.isTracker); }

  async load(dir) {
    const report = this.inspect(dir);
    const ext = await this.api.loadExtension(dir, { allowFileAccess: false });
    this.loaded.set(dir, { id: ext.id, report });
    return ext;
  }

  unload(dir) {
    const l = this.loaded.get(dir);
    if (l) { try { this.api.removeExtension(l.id); } catch { /* already gone */ } }
    this.loaded.delete(dir);
  }

  async loadSaved() {
    for (const a of this.saved) {
      if (!a.enabled) continue;
      try { await this.load(a.path); } catch (err) { console.error('Add-on failed to load:', a.path, err.message); }
    }
  }

  async install(dir) {
    await this.load(dir);
    if (!this.entry(dir)) this.saved.push({ path: dir, enabled: true, blockTrackers: true });
    this.settings.save();
  }

  async setEnabled(dir, on) {
    const a = this.entry(dir);
    if (!a) return;
    if (on) await this.load(dir); else this.unload(dir);
    a.enabled = !!on;
    this.settings.save();
  }

  setBlockTrackers(dir, on) {
    const a = this.entry(dir);
    if (!a) return;
    a.blockTrackers = !!on;
    this.settings.save();
  }

  remove(dir) {
    this.unload(dir);
    this.settings.data.addons = this.saved.filter((a) => a.path !== dir);
    this.settings.save();
  }

  /**
   * Called for every request made by an add-on's own pages.
   * Returns true when the request must be blocked (a known tracker, and the
   * user has left "block trackers" on for that add-on).
   */
  record(extensionId, host) {
    if (!extensionId || !host) return false;
    let dir = null;
    for (const [p, l] of this.loaded) if (l.id === extensionId) dir = p;
    const block = this.isTracker(host) && (this.settings.data.blockAddonTrackers || (this.entry(dir)?.blockTrackers ?? true));
    let m = this.contacted.get(extensionId);
    if (!m) this.contacted.set(extensionId, (m = new Map()));
    const rec = m.get(host) || { count: 0, blocked: false };
    rec.count++;
    rec.blocked = block;
    m.set(host, rec);
    return block;
  }

  list() {
    return this.saved.map((a) => {
      const l = this.loaded.get(a.path);
      let report;
      try { report = l ? l.report : this.inspect(a.path); }
      catch { return { ...a, name: path.basename(a.path), failed: true }; }
      const contacted = [...((l && this.contacted.get(l.id)) || [])]
        .sort((x, y) => y[1].count - x[1].count)
        .map(([host, r]) => ({ host, count: r.count, blocked: r.blocked, tracker: this.isTracker(host) }));
      return { ...report, ...a, failed: a.enabled && !l, contacted };
    });
  }
}

module.exports = { Addons };
