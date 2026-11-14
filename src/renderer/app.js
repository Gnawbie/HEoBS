'use strict';

const $ = (sel) => document.querySelector(sel);
const send = window.browser.send;

const tabsEl = $('#tabs');
const address = $('#address');
const security = $('#security');
const reloadBtn = $('#reload');
const star = $('#star');
const bookmarksEl = $('#bookmarks');
const downloadBtn = $('#download');
const findbar = $('#findbar');
const findText = $('#findtext');
const findCount = $('#findcount');
const shield = $('#shield');
const keyBtn = $('#key');
const pwbar = $('#pwbar');

// ---------------------------------------------------------------- save password

function hidePasswordBar(answer) {
  if (pwbar.hidden) return;
  pwbar.hidden = true;
  send('passwordAnswer', answer);
}
window.browser.on('pw-prompt', (p) => {
  const who = p.username ? '“' + p.username + '” on ' + p.host : p.host;
  $('#pwtext').textContent = (p.update ? 'Update the saved password for ' : 'Save the password for ') + who + '?';
  $('#pwsave').textContent = p.update ? 'Update' : 'Save';
  pwbar.hidden = false;
});
$('#pwsave').addEventListener('click', () => hidePasswordBar(true));
$('#pwno').addEventListener('click', () => hidePasswordBar(false));

const CLOSE_SVG = '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>';

let state = { tabs: [], activeId: null, url: '' };
let dirty = false; // user has typed in the address bar since the last navigation
const tabEls = new Map();

// ---------------------------------------------------------------- tabs

function makeTab(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.innerHTML = `<span class="fav"></span><span class="title"></span><button class="icon close" title="Close tab (Ctrl+W)">${CLOSE_SVG}</button>`;
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close')) send('selectTab', id);
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) send('closeTab', id); });
  el.querySelector('.close').addEventListener('click', () => send('closeTab', id));
  return el;
}

function setFavicon(holder, tab) {
  const key = tab.loading ? 'spin' : tab.favicon || 'dot';
  if (holder.dataset.key === key) return;
  holder.dataset.key = key;
  holder.textContent = '';
  if (tab.loading || !tab.favicon) {
    const d = document.createElement('span');
    d.className = tab.loading ? 'spin' : 'dot';
    holder.append(d);
  } else {
    const img = document.createElement('img');
    img.src = tab.favicon;
    img.onerror = () => { holder.dataset.key = ''; setFavicon(holder, { ...tab, favicon: null }); };
    holder.append(img);
  }
}

function renderTabs() {
  const seen = new Set();
  state.tabs.forEach((tab, i) => {
    seen.add(tab.id);
    let el = tabEls.get(tab.id);
    if (!el) { el = makeTab(tab.id); tabEls.set(tab.id, el); }
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
    el.classList.toggle('active', tab.id === state.activeId);
    el.title = tab.title;
    el.querySelector('.title').textContent = tab.title;
    setFavicon(el.querySelector('.fav'), tab);
  });
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) { el.remove(); tabEls.delete(id); }
  }
}

// ---------------------------------------------------------------- toolbar

function renderSecurity(url) {
  security.className = '';
  if (url.startsWith('https://')) { security.textContent = 'Secure'; security.className = 'secure'; }
  else if (url.startsWith('http://')) { security.textContent = 'Not secure'; security.className = 'insecure'; }
  else if (url.startsWith('file://')) security.textContent = 'File';
  else security.textContent = '';
}

function chip(label, cls) {
  const el = document.createElement('button');
  el.className = 'bm ' + (cls || '');
  const span = document.createElement('span');
  span.textContent = label;
  el.append(span);
  return el;
}

function renderBookmarks() {
  const list = state.bookmarks || [];
  bookmarksEl.hidden = list.length === 0 && !state.hasOtherBookmarks;
  bookmarksEl.textContent = '';
  const chips = list.map((b, i) => {
    const el = chip(b.title, b.folder ? 'folder' : '');
    el.title = b.folder ? b.title : b.title + '\n' + b.url;
    if (b.favicon) {
      const img = document.createElement('img');
      img.src = b.favicon;
      img.onerror = () => img.remove();
      el.prepend(img);
    }
    if (b.folder) el.addEventListener('click', () => send('bookmarkDropdown', 'folder', i));
    else {
      el.addEventListener('click', (e) => send('openBookmark', i, e.ctrlKey));
      el.addEventListener('auxclick', (e) => { if (e.button === 1) send('openBookmark', i, true); });
    }
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); send('bookmarkMenu', i); });
    bookmarksEl.append(el);
    return el;
  });

  const more = chip('»', 'extra');
  more.title = 'More bookmarks';
  more.hidden = true;
  bookmarksEl.append(more);
  if (state.hasOtherBookmarks) {
    const other = chip('Other bookmarks', 'extra folder');
    other.addEventListener('click', () => send('bookmarkDropdown', 'other', 0));
    bookmarksEl.append(other);
  }
  fitBookmarks(chips, more);
}

