'use strict';

const list = document.getElementById('list');
const filter = document.getElementById('filter');
let entries = [];

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function render() {
  const q = filter.value.trim().toLowerCase();
  const shown = entries
    .filter((h) => !q || h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q))
    .slice(0, 500);
  list.textContent = '';
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = q ? 'No matching pages.' : 'Pages you visit will appear here.';
    list.append(p);
    return;
  }
  let day = '';
  for (const h of shown) {
    const date = new Date(h.time);
    const label = date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (label !== day) {
      day = label;
      const h2 = document.createElement('h2');
      h2.textContent = label;
      list.append(h2);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const time = document.createElement('time');
    time.textContent = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const a = document.createElement('a');
    a.href = h.url;
    a.title = h.url;
    a.textContent = h.title || h.url;
    const site = document.createElement('span');
    site.className = 'host';
    site.textContent = host(h.url);
    const del = document.createElement('button');
    del.title = 'Remove from history';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      await window.heobs.call('removeHistory', h.url, h.time);
      entries = entries.filter((x) => x !== h);
      render();
    });
    row.append(time, a, site, del);
    list.append(row);
  }
}

filter.addEventListener('input', render);
document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Clear all browsing history?')) return;
  await window.heobs.call('clearHistory');
  entries = [];
  render();
});

window.heobs.call('history').then((data) => { entries = data; render(); });
