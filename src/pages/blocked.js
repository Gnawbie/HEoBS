'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const kind = ['malware', 'unwanted'].includes(params.get('kind')) ? params.get('kind') : 'phishing';
const fromGoogle = params.get('source') === 'google';

document.getElementById('url').textContent = url;
document.getElementById('why').textContent = {
  malware: 'This site is on a list of sites known to distribute malware. Opening it could infect this PC.',
  unwanted: 'This site is on a list of sites that push unwanted or deceptive software.',
  phishing: 'This site is on a list of known phishing sites. It may be imitating a real site to steal your passwords or card details.',
}[kind];
if (fromGoogle) {
  document.getElementById('google').hidden = false;
  document.getElementById('note').textContent = 'HEoBS matched this address against Google\'s list on this PC, then asked Google to confirm using a 4-byte fingerprint. The address itself was not sent.';
}
document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back(); else location.replace('heobs://newtab/');
});
document.getElementById('proceed').addEventListener('click', async () => {
  if (!/^https?:\/\//i.test(url)) return;
  await window.heobs.call('threat.proceed', url);
  location.replace(url);
});
