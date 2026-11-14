// Google Safe Browsing (API v5, "local list" mode).
//
// HEoBS downloads Google's lists of 4-byte fingerprints (hash prefixes) of
// dangerous addresses and keeps them on this PC. Every address is checked
// against those lists locally. Only when a fingerprint matches does HEoBS ask
// Google to confirm, and then it sends just the 4-byte fingerprint, never the
// address. If Google cannot be reached the address is treated as safe, as the
// protocol specifies.
//
// Needs the user's own (free) Google API key. Non-commercial use only.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://safebrowsing.googleapis.com/v5';
const API_HOST = 'safebrowsing.googleapis.com';
const LISTS = ['se-4b', 'mw-4b', 'uws-4b']; // social engineering, malware, unwanted software (desktop)
const KIND = { SOCIAL_ENGINEERING: 'phishing', MALWARE: 'malware', UNWANTED_SOFTWARE: 'unwanted', POTENTIALLY_HARMFUL_APPLICATION: 'unwanted' };
const MIN_WAIT = 5 * 60 * 1000;
const DEFAULT_WAIT = 30 * 60 * 1000;

// ---------------------------------------------------------------- Rice-delta decoding

/** Decodes a RiceDeltaEncoded32Bit object into ascending 32-bit numbers. */
function decodeRice(obj) {
  if (!obj) return new Uint32Array(0);
  const count = Number(obj.entriesCount || 0);
  const k = Number(obj.riceParameter || 0);
  const out = new Uint32Array(count + 1);
  out[0] = Number(obj.firstValue || 0) >>> 0;
  if (!count) return out;
  if (k < 1 || k > 31) throw new Error('bad rice parameter');
  const data = Buffer.from(obj.encodedData || '', 'base64');
  let pos = 0; // bit position, least significant bit of byte 0 first
  const total = data.length * 8;
  const bit = () => {
    if (pos >= total) throw new Error('rice data truncated');
    const b = (data[pos >> 3] >> (pos & 7)) & 1;
    pos++;
    return b;
  };
  let prev = out[0];
  for (let i = 1; i <= count; i++) {
    let q = 0;
    while (bit() === 1) q++;
    let r = 0;
    for (let j = 0; j < k; j++) r += bit() * 2 ** j;
    prev += q * 2 ** k + r;
    if (prev > 0xffffffff) throw new Error('rice value overflow');
    out[i] = prev;
  }
  return out;
}

/** Inverse of decodeRice. Only used by tests. */
function encodeRice(sorted, k) {
  const bits = [];
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i] - sorted[i - 1];
    const q = Math.floor(delta / 2 ** k);
    const r = delta % 2 ** k;
    for (let j = 0; j < q; j++) bits.push(1);
    bits.push(0);
    for (let j = 0; j < k; j++) bits.push(Math.floor(r / 2 ** j) % 2);
  }
  const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
  return { firstValue: sorted[0], riceParameter: k, entriesCount: sorted.length - 1, encodedData: bytes.toString('base64') };
}

// ---------------------------------------------------------------- reading Google's replies

// The v5 service answers in protocol buffers (a compact binary format), not
// JSON. These few functions read just the fields HEoBS needs. Field numbers
// are from Google's published definitions and checked against live replies.

/** Splits one protobuf message into its fields: [{ field, wire, value }]. */
function readFields(buf) {
  const out = [];
  let p = 0;
  const varint = () => {
    let v = 0n, shift = 0n;
    for (;;) {
      if (p >= buf.length) throw new Error('reply cut short');
      const b = buf[p++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
      if (shift > 63n) throw new Error('bad number in reply');
    }
  };
  while (p < buf.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ field, wire, value: Number(varint()) });
    else if (wire === 2) {
      const len = Number(varint());
      if (p + len > buf.length) throw new Error('reply cut short');
      out.push({ field, wire, value: buf.subarray(p, p + len) });
      p += len;
    } else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else throw new Error('unexpected data in reply');
  }
  return out;
}

const pick = (fields, n) => { const f = fields.find((x) => x.field === n); return f ? f.value : undefined; };
const durationText = (buf) => (buf ? `${pick(readFields(buf), 1) || 0}s` : undefined);

