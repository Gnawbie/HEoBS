'use strict';

const call = window.heobs.call;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== ''));
  return node;
}

function say(id, text, bad = false) {
  const p = $(id);
  p.textContent = text;
  p.classList.toggle('bad', bad);
}

const errorText = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

const TOGGLES = [
  ['blockTrackers', 'Auto-block trackers from websites', 'Third-party requests from any page to known tracker and ad-server domains are stopped before they leave your PC.'],
  ['blockAddonTrackers', 'Auto-block trackers from add-ons', 'Every add-on is stopped from reaching known tracker domains. Turn off to decide add-on by add-on instead.'],
  ['blockThirdPartyCookies', 'Block third-party cookies', 'Cookies are neither sent to nor accepted from sites other than the one in the address bar. May break some embedded logins or widgets.'],
  ['stripTrackingParams', 'Strip tracking parameters from links', 'Removes tags such as utm_source, fbclid and gclid when you open a link.'],
  ['sendDoNotTrack', 'Send "Do Not Track" and Global Privacy Control signals', 'Asks sites not to track you or sell your data. Sites are not forced to obey.'],
  ['safeBrowsing', 'Warn me about dangerous sites', 'Checks every address against lists of known phishing and malware sites. The check happens on this PC; the lists are downloaded once a day.'],
  ['spellcheck', 'Check spelling as I type', 'Checked on this PC. The dictionary for your language is downloaded once from Google\'s servers.'],
  ['autoUpdateBlocklist', 'Update the tracker blocklist weekly', 'Downloads a fresh list from pgl.yoyo.org. Turn off for zero background connections.'],
];

async function render() {
  const data = await call('settings.get');
  const s = data.settings;

  // ---- search
  const engines = $('engines');
  engines.textContent = '';
  const isCustom = !data.engines.some((e) => e.url === s.searchUrl);
  for (const e of data.engines) {
    engines.append(el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'engine', checked: e.url === s.searchUrl, onchange: () => setSearch(e.url) }),
      el('span', {}, el('b', {}, e.name), el('small', { class: 'muted' }, e.note))));
  }
  if (isCustom) {
    engines.append(el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'engine', checked: true }),
      el('span', {}, el('b', {}, 'Custom'), el('small', { class: 'muted' }, s.searchUrl))));
    if (!$('custom-url').value) $('custom-url').value = s.searchUrl;
  }

  // ---- privacy
  const toggles = $('toggles');
  toggles.textContent = '';
  for (const [key, title, detail] of TOGGLES) {
    toggles.append(el('label', { class: 'choice' },
      el('input', { type: 'checkbox', checked: !!s[key], onchange: async (ev) => { await call('settings.set', key, ev.target.checked); render(); } }),
      el('span', {}, el('b', {}, title), el('small', { class: 'muted' }, detail))));
  }
  const p = data.privacy;
  $('privacy-stats').textContent =
    `Blocklist: ${p.listSize.toLocaleString()} domains, dated ${new Date(p.listDate).toLocaleDateString()}. ` +
    `Blocked since HEoBS started: ${p.blockedTotal.toLocaleString()} request${p.blockedTotal === 1 ? '' : 's'}.`;
  const top = $('top-blocked');
  top.textContent = '';
  if (p.topBlocked.length) {
    top.append(el('div', { class: 'tags' }, ...p.topBlocked.map(([host, n]) => el('span', { class: 'tag bad' }, `${host} ×${n}`))));
  }

  // ---- crash reports
  const c = await call('crash.list');
  $('crash-toggle').checked = c.enabled;
  $('crash-status').textContent =
    (c.enabled !== c.active ? 'Restart HEoBS for this change to take effect. ' : '') +
    `${c.dumps} crash dump${c.dumps === 1 ? '' : 's'} stored in ${c.folder}`;
  const crashes = $('crash-log');
  crashes.textContent = '';
  if (!c.log.length) crashes.append(el('p', { class: 'muted small' }, 'No crashes recorded.'));
  for (const item of c.log) {
    crashes.append(el('div', { class: 'row-card' }, el('span', {},
      el('b', {}, `${item.what} — ${item.reason}`),
      el('small', { class: 'muted' }, `${new Date(item.time).toLocaleString()} · exit code ${item.code}`))));
  }

  // ---- passwords
  const v = await call('vault.status');
  const modeName = { none: 'Windows account encryption (always unlocked)', hello: 'Windows Hello (PIN, fingerprint or face)', master: 'Master password' }[v.mode];
  $('vault-summary').textContent = `Lock method: ${modeName}. ` + (v.locked ? 'Currently locked.' : `${v.count} saved login${v.count === 1 ? '' : 's'}.`);

  // ---- add-ons
  renderAddons(data.addons, !!s.blockAddonTrackers);

  // ---- upfront
  const u = data.upfront;
  $('upfront-builtin').textContent = u.builtIn;
  const conns = $('upfront-connections');
  conns.textContent = '';
  for (const c of u.connections) {
    conns.append(el('div', { class: 'card' },
      el('b', {}, c.who),
      el('p', {}, c.why),
      c.note && el('p', { class: 'muted small' }, c.note),
      el('p', { class: 'muted small' }, 'Your control: ' + c.control)));
  }
  const absent = $('upfront-absent');
  absent.textContent = '';
  for (const a of u.absent) absent.append(el('li', {}, a));
  $('upfront-engine').textContent = u.engineNote;
  $('versions').textContent = `HEoBS ${data.versions.heobs} · Chromium ${data.versions.chromium} · Electron ${data.versions.electron}`;
}

