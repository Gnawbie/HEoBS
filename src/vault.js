// Encrypted password vault.
//
// Every entry (site, username, password) lives in one blob encrypted with
// AES-256-GCM under a random 256-bit vault key. Nothing is stored in clear.
// How the vault key itself is protected depends on the lock mode:
//
//   none   - key is sealed by Windows (DPAPI, via Electron safeStorage), so
//            only this Windows account can open it. Unlocks automatically.
//   hello  - same sealing, but HEoBS refuses to unseal until Windows Hello
//            (PIN / fingerprint / face) confirms it is you.
//   master - key is first encrypted with a key derived from your master
//            password (scrypt, N=2^17), then sealed by Windows on top.
//            Without the password the vault cannot be decrypted at all.
const crypto = require('node:crypto');
const fs = require('node:fs');

const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 320 * 1024 * 1024 };
const MODES = ['none', 'hello', 'master'];

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function open(key, box) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
}

class Vault {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    this.key = null;
    this.entries = [];
    this.meta = null;
  }

  get mode() { return this.meta.mode; }
  get locked() { return !this.key; }

  init() {
    if (!this.safe.isEncryptionAvailable()) throw new Error('OS encryption is not available');
    try { this.meta = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.meta = null; }
    if (!this.meta) {
      this.key = crypto.randomBytes(32);
      this.meta = { v: 1, mode: 'none' };
      this.wrapKey('none');
      this.persist();
    } else if (this.meta.mode === 'none') {
      this.unlockSealed();
    }
  }

  // ---- key wrapping

  wrapKey(mode, password) {
    let inner;
    if (mode === 'master') {
      const salt = crypto.randomBytes(16);
      const kek = crypto.scryptSync(password, salt, 32, SCRYPT);
      inner = JSON.stringify({ salt: salt.toString('base64'), box: seal(kek, this.key) });
    } else {
      inner = JSON.stringify({ key: this.key.toString('base64') });
    }
    this.meta.mode = mode;
    this.meta.wrapped = this.safe.encryptString(inner).toString('base64');
  }

  unwrapped() {
    return JSON.parse(this.safe.decryptString(Buffer.from(this.meta.wrapped, 'base64')));
  }

  load() {
    this.entries = this.meta.data ? JSON.parse(open(this.key, this.meta.data).toString('utf8')) : [];
  }

  /** For modes none/hello. The caller is responsible for the Hello check. */
  unlockSealed() {
    if (this.meta.mode === 'master') throw new Error('Master password required');
    this.key = Buffer.from(this.unwrapped().key, 'base64');
    this.load();
  }

  unlockMaster(password) {
    const inner = this.unwrapped();
    const kek = crypto.scryptSync(String(password), Buffer.from(inner.salt, 'base64'), 32, SCRYPT);
    let key;
    try { key = open(kek, inner.box); } catch { return false; }
    this.key = key;
    this.load();
    return true;
  }

  lock() {
    if (this.meta.mode === 'none') return;
    this.key = null;
    this.entries = [];
  }

  setMode(mode, password) {
    if (this.locked) throw new Error('Vault is locked');
    if (!MODES.includes(mode)) throw new Error('Unknown mode');
    if (mode === 'master' && (typeof password !== 'string' || password.length < 8)) {
      throw new Error('Master password must be at least 8 characters');
    }
    this.wrapKey(mode, password);
    this.persist();
  }

  persist() {
    if (this.locked) throw new Error('Vault is locked');
    this.meta.data = seal(this.key, Buffer.from(JSON.stringify(this.entries), 'utf8'));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.meta));
    fs.renameSync(tmp, this.file);
  }

  // ---- entries

  find(origin) {
    return this.entries.filter((e) => e.origin === origin).sort((a, b) => (b.used || 0) - (a.used || 0));
  }

  save({ origin, username, password }, { persist = true } = {}) {
    const existing = this.entries.find((e) => e.origin === origin && e.username === username);
    if (existing) {
      if (existing.password === password) return false;
      existing.password = password;
      existing.used = Date.now();
    } else {
      this.entries.push({ id: crypto.randomUUID(), origin, username, password, created: Date.now(), used: Date.now() });
    }
    if (persist) this.persist();
    return true;
  }

  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.persist();
  }
}

module.exports = { Vault };