function readRice(buf) {
  if (!buf) return undefined;
  const f = readFields(buf);
  return { firstValue: pick(f, 1) || 0, riceParameter: pick(f, 2) || 0, entriesCount: pick(f, 3) || 0, encodedData: (pick(f, 4) || Buffer.alloc(0)).toString('base64') };
}

/** BatchGetHashListsResponse -> { hashLists: [...] } */
function readBatch(buf) {
  return {
    hashLists: readFields(buf).filter((f) => f.field === 1 && f.wire === 2).map((entry) => {
      const f = readFields(entry.value);
      const checksum = pick(f, 7);
      return {
        name: (pick(f, 1) || Buffer.alloc(0)).toString('utf8'),
        version: (pick(f, 2) || Buffer.alloc(0)).toString('base64'),
        partialUpdate: !!pick(f, 3),
        additionsFourBytes: readRice(pick(f, 4)),
        compressedRemovals: readRice(pick(f, 5)),
        minimumWaitDuration: durationText(pick(f, 6)),
        sha256Checksum: checksum ? checksum.toString('base64') : undefined,
      };
    }),
  };
}

const THREAT_TYPES = ['THREAT_TYPE_UNSPECIFIED', 'MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];
const THREAT_ATTRIBUTES = ['THREAT_ATTRIBUTE_UNSPECIFIED', 'CANARY', 'FRAME_ONLY'];

/** SearchHashesResponse -> { fullHashes: [...], cacheDuration } */
function readSearch(buf) {
  const top = readFields(buf);
  return {
    fullHashes: top.filter((f) => f.field === 1 && f.wire === 2).map((entry) => {
      const f = readFields(entry.value);
      return {
        fullHash: (pick(f, 1) || Buffer.alloc(0)).toString('base64'),
        fullHashDetails: f.filter((x) => x.field === 2 && x.wire === 2).map((d) => {
          const df = readFields(d.value);
          const attributes = [];
          for (const a of df.filter((x) => x.field === 2)) {
            // repeated enum: one number each, or several packed into one chunk
            const nums = a.wire === 0 ? [a.value] : [...a.value];
            for (const n of nums) attributes.push(THREAT_ATTRIBUTES[n] || 'THREAT_ATTRIBUTE_UNSPECIFIED');
          }
          return { threatType: THREAT_TYPES[pick(df, 1) || 0] || 'THREAT_TYPE_UNSPECIFIED', attributes };
        }),
      };
    }),
    cacheDuration: durationText(pick(top, 2)),
  };
}

// ---------------------------------------------------------------- URL expressions

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

function unescapeFully(s) {
  for (let i = 0; i < 16; i++) {
    const next = s.replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    if (next === s) break;
    s = next;
  }
  return s;
}

function escapeCanonical(s) {
  let out = '';
  for (const ch of Buffer.from(s, 'latin1')) {
    out += ch <= 32 || ch >= 127 || ch === 0x23 || ch === 0x25 ? '%' + ch.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(ch);
  }
  return out;
}

/** The host-suffix / path-prefix expressions Safe Browsing checks for a URL (at most 30). */
function expressions(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl).replace(/[\t\r\n]/g, '')); } catch { return []; }
  if (!/^https?:$/.test(u.protocol)) return [];
  const host = u.hostname.toLowerCase().replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.');
  if (!host) return [];

  const pathOnly = escapeCanonical(unescapeFully(u.pathname).replace(/\/{2,}/g, '/')) || '/';
  const query = u.search ? '?' + escapeCanonical(unescapeFully(u.search.slice(1))) : '';

  const hosts = [host];
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!isIp) {
    const parts = host.split('.');
    const base = parts.length > 2 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
    for (let n = Math.min(parts.length - 1, 5); n >= base && hosts.length < 5; n--) hosts.push(parts.slice(-n).join('.'));
  }

  const paths = [];
  const add = (p) => { if (!paths.includes(p) && paths.length < 6) paths.push(p); };
  if (query) add(pathOnly + query);
  add(pathOnly);
  const segments = pathOnly.split('/').slice(1, -1); // directory components only
  let prefix = '/';
  add(prefix);
  for (const seg of segments.slice(0, 3)) { prefix += seg + '/'; add(prefix); }

  const out = [];
  for (const h of hosts) for (const p of paths) out.push(h + p);
  return out;
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'latin1').digest();