async function setSearch(url) {
  try {
    await call('settings.set', 'searchUrl', url);
    say('search-msg', 'Search engine saved.');
  } catch (err) { say('search-msg', errorText(err), true); }
  render();
}

$('crash-toggle').addEventListener('change', async (e) => { await call('settings.set', 'crashReports', e.target.checked); render(); });
$('crash-open').addEventListener('click', () => call('crash.openFolder'));
$('crash-clear').addEventListener('click', async () => {
  if (!confirm('Delete all stored crash reports?')) return;
  await call('crash.clear');
  render();
});

$('custom-form').addEventListener('submit', (e) => { e.preventDefault(); setSearch($('custom-url').value); });

// ---------------------------------------------------------------- import

async function renderBrowsers() {
  const list = await call('import.detect');
  const box = $('browsers');
  box.textContent = '';
  if (!list.length) { box.append(el('p', { class: 'muted' }, 'No Chrome, Edge, Brave, Vivaldi or Opera profiles were found on this PC.')); return; }
  for (const b of list) {
    box.append(el('div', { class: 'row-card' },
      el('span', {}, el('b', {}, b.browser + (b.profile ? ` (${b.profile})` : '')),
        el('small', { class: 'muted' }, `${b.bar} on the bookmarks bar, ${b.other} other`)),
      el('button', {
        onclick: async () => {
          try {
            const n = await call('import.bookmarks', b.id);
            say('import-msg', n ? `Imported ${n} bookmark${n === 1 ? '' : 's'} from ${b.browser}.` : `Nothing new to import from ${b.browser}.`);
          } catch (err) { say('import-msg', errorText(err), true); }
        },
      }, 'Import bookmarks')));
  }
}

$('import-html').addEventListener('click', async () => {
  try {
    const n = await call('import.bookmarksHtml');
    if (n !== null) say('import-msg', `Imported ${n} bookmark${n === 1 ? '' : 's'} from the file.`);
  } catch (err) { say('import-msg', errorText(err), true); }
});

$('import-csv').addEventListener('click', async () => {
  try {
    const r = await call('import.passwordsCsv');
    if (!r) return;
    say('import-msg', r.total
      ? `Imported ${r.added} of ${r.total} login${r.total === 1 ? '' : 's'} (the rest were already saved). Now delete the export file — it is not encrypted: ${r.file}`
      : 'No logins were found in that file. It needs url, username and password columns.', !r.total);
    render();
  } catch (err) { say('import-msg', errorText(err), true); }
});

// ---------------------------------------------------------------- add-ons

