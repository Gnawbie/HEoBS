'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const kind = params.get('kind') === 'malware' ? 'malware' : 'phishing';

document.getElementById('url').textContent = url;
document.getElementById('why').textContent = kind === 'malware'
  ? 'This site is on a list of sites known to distribute malware. Opening it could infect this PC.'
  : 'This site is on a list of known phishing sites. It may be imitating a real site to steal your passwords or card details.';
document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back(); else location.replace('heobs://newtab/');
});
document.getElementById('proceed').addEventListener('click', async () => {
  if (!/^https?:\/\//i.test(url)) return;
  await window.heobs.call('threat.proceed', url);
  location.replace(url);
});
