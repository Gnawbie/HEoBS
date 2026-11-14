// Preload for the browser's own UI (tab strip, toolbar).
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'focus-address', 'open-find', 'find-result', 'download', 'pw-prompt'];

contextBridge.exposeInMainWorld('browser', {
  send: (cmd, ...args) => ipcRenderer.send('chrome', cmd, ...args),
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
