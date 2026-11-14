'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';

document.getElementById('url').textContent = url;
document.getElementById('desc').textContent = `${params.get('desc') || 'Unknown error'} (${params.get('code') || '?'})`;
document.getElementById('retry').addEventListener('click', () => {
  if (/^https?:\/\//i.test(url)) location.replace(url);
});