// Hide chips that do not fit and offer them from the » menu instead.
function fitBookmarks(chips, more) {
  if (bookmarksEl.hidden) return;
  for (const c of chips) { c.hidden = false; c.style.flexShrink = '0'; }
  more.hidden = true;
  const others = [...bookmarksEl.querySelectorAll('.extra')].filter((e) => e !== more);
  const reserved = others.reduce((w, e) => w + e.offsetWidth + 2, 0) + 16;
  const limit = bookmarksEl.clientWidth - reserved;
  let firstHidden = chips.findIndex((c) => c.offsetLeft + c.offsetWidth > limit);
  if (firstHidden < 0) return;
  // Leave room for the » button itself.
  while (firstHidden > 0 && chips[firstHidden - 1].offsetLeft + chips[firstHidden - 1].offsetWidth > limit - 40) firstHidden--;
  chips.slice(firstHidden).forEach((c) => { c.hidden = true; });
  more.hidden = false;
  more.onclick = () => send('bookmarkDropdown', 'overflow', firstHidden);
}

window.browser.on('state', (next) => {
  const switched = next.activeId !== state.activeId;
  const navigated = next.url !== state.url;
  const bookmarksChanged = JSON.stringify([next.bookmarks, next.hasOtherBookmarks]) !== JSON.stringify([state.bookmarks, state.hasOtherBookmarks]);
  state = next;

  renderTabs();
  if (switched || (navigated && !dirty)) {
    address.value = next.url;
    dirty = false;
  }
  renderSecurity(next.url);
  $('#back').disabled = !next.canGoBack;
  $('#forward').disabled = !next.canGoForward;
  reloadBtn.classList.toggle('loading', next.loading);
  reloadBtn.title = next.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
  star.classList.toggle('on', next.bookmarked);
  if (bookmarksChanged) renderBookmarks();
  address.placeholder = next.blank
    ? 'Search or enter address — the previous page stays open below until you press Enter'
    : 'Search or enter address';
  shield.classList.toggle('off', !next.shieldOn);
  $('#shieldcount').textContent = next.shieldOn && next.blocked ? String(next.blocked) : '';
  shield.title = !next.shieldOn
    ? 'Tracker blocking is off'
    : next.blocked + ' tracker request' + (next.blocked === 1 ? '' : 's') + ' blocked on this page';
  keyBtn.classList.toggle('locked', next.vaultLocked);
  keyBtn.title = next.vaultLocked ? 'Passwords (locked)' : 'Passwords';
  if (switched) hidePasswordBar(false);
  if (switched && !findbar.hidden) closeFind(false);
});

$('#newtab').addEventListener('click', () => send('newTab'));
$('#back').addEventListener('click', () => send('back'));
$('#forward').addEventListener('click', () => send('forward'));
reloadBtn.addEventListener('click', () => send(state.loading ? 'stop' : 'reload'));
star.addEventListener('click', () => send('toggleBookmark'));
$('#menu').addEventListener('click', () => send('appMenu'));
shield.addEventListener('click', () => send('shieldMenu'));
keyBtn.addEventListener('click', () => send('openPasswords'));
window.addEventListener('resize', () => renderBookmarks());
$('#tabstrip').addEventListener('dblclick', (e) => { if (e.target.id === 'tabs') send('newTab'); });

$('#omnibox').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!address.value.trim()) return;
  dirty = false;
  send('navigate', address.value);
  address.blur();
});
address.addEventListener('input', () => { dirty = true; });
address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    address.value = state.url;
    dirty = false;
    send('focusPage');
  }
});

window.browser.on('focus-address', () => { address.focus(); address.select(); });

// ---------------------------------------------------------------- downloads

let downloadPath = '';
window.browser.on('download', (d) => {
  downloadBtn.hidden = false;
  downloadBtn.className = '';
  downloadPath = '';
  if (d.state === 'completed') {
    downloadBtn.textContent = `✓ ${d.name}`;
    downloadBtn.title = 'Show in folder';
    downloadBtn.className = 'done';
    downloadPath = d.path;
  } else if (d.state === 'progressing') {
    const pct = d.total ? ` ${Math.floor((d.received / d.total) * 100)}%` : '';
    downloadBtn.textContent = `↓${pct} ${d.name}`;
    downloadBtn.title = 'Downloading…';
  } else {
    downloadBtn.textContent = `✕ ${d.name}`;
    downloadBtn.title = d.state === 'cancelled' ? 'Download cancelled' : 'Download interrupted';
    downloadBtn.className = 'failed';
  }
});
downloadBtn.addEventListener('click', () => {
  if (downloadPath) send('showDownload', downloadPath);
  else if (downloadBtn.className === 'failed') downloadBtn.hidden = true;
});

// ---------------------------------------------------------------- find in page

let lastFind = '';

function runFind(forward) {
  const text = findText.value;
  send('find', text, forward, text === lastFind && text !== '');
  lastFind = text;
}

function closeFind(refocus = true) {
  findbar.hidden = true;
  lastFind = '';
  findCount.textContent = '';
  if (refocus) send('stopFind');
}

window.browser.on('open-find', () => {
  findbar.hidden = false;
  findText.focus();
  findText.select();
});
window.browser.on('find-result', (r) => {
  findCount.textContent = findText.value ? `${r.current} / ${r.total}` : '';
});
findText.addEventListener('input', () => { lastFind = ''; runFind(true); });
findText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runFind(!e.shiftKey);
  else if (e.key === 'Escape') closeFind();
});
$('#findnext').addEventListener('click', () => runFind(true));
$('#findprev').addEventListener('click', () => runFind(false));
$('#findclose').addEventListener('click', () => closeFind());

// ---------------------------------------------------------------- layout

// Tell the main process how tall the UI is so it can place the page below it.
new ResizeObserver(() => send('chromeHeight', $('#chrome').offsetHeight)).observe($('#chrome'));
