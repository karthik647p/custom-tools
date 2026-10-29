export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pad = (n) => String(n).padStart(2, '0');

/** 1:05:09 or 05:09. `round` is 'ceil' (countdowns) or 'floor' (count-ups). */
export function clock(ms, round = 'ceil') {
  const total = Math.max(0, Math[round](ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 90 -> "1m 30s", 3600 -> "1h", 30 -> "30s" */
export function shortDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}

/** Pick the friendliest unit for editing a number of seconds. */
export function splitDur(secs) {
  if (secs % 3600 === 0) return { value: secs / 3600, unit: 3600 };
  if (secs % 60 === 0) return { value: secs / 60, unit: 60 };
  return { value: secs, unit: 1 };
}

/** A "[number] [sec|min|hr]" input. Calls onChange(seconds) with valid values. */
export function durField(secs, onChange, label = 'Duration') {
  const { value, unit } = splitDur(secs);
  const wrap = document.createElement('span');
  wrap.className = 'durfield';
  wrap.innerHTML =
    `<input type="text" inputmode="decimal" aria-label="${label} amount">` +
    `<select aria-label="${label} unit"><option value="1">sec</option><option value="60">min</option><option value="3600">hr</option></select>`;
  const input = wrap.querySelector('input');
  const select = wrap.querySelector('select');
  input.value = value;
  select.value = unit;
  const fire = () => {
    const n = parseFloat(input.value.replace(',', '.'));
    const s = Math.round((Number.isFinite(n) ? n : 0) * Number(select.value));
    if (s >= 1) onChange(s);
  };
  input.addEventListener('input', fire);
  input.addEventListener('focus', () => input.select());
  select.addEventListener('change', fire);
  return wrap;
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export const icons = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24"><path d="M8.7 3A6 6 0 0 1 18 8c0 2.7.6 4.6 1.3 6M17 17H3s3-2 3-9a4.7 4.7 0 0 1 .3-1.7"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M4 22V4M4 4h13l-2 4.5 2 4.5H4"/></svg>',
  timer: '<svg viewBox="0 0 24 24"><path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/></svg>',
  stopwatch: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};
