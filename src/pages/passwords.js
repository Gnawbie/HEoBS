'use strict';

const call = window.heobs.call;
const $ = (id) => document.getElementById(id);
const errorText = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

function say(id, text, bad = false) {
  const p = $(id);
  p.textContent = text;
  p.classList.toggle('bad', bad);
}

const MODES = [
  ['none', 'Windows account encryption', 'The vault key is sealed by Windows to your user account, so the file is useless on another PC or account. Unlocked whenever you are signed in to Windows — most convenient, least strict.'],
  ['hello', 'Windows Hello — PIN, fingerprint or face', 'Same sealing, plus HEoBS asks Windows to confirm it is you each time HEoBS starts before any password can be filled or shown.'],
  ['master', 'Master password', 'Strongest. The vault key is additionally encrypted with a key derived from a password only you know (scrypt). If you forget it, the passwords cannot be recovered by anyone.'],
];

let entries = [];
let status = null;

function renderList() {
  const q = $('filter').value.trim().toLowerCase();
  const list = $('list');
  list.textContent = '';
  const shown = entries.filter((e) => !q || e.origin.toLowerCase().includes(q) || e.username.toLowerCase().includes(q));
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = q ? 'No matching logins.' : 'No saved logins yet. HEoBS offers to save one when you sign in to a site.';
    list.append(p);
    return;
  }
  for (const e of shown) {
    const row = document.createElement('div');
    row.className = 'row-card';
    const info = document.createElement('span');
    const site = document.createElement('b');
    site.textContent = e.origin.replace(/^https:\/\//, '');
    const user = document.createElement('small');
    user.className = 'muted';
    user.textContent = e.username || '(no username)';
    const secret = document.createElement('code');
    secret.textContent = '••••••••';
    info.append(site, user, secret);

    const show = document.createElement('button');
    show.textContent = 'Show';
    show.addEventListener('click', async () => {
      if (show.textContent === 'Hide') { secret.textContent = '••••••••'; show.textContent = 'Show'; return; }
      const pw = await call('vault.reveal', e.id);
      if (pw === null) return refresh();
      secret.textContent = pw;
      show.textContent = 'Hide';
    });
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.title = 'Copies the password; the clipboard is cleared after 30 seconds';
    copy.addEventListener('click', async () => {
      if (await call('vault.copy', e.id)) { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }
    });
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the saved login for ${e.origin}?`)) return;
      await call('vault.remove', e.id);
      refresh();
    });
    row.append(info, show, copy, del);
    list.append(row);
  }
}

function renderModes() {
  const box = $('modes');
  box.textContent = '';
  for (const [id, title, detail] of MODES) {
    const label = document.createElement('label');
    label.className = 'choice';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'mode';
    radio.checked = status.mode === id;
    radio.disabled = id === 'hello' && !status.helloAvailable;
    radio.addEventListener('change', () => chooseMode(id));
    const text = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = title + (radio.disabled ? ' — not set up on this PC' : '');
    const small = document.createElement('small');
    small.className = 'muted';
    small.textContent = detail;
    text.append(b, small);
    label.append(radio, text);
    box.append(label);
  }
}

async function chooseMode(mode) {
  $('master-form').hidden = mode !== 'master';
  if (mode === 'master') { say('mode-msg', 'Choose a master password below to finish switching.'); $('new-master').focus(); return; }
  try {
    say('mode-msg', mode === 'hello' ? 'Waiting for Windows Hello… (check the taskbar if you do not see the prompt)' : '');
    await call('vault.setMode', mode);
    say('mode-msg', 'Lock method changed.');
  } catch (err) { say('mode-msg', errorText(err), true); }
  refresh();
}

$('master-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = $('new-master').value;
  if (a !== $('new-master2').value) return say('mode-msg', 'The two passwords do not match.', true);
  try {
    await call('vault.setMode', 'master', a);
    $('new-master').value = $('new-master2').value = '';
    $('master-form').hidden = true;
    say('mode-msg', 'Master password set. You will need it each time HEoBS starts.');
  } catch (err) { say('mode-msg', errorText(err), true); }
  refresh();
});

$('hello-btn').addEventListener('click', async () => {
  say('unlock-msg', 'Waiting for Windows Hello… (check the taskbar if you do not see the prompt)');
  const ok = await call('vault.unlockHello');
  say('unlock-msg', ok ? '' : 'Verification did not succeed.', !ok);
  refresh();
});

$('unlock-master').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await call('vault.unlock', $('master-input').value);
  $('master-input').value = '';
  say('unlock-msg', ok ? '' : 'Wrong master password.', !ok);
  refresh();
});

$('lock-btn').addEventListener('click', async () => { await call('vault.lock'); refresh(); });
$('filter').addEventListener('input', renderList);

async function refresh() {
  status = await call('vault.status');
  $('locked').hidden = !status.locked;
  $('unlocked').hidden = status.locked;
  if (status.locked) {
    $('unlock-hello').hidden = status.mode !== 'hello';
    $('unlock-master').hidden = status.mode !== 'master';
    if (status.mode === 'master') $('master-input').focus();
    return;
  }
  $('lock-btn').hidden = status.mode === 'none';
  entries = (await call('vault.list')) || [];
  renderList();
  renderModes();
}

refresh();
