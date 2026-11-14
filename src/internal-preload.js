// Preload for every tab.
//  - heobs:// pages get an API to the browser (the main process re-checks
//    the caller, so a website cannot use it even if it found a way in).
//  - Ordinary pages get nothing exposed. This script only watches for login
//    forms so HEoBS can offer to save a password and fill saved ones. It runs
//    in an isolated world: page scripts cannot see or call any of it.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'heobs:') {
  contextBridge.exposeInMainWorld('heobs', {
    call: (name, ...args) => ipcRenderer.invoke('heobs', name, ...args),
  });
} else if (
  window === window.top &&
  (location.protocol === 'https:' || (location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname)))
) {
  const TEXT_TYPES = ['', 'text', 'email', 'tel'];
  const isText = (i) => TEXT_TYPES.includes((i.getAttribute('type') || '').toLowerCase());
  const visible = (el) => el.getClientRects().length > 0;

  const findUserField = (pw) => {
    const inputs = [...(pw.form || document).querySelectorAll('input')].filter(isText);
    const tagged = inputs.find((i) => /username|email/.test(i.autocomplete || ''));
    if (tagged) return tagged;
    let best = null;
    for (const i of inputs) {
      if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = i;
    }
    return best;
  };

  // ---- offer to save

  const capture = () => {
    const pw = [...document.querySelectorAll('input[type=password]')].find((p) => p.value);
    if (!pw) {
      // Two-step logins: remember the username typed on the first step.
      const u = document.querySelector('input[autocomplete~="username"], input[type=email]');
      if (u && u.value) ipcRenderer.send('pw:hint', u.value);
      return;
    }
    const user = findUserField(pw);
    ipcRenderer.send('pw:submit', { username: user ? user.value : '', password: pw.value });
  };

  document.addEventListener('submit', capture, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') capture();
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button, input[type=submit], [role=button]');
    if (!b) return;
    const label = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
    const isSubmit = (b.type === 'submit' && b.form) || /log ?in|sign ?in|sign ?up|continue|next|submit|register|create/i.test(label);
    if (isSubmit) capture();
  }, true);

  // ---- fill saved logins

  const filled = new WeakSet();
  let creds; // fetched once per page, and only if the page has a password field

  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    filled.add(input);
  };

  const fill = async () => {
    const pw = [...document.querySelectorAll('input[type=password]')]
      .find((p) => !p.value && !filled.has(p) && visible(p) && p.autocomplete !== 'new-password');
    if (!pw) return;
    if (creds === undefined) creds = await ipcRenderer.invoke('pw:query').catch(() => []);
    if (!creds || !creds.length) return;
    const c = creds[0];
    const user = findUserField(pw);
    if (user && !user.value && c.username) setValue(user, c.username);
    if (!user || !c.username || user.value === c.username) setValue(pw, c.password);
  };

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(fill, 300); };
  window.addEventListener('DOMContentLoaded', () => {
    schedule();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  });
}