function hasPrefix(sorted, value) {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === value) return true;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

const seconds = (duration) => { const n = parseFloat(String(duration || '')); return Number.isFinite(n) ? n * 1000 : 0; };

// ---------------------------------------------------------------- client

class SafeBrowsing {
  /** getKey: () => string|null.  fetch: (url, init) => Promise<Response>. */
  constructor({ userData, getKey, fetch, isEnabled }) {
    this.dir = userData;
    this.getKey = getKey;
    this.fetch = fetch;
    this.isEnabled = isEnabled;
    this.lists = new Map();   // name -> Uint32Array (sorted)
    this.versions = {};       // name -> opaque version from Google
    this.cache = new Map();   // prefix -> { expires, hits: [{ hash(hex), kind }] }
    this.updated = 0;
    this.nextUpdate = 0;
    this.error = '';
    this.timer = null;
    this.load();
  }

  get active() { return this.isEnabled() && !!this.getKey() && this.lists.size > 0; }

  file(name) { return path.join(this.dir, `gsb-${name}.bin`); }
  stateFile() { return path.join(this.dir, 'gsb-state.json'); }

  load() {
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
      for (const name of LISTS) {
        if (!st.versions || !st.versions[name]) continue;
        const buf = fs.readFileSync(this.file(name));
        this.lists.set(name, new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
        this.versions[name] = st.versions[name];
      }
      this.updated = st.updated || 0;
    } catch { this.lists.clear(); this.versions = {}; }
  }

