// Ad blocking, built on the open-source Ghostery filter engine with the
// EasyList, EasyPrivacy and uBlock Origin filter lists.
//
// Beyond cancelling ad requests it also:
//  - hides the empty boxes ads leave behind (cosmetic filters);
//  - defuses many "please turn off your ad blocker" detectors, by handing
//    the page harmless stand-ins for the ad scripts it probes for and by
//    neutralising known detection scripts (uBlock Origin's scriptlets).
// No blocker beats every detector; the shield menu can switch blocking off
// for a single site when one gets through.
const fs = require('node:fs');
const path = require('node:path');
const { ElectronBlocker, adsAndTrackingLists } = require('@ghostery/adblocker-electron');

const LIST_HOST = 'raw.githubusercontent.com';
const MAX_AGE = 4 * 24 * 3600 * 1000;

// HEoBS additions on top of the public lists. The lists only disguise a
// blocked ad script on sites already known to check for it. These rules do it
// everywhere: whenever a script, image or data request is blocked, the page is
// handed a harmless stand-in instead of an error, which is what most
// "ad blocker detected" checks look for. ("redirect-rule" never blocks
// anything by itself; it only changes how an already-blocked request ends.)
const STAND_IN_RULES = [
  '||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js$script,redirect-rule=googlesyndication_adsbygoogle.js:10',
  '||googletagservices.com/tag/js/gpt.js$script,redirect-rule=googletagservices_gpt.js:10',
  '||securepubads.g.doubleclick.net/tag/js/gpt.js$script,redirect-rule=googletagservices_gpt.js:10',
  '||google-analytics.com/analytics.js$script,redirect-rule=google-analytics_analytics.js:10',
  '||googletagmanager.com/gtm.js$script,redirect-rule=googletagmanager_gtm.js:10',
  '||imasdk.googleapis.com/js/sdkloader/ima3.js$script,redirect-rule=google-ima.js:10',
  '||amazon-adsystem.com/aax2/apstag.js$script,redirect-rule=amazon_apstag.js:10',
  '*$script,redirect-rule=noopjs',
  '*$image,redirect-rule=1x1.gif',
  '*$xmlhttprequest,redirect-rule=nooptext',
];

class AdBlock {
  constructor({ userData, fetch, isActiveFor }) {
    this.file = path.join(userData, 'adblock-engine.bin');
    this.fetch = fetch;
    this.isActiveFor = isActiveFor; // (pageUrl) => boolean
    this.engine = null;
    this.date = 0;
  }

  get ready() { return !!this.engine; }

  /** Loads the saved engine if there is one; downloads fresh lists when it is missing or old. */
  async load() {
    let cached = null;
    try {
      this.date = fs.statSync(this.file).mtimeMs;
      cached = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(this.file)));
    } catch { this.date = 0; }

    if (cached && Date.now() - this.date < MAX_AGE) { this.engine = cached; return; }

    const download = ElectronBlocker.fromLists(this.fetch, adsAndTrackingLists).then((fresh) => {
      fs.writeFileSync(this.file, fresh.serialize());
      this.date = Date.now();
      return fresh;
    });
    if (cached) {
      // Use the older lists now; the fresh ones are saved for the next start.
      this.engine = cached;
      download.catch(() => {});
    } else {
      this.engine = await download; // first run: nothing to fall back on
    }
  }

  /** Turns on page-level filtering (hiding ad boxes, defusing detectors) for a session. */
  enable(ses) {
    const engine = this.engine;
    try { engine.updateFromDiff({ added: STAND_IN_RULES }); } catch (err) { console.error('Stand-in rules were not applied:', err && err.message); }
    const inject = engine.onInjectCosmeticFilters;
    engine.onInjectCosmeticFilters = async (event, url, msg) => {
      if (!/^https?:/i.test(String(url))) return undefined;
      let top = url;
      try { top = event.sender.getURL() || url; } catch { /* page gone */ }
      if (!this.isActiveFor(top)) return undefined;
      return inject(event, url, msg);
    };
    // This also installs the engine's own request hooks; HEoBS replaces them
    // straight afterwards with its combined handler (see privacy.js).
    engine.enableBlockingInSession(ses);
  }
}

module.exports = { AdBlock, LIST_HOST };
