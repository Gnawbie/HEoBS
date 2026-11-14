'use strict';

const call = window.heobs.call;
const $ = (id) => document.getElementById(id);
const MAX_SHORTCUTS = 20;

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

document.getElementById('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = await call('resolve', $('q').value);
  if (url) location.href = url;
});

// ---------------------------------------------------------------- shortcuts

const grid = $('shortcuts');
const editor = $('editor');
let shortcuts = [];
let editing = -1; // index being edited, or -1 when adding

function tile(sc, index) {
  const a = document.createElement('a');
  a.className = 'shortcut';
  a.href = sc.url;
  a.title = `${sc.title}\n${sc.url}`;

  const badge = document.createElement('span');
  const useDefault = () => {
    // HEoBS default: the stop-sign shape from the logo, with the site's initial.
    badge.className = 'badge default';
    badge.textContent = '';
    const letter = document.createElement('span');
    letter.textContent = (sc.title.trim()[0] || host(sc.url)[0] || '?').toUpperCase();
    badge.append(letter);
  };
  if (sc.icon) {
    badge.className = 'badge site';
    const img = document.createElement('img');
    img.alt = '';
    img.src = sc.icon;
    img.onerror = useDefault;
    badge.append(img);
  } else useDefault();

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = sc.title;

  const edit = document.createElement('button');
  edit.className = 'edit';
  edit.type = 'button';
  edit.title = 'Edit shortcut';
  edit.textContent = '⋮';
  edit.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openEditor(index); });

  a.append(badge, label, edit);
  return a;
}

function render() {
  grid.textContent = '';
  shortcuts.forEach((sc, i) => grid.append(tile(sc, i)));
  if (shortcuts.length < MAX_SHORTCUTS) {
    const add = document.createElement('button');
    add.className = 'shortcut add';
    add.type = 'button';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '+';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Add shortcut';
    add.append(badge, label);
    add.addEventListener('click', () => openEditor(-1));
    grid.append(add);
  }
}

function openEditor(index) {
  editing = index;
  const sc = shortcuts[index];
  $('editor-title').textContent = sc ? 'Edit shortcut' : 'Add shortcut';
  $('sc-name').value = sc ? sc.title : '';
  $('sc-url').value = sc ? sc.url : '';
  $('sc-remove').hidden = !sc;
  $('editor-msg').textContent = '';
  editor.showModal();
  $('sc-name').focus();
}

async function refresh() {
  shortcuts = await call('shortcuts.list');
  render();
}

$('editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await call('shortcuts.save', editing, $('sc-name').value, $('sc-url').value);
    editor.close();
    refresh();
  } catch (err) {
    $('editor-msg').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }
});
$('sc-cancel').addEventListener('click', () => editor.close());
$('sc-remove').addEventListener('click', async () => {
  await call('shortcuts.remove', editing);
  editor.close();
  refresh();
});

// ---------------------------------------------------------------- import from other browsers

const importer = $('importer');

async function renderSources() {
  const sources = await call('shortcuts.sources');
  $('import-row').hidden = sources.length === 0;
  const box = $('import-sources');
  box.textContent = '';
  for (const src of sources) {
    const row = document.createElement('div');
    row.className = 'row-card';
    const info = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = src.browser + (src.profile ? ` (${src.profile})` : '');
    const count = document.createElement('small');
    count.className = 'muted';
    count.textContent = `${src.count} shortcut${src.count === 1 ? '' : 's'}`;
    info.append(name, count);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Import';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Importing…';
      const msg = $('import-msg');
      try {
        const r = await call('shortcuts.import', src.id);
        msg.classList.remove('bad');
        msg.textContent = r.added
          ? `Imported ${r.added} shortcut${r.added === 1 ? '' : 's'} from ${src.browser}` + (r.skipped ? ` (${r.skipped} skipped: already here, or over the limit of 20).` : '.')
          : 'Nothing new to import: those shortcuts are already here, or the limit of 20 is reached.';
        refresh();
      } catch (err) {
        msg.classList.add('bad');
        msg.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      }
      btn.disabled = false;
      btn.textContent = 'Import';
    });
    row.append(info, btn);
    box.append(row);
  }
}

$('import-open').addEventListener('click', () => { $('import-msg').textContent = ''; importer.showModal(); });
$('import-close').addEventListener('click', () => importer.close());

refresh();
renderSources();

// ---------------------------------------------------------------- one-time welcome box

// A dialog inside the start page itself, so it is not a pop-up window and
// HEoBS's own pop-up blocker has nothing to stop.
(async () => {
  const state = await call('welcome.state');
  if (!state.show) return;
  const box = $('welcome');
  const msg = $('welcome-msg');
  const say = (text, bad) => { msg.textContent = text; msg.classList.toggle('bad', !!bad); };
  const clean = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  let recorded = false;
  const seen = () => { if (!recorded) { recorded = true; call('welcome.done'); } };
  const busy = (on) => { for (const id of ['welcome-paste', 'welcome-save']) $(id).disabled = on; };

  const attempt = async (action) => {
    busy(true);
    say('Checking the key with Google and downloading its lists…');
    try {
      await action();
      $('welcome-key').value = '';
      say('Key saved and working. Google Safe Browsing is on.');
      seen();
      setTimeout(() => box.close(), 1800);
    } catch (err) {
      $('welcome-key').value = '';
      say(clean(err), true);
    }
    busy(false);
  };

  $('welcome-save').addEventListener('click', () => attempt(() => call('gsb.setKey', $('welcome-key').value)));
  $('welcome-paste').addEventListener('click', () => attempt(() => call('gsb.pasteKey')));
  $('welcome-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('welcome-save').click(); } });
  $('welcome-later').addEventListener('click', () => { seen(); box.close(); });
  // Esc and any other way of closing count too. (The buttons record it themselves
  // because a tab that is not in front is only told about the close later.)
  box.addEventListener('cancel', seen);
  box.addEventListener('close', seen);
  box.showModal();
})();