function disclosure(a) {
  const tags = (items, cls) => (items.length
    ? el('div', { class: 'tags' }, ...items.map((t) => el('span', { class: 'tag ' + (cls || '') }, t)))
    : el('p', { class: 'muted small' }, 'None.'));
  const clean = a.domains.filter((d) => !a.trackers.includes(d));
  return [
    el('h4', {}, `Known trackers in its code (${a.trackers.length})`), tags(a.trackers, 'bad'),
    el('h4', {}, `Other domains its code mentions (${clean.length})`), tags(clean),
    el('h4', {}, 'Sites it can read and change'), tags(a.sites, a.sites.some((x) => x === '<all_urls>' || x.includes('*://*/')) ? 'warn' : ''),
    el('h4', {}, 'Browser permissions it asks for'), tags(a.permissions),
  ];
}

function renderAddons(list, enforced) {
  const box = $('addon-list');
  box.textContent = '';
  if (!list.length) { box.append(el('p', { class: 'muted' }, 'No add-ons installed.')); return; }
  for (const a of list) {
    const act = async (name, ...args) => {
      try { await call(name, a.path, ...args); say('addon-msg', ''); }
      catch (err) { say('addon-msg', errorText(err), true); }
      render();
    };
    const card = el('div', { class: 'card' },
      el('div', { class: 'row-card flat' },
        el('span', {}, el('b', {}, `${a.name} ${a.version || ''}`), el('small', { class: 'muted' }, a.path)),
        el('button', { onclick: () => act('addons.remove') }, 'Remove')),
      a.failed && el('p', { class: 'msg bad' }, 'This add-on could not be loaded.'),
      el('label', { class: 'choice' },
        el('input', { type: 'checkbox', checked: !!a.enabled, onchange: (e) => act('addons.setEnabled', e.target.checked) }),
        el('span', {}, el('b', {}, 'Add-on turned on'))),
      el('label', { class: 'choice' },
        el('input', { type: 'checkbox', checked: enforced || !!a.blockTrackers, disabled: enforced, onchange: (e) => act('addons.setBlockTrackers', e.target.checked) }),
        el('span', {}, el('b', {}, 'Block this add-on\'s trackers'),
          el('small', { class: 'muted' }, enforced
            ? 'Always on while "Auto-block trackers from add-ons" is enabled under Trackers.'
            : 'Stops the add-on from reaching any domain on the tracker blocklist.'))));
    if (a.domains) {
      card.append(...disclosure(a));
      card.append(el('h4', {}, 'What it has actually contacted since HEoBS started'));
      card.append(a.contacted.length
        ? el('div', { class: 'tags' }, ...a.contacted.map((c) => el('span', { class: 'tag ' + (c.tracker ? 'bad' : '') },
          `${c.host} ×${c.count}${c.blocked ? ' (blocked)' : ''}`)))
        : el('p', { class: 'muted small' }, 'Nothing yet.'));
    }
    box.append(card);
  }
}

$('addon-pick').addEventListener('click', async () => {
  const review = $('addon-review');
  try {
    const a = await call('addons.pick');
    if (!a) return;
    say('addon-msg', '');
    review.textContent = '';
    review.hidden = false;
    review.append(
      el('b', {}, `Review before installing: ${a.name} ${a.version}`),
      el('p', { class: 'muted small' }, a.path),
      ...disclosure(a),
      el('p', {},
        el('button', {
          class: 'primary',
          onclick: async () => {
            try { await call('addons.install', a.path); review.hidden = true; say('addon-msg', `${a.name} installed. Its trackers are blocked unless you allow them.`); }
            catch (err) { say('addon-msg', errorText(err), true); }
            render();
          },
        }, a.trackers.length ? `Install anyway (${a.trackers.length} tracker${a.trackers.length === 1 ? '' : 's'} will be blocked)` : 'Install'),
        ' ',
        el('button', { onclick: () => { review.hidden = true; } }, 'Cancel')));
  } catch (err) { say('addon-msg', errorText(err), true); }
});

render();
renderBrowsers();