  save() {
    for (const [name, arr] of this.lists) fs.writeFileSync(this.file(name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    fs.writeFileSync(this.stateFile(), JSON.stringify({ versions: this.versions, updated: this.updated }));
  }

  /** Forgets everything downloaded (used when the key is removed). */
  reset() {
    clearTimeout(this.timer);
    this.lists.clear(); this.versions = {}; this.cache.clear(); this.updated = 0; this.error = '';
    for (const name of LISTS) { try { fs.unlinkSync(this.file(name)); } catch { /* none */ } }
    try { fs.unlinkSync(this.stateFile()); } catch { /* none */ }
  }

  status() {
    const counts = {};
    for (const [name, arr] of this.lists) counts[name] = arr.length;
    return { hasKey: !!this.getKey(), enabled: this.isEnabled(), lists: counts, updated: this.updated, error: this.error, host: API_HOST };
  }

  async request(pathAndQuery, read) {
    const res = await this.fetch(`${API}/${pathAndQuery}`, {
      headers: { 'x-goog-api-key': this.getKey() },
      credentials: 'omit',
      signal: AbortSignal.timeout(60000),
    });
    const body = Buffer.from(await res.arrayBuffer());
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (!res.ok || type.includes('json')) {
      let json = null;
      try { json = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ }
      if (!res.ok) throw new Error((json && json.error && json.error.message) || `Google answered with HTTP ${res.status}`);
      if (json) return json;
    }
    try { return read(body); } catch (err) { throw new Error('Could not read Google\'s reply: ' + err.message); }
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update().catch(() => {}), Math.max(MIN_WAIT, ms || DEFAULT_WAIT));
    if (this.timer.unref) this.timer.unref();
  }

  /** Downloads list changes from Google. Safe to call often; it does nothing without a key. */
  async update() {
    if (!this.isEnabled() || !this.getKey()) return;
    let wait = DEFAULT_WAIT;
    try {
      const q = new URLSearchParams();
      for (const name of LISTS) { q.append('names', name); q.append('version', this.versions[name] || ''); }
      const data = await this.request('hashLists:batchGet?' + q, readBatch);
      for (const list of data.hashLists || []) {
        if (!LISTS.includes(list.name)) continue;
        const additions = decodeRice(list.additionsFourBytes);
        const hasAdditions = !!list.additionsFourBytes;
        let current = list.partialUpdate ? (this.lists.get(list.name) || new Uint32Array(0)) : new Uint32Array(0);
        if (list.partialUpdate && list.compressedRemovals) {
          const remove = new Set(decodeRice(list.compressedRemovals));
          current = current.filter((_v, i) => !remove.has(i));
        }
        let merged = current;
        if (hasAdditions) {
          merged = new Uint32Array(current.length + additions.length);
          merged.set(current);
          merged.set(additions, current.length);
          merged.sort();
        }
        if (list.sha256Checksum) {
          const bytes = Buffer.alloc(merged.length * 4);
          merged.forEach((v, i) => bytes.writeUInt32BE(v, i * 4));
          const sum = crypto.createHash('sha256').update(bytes).digest('base64');
          if (sum !== list.sha256Checksum) { // out of step with Google: start this list over next time
            this.lists.delete(list.name);
            delete this.versions[list.name];
            wait = MIN_WAIT;
            continue;
          }
        }
        this.lists.set(list.name, merged);
        this.versions[list.name] = list.version || '';
        const w = seconds(list.minimumWaitDuration);
        if (w) wait = Math.min(wait, w);
      }
      this.updated = Date.now();
      this.error = '';
      this.save();
    } catch (err) {
      this.error = String((err && err.message) || err).slice(0, 300);
    }
    this.schedule(wait);
  }

  /**
   * Checks an address. Returns null straight away when nothing matches the
   * local lists (the usual case), otherwise a promise for the threat kind
   * ('phishing' | 'malware' | 'unwanted') or null.
   */
  check(url) {
    if (!this.active) return null;
    const hashes = expressions(url).map(sha256);
    const matched = [];
    for (const h of hashes) {
      const prefix = h.readUInt32BE(0);
      for (const arr of this.lists.values()) {
        if (hasPrefix(arr, prefix)) { matched.push(prefix); break; }
      }
    }
    if (!matched.length) return null;
    return this.confirm([...new Set(matched)], hashes.map((h) => h.toString('hex')));
  }

  async confirm(prefixes, fullHex) {
    const now = Date.now();
    const verdict = (prefixList) => {
      const found = new Set();
      for (const p of prefixList) {
        const entry = this.cache.get(p);
        if (!entry || entry.expires < now) continue;
        for (const hit of entry.hits) if (fullHex.includes(hit.hash)) found.add(hit.kind);
      }
      // an address can be on several lists: report the most serious
      return ['malware', 'phishing', 'unwanted'].find((k) => found.has(k)) || null;
    };
    const cached = verdict(prefixes);
    if (cached) return cached;
    const unknown = prefixes.filter((p) => { const e = this.cache.get(p); return !e || e.expires < now; });
    if (!unknown.length) return null;
    try {
      const q = new URLSearchParams();
      for (const p of unknown) { const b = Buffer.alloc(4); b.writeUInt32BE(p); q.append('hashPrefixes', b.toString('base64')); }
      const data = await this.request('hashes:search?' + q, readSearch);
      const expires = Date.now() + Math.max(60000, seconds(data.cacheDuration));
      for (const p of unknown) this.cache.set(p, { expires, hits: [] });
      for (const fh of data.fullHashes || []) {
        const raw = Buffer.from(fh.fullHash || '', 'base64');
        if (raw.length !== 32) continue;
        const entry = this.cache.get(raw.readUInt32BE(0));
        if (!entry) continue;
        for (const d of fh.fullHashDetails || []) {
          const attrs = d.attributes || [];
          if (attrs.includes('CANARY') || attrs.includes('THREAT_ATTRIBUTE_UNSPECIFIED')) continue;
          if (KIND[d.threatType]) entry.hits.push({ hash: raw.toString('hex'), kind: KIND[d.threatType] });
        }
      }
      if (this.cache.size > 5000) this.cache.clear();
    } catch (err) {
      this.error = String((err && err.message) || err).slice(0, 300);
      return null; // per the protocol: if Google cannot be asked, treat as safe
    }
    return verdict(prefixes);
  }
}

module.exports = { SafeBrowsing, decodeRice, encodeRice, expressions, readBatch, readSearch, API_HOST, LISTS };
