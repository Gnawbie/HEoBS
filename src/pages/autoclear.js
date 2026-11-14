'use strict';

// Auto-clear picker. mountAutoClear(element, 'history' | 'cookies')
(() => {
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const PRESETS = [
    [0, 'Never'],
    [-1, 'When HEoBS closes'],
    [HOUR, 'Older than 1 hour'],
    [DAY, 'Older than 1 day'],
    [7 * DAY, 'Older than 7 days'],
    [30 * DAY, 'Older than 30 days'],
    [90 * DAY, 'Older than 90 days'],
  ];
  const UNITS = [[MIN, 'minutes'], [HOUR, 'hours'], [DAY, 'days']];

  window.mountAutoClear = async (box, kind) => {
    const current = (await window.heobs.call('autoclear.get'))[kind];
    box.textContent = '';
    box.className = 'autoclear';

    const select = document.createElement('select');
    for (const [ms, label] of PRESETS) select.add(new Option(label, String(ms)));
    select.add(new Option('Custom…', 'custom'));

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.step = '1';
    const unit = document.createElement('select');
    for (const [ms, label] of UNITS) unit.add(new Option(label, String(ms)));
    const apply = document.createElement('button');
    apply.textContent = 'Apply';
    const custom = document.createElement('span');
    custom.className = 'custom';
    custom.append('older than ', amount, unit, apply);
    const msg = document.createElement('span');
    msg.className = 'msg';

    const isPreset = PRESETS.some(([ms]) => ms === current);
    select.value = isPreset ? String(current) : 'custom';
    custom.hidden = isPreset;
    if (!isPreset) {
      const [ms] = [...UNITS].reverse().find(([u]) => current % u === 0) || UNITS[0];
      unit.value = String(ms);
      amount.value = String(Math.round(current / ms));
    } else { amount.value = '12'; unit.value = String(HOUR); }

    const save = async (ms) => {
      try {
        await window.heobs.call('autoclear.set', kind, ms);
        msg.classList.remove('bad');
        msg.textContent = ms === 0 ? 'Auto-clear is off.' : 'Saved.';
        box.dispatchEvent(new CustomEvent('autoclear-changed'));
      } catch (err) {
        msg.classList.add('bad');
        msg.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      }
    };
    select.addEventListener('change', () => {
      custom.hidden = select.value !== 'custom';
      if (select.value === 'custom') { msg.textContent = ''; amount.focus(); } else save(Number(select.value));
    });
    apply.addEventListener('click', () => save(Number(amount.value) * Number(unit.value)));
    amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply.click(); });

    box.append(select, custom, msg);
  };
})();
