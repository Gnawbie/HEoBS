'use strict';

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function fill(sectionId, listId, items) {
  if (!items.length) return;
  const list = document.getElementById(listId);
  for (const it of items) {
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = it.url;
    a.title = it.url;
    const b = document.createElement('b');
    b.textContent = it.title || host(it.url);
    const s = document.createElement('span');
    s.textContent = host(it.url);
    a.append(b, s);
    list.append(a);
  }
  document.getElementById(sectionId).hidden = false;
}

document.getElementById('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = await window.heobs.call('resolve', document.getElementById('q').value);
  if (url) location.href = url;
});

(async () => {
  const [bookmarks, history] = await Promise.all([window.heobs.call('bookmarks'), window.heobs.call('history')]);
  fill('bookmarks-section', 'bookmarks', bookmarks.slice(0, 12));

  // Most recent visit per site, newest first.
  const seen = new Set();
  const recent = [];
  for (const h of history) {
    const key = host(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(h);
    if (recent.length === 8) break;
  }
  fill('recent-section', 'recent', recent);
})();
