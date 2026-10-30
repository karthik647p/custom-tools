import { $, $$, clock, shortDur, durField, toast, icons } from '../util.js';
import { load, save, putFile, getFile, delFile } from '../storage.js';
import { alarm, keepAlive } from '../audio.js';

const DEFAULTS = {
  dur: 30,            // last used duration (seconds)
  label: '',
  sound: 'soft',      // soft | loud | custom
  volume: 0.8,
  mode: 'once',       // once | for | until
  forSecs: 60,        // how long to beep when mode === 'for'
  vibrate: true,
  adds: [30, 60, 300],// quick "add time" buttons on the finish screen (seconds)
  cycles: 1,          // repeat the countdown N times; last one rings the alarm
  wake: true,         // keep the screen on while running / ringing
  keepAlive: true,    // silent audio so the phone keeps the timer alive with screen off
  notify: false,
};
const MAX_SOUND_BYTES = 8 * 1024 * 1024;

let cfg = { ...DEFAULTS, ...load('timer.cfg', {}) };
let presets = load('timer.presets', [30, 60, 300, 600, 900]);
// st: { status: idle|running|paused|finished, total, endAt, left, cycle, cycles, dur }
let st = load('timer.state', { status: 'idle' });

let root;
let armed = null;       // alarm sound scheduled for the end of the current countdown
let testing = null;
let ringing = false;
let vibeTimer = 0;
let wakeLock = null;
let editingPresets = false;
let customAddSecs = 120;
let customName = '';

const saveCfg = () => save('timer.cfg', cfg);
const persist = () => save('timer.state', st);
const q = (sel) => $(sel, root);

/* ---------- alarm scheduling ---------- */

function soundOpts(isFinal) {
  const o = { kind: cfg.sound, volume: cfg.volume };
  if (!isFinal || cfg.mode === 'once') return o;               // single play
  if (cfg.mode === 'for') return { ...o, loop: true, seconds: cfg.forSecs };
  return { ...o, loop: true };                                  // until I stop it
}

function disarm() {
  armed?.stop();
  armed = null;
}

/** Queue the end-of-countdown sound on the audio clock so it fires on time even if JS is throttled. */
function arm() {
  disarm();
  if (st.status !== 'running') return;
  const delay = Math.max(0, (st.endAt - Date.now()) / 1000);
  const handle = alarm.play({ ...soundOpts(st.cycle >= st.cycles), delay });
  if (!handle) return;
  handle.onended = () => {
    if (armed === handle) { armed = null; setRinging(false); }
  };
  armed = handle;
}

function setRinging(on) {
  ringing = on;
  clearInterval(vibeTimer);
  if (on && cfg.vibrate && navigator.vibrate) {
    // browsers only allow vibration after the page has been tapped at least once
    const buzz = () => { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate([400, 200, 400]); };
    buzz();
    vibeTimer = setInterval(buzz, 1500);
  } else {
    navigator.vibrate?.(0);
  }
  syncRuntime();
  if (st.status === 'finished') renderFinish();
}

function silence() {
  disarm();
  setRinging(false);
  closeNotification();
}

/* ---------- screen / background / lock-screen ---------- */

async function holdScreen() {
  if (!cfg.wake || wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* denied, e.g. battery saver */ }
}

function freeScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function syncRuntime() {
  const active = st.status === 'running' || ringing;
  if (active) holdScreen(); else freeScreen();
  if (active && cfg.keepAlive) keepAlive.start(); else keepAlive.stop();
  if ('mediaSession' in navigator) {
    if (st.status === 'running') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: cfg.label || 'Timer running', artist: 'Custom Tools' });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('pause', () => pause());
    } else {
      navigator.mediaSession.playbackState = st.status === 'paused' ? 'paused' : 'none';
      if (st.status === 'paused') navigator.mediaSession.setActionHandler('play', () => resume());
    }
  }
}

function notifyDone() {
  if (!cfg.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.ready.then((reg) =>
    reg.showNotification("Time's up!", {
      body: cfg.label || shortDur(st.dur),
      tag: 'timer',
      requireInteraction: true,
      icon: 'icons/icon-192.png',
    }));
}

function closeNotification() {
  navigator.serviceWorker?.ready
    .then((reg) => reg.getNotifications({ tag: 'timer' }))
    .then((list) => list.forEach((n) => n.close()))
    .catch(() => {});
}

/* ---------- state machine ---------- */

function begin(secs, { cycle = 1, cycles = cfg.cycles, dur = secs } = {}) {
  alarm.unlock();
  silence();
  st = { status: 'running', total: secs * 1000, endAt: Date.now() + secs * 1000, left: 0, cycle, cycles, dur };
  arm();
  persist();
  syncRuntime();
  render();
}

function start() {
  const secs = readPicker();
  if (secs < 1) {
    q('#t-picker').classList.remove('shake');
    void q('#t-picker').offsetWidth;
    q('#t-picker').classList.add('shake');
    return;
  }
  cfg.dur = secs;
  saveCfg();
  begin(secs);
}

function pause() {
  if (st.status !== 'running') return;
  disarm();
  st = { ...st, status: 'paused', left: Math.max(0, st.endAt - Date.now()) };
  persist();
  syncRuntime();
  render();
}

function resume() {
  if (st.status !== 'paused') return;
  alarm.unlock();
  st = { ...st, status: 'running', endAt: Date.now() + st.left };
  arm();
  persist();
  syncRuntime();
  render();
}

/** Stop: cancel the timer, silence any alarm and go back to the time picker. */
function stop() {
  silence();
  st = { status: 'idle' };
  persist();
  syncRuntime();
  render();
}

/** "Stop alarm" button: silence the sound and freeze the Over-by counter. */
function stopAlarm() {
  if (st.status === 'finished' && st.silencedAt == null) {
    st = { ...st, silencedAt: Date.now() };
    persist();
  }
  silence();
  update();
}

/** Reset: clear the timer back to 00:00:00 on the setup screen. */
function reset() {
  stop();
  cfg.dur = 0;
  saveCfg();
  writePicker(0);
}

/** Restart: run the full time again from the top, immediately. */
function restart() {
  if (st.status !== 'idle') begin(st.dur);
}

function complete() {
  const now = Date.now();
  if (st.cycle < st.cycles) {            // intermediate cycle: chime already played, go again
    const d = st.dur * 1000;
    st = { ...st, cycle: st.cycle + 1, total: d, endAt: now - st.endAt > d ? now + d : st.endAt + d };
    arm();
    persist();
    render();
    return;
  }
  if (!armed || !alarm.running()) {      // audio clock wasn't running (e.g. never unlocked): try now
    disarm();
    armed = alarm.play(soundOpts(true));
    if (armed) armed.onended = () => { armed = null; setRinging(false); };
  }
  st = { ...st, status: 'finished' };
  persist();
  render();
  setRinging(!!armed);
  notifyDone();
}

/** Time's up: start a fresh countdown of `secs`. */
function addTime(secs) {
  begin(secs, { cycle: st.cycles, cycles: st.cycles, dur: st.dur });
}

/** Still counting (or paused): make the current countdown longer. */
function extend(secs) {
  const ms = secs * 1000;
  if (st.status === 'running') {
    st = { ...st, endAt: st.endAt + ms, total: st.total + ms };
    arm();
  } else if (st.status === 'paused') {
    st = { ...st, left: st.left + ms, total: st.total + ms };
  } else {
    return;
  }
  persist();
  update();
  toast(`+${shortDur(secs)} added`);
}

const addSecs = (secs) => (st.status === 'finished' ? addTime(secs) : extend(secs));

function tick() {
  if (st.status === 'running' && Date.now() >= st.endAt) complete();
  update();
}

/* ---------- rendering ---------- */

const CIRC = 2 * Math.PI * 90;
const show = (el, on) => { el.hidden = !on; };

function readPicker() {
  const n = (id) => parseInt(q(id).value, 10) || 0;
  return n('#t-h') * 3600 + n('#t-m') * 60 + n('#t-s');
}

function writePicker(secs) {
  const two = (n) => String(n).padStart(2, '0');
  q('#t-h').value = two(Math.floor(secs / 3600));
  q('#t-m').value = two(Math.floor((secs % 3600) / 60));
  q('#t-s').value = two(secs % 60);
}

function render() {
  const s = st.status;
  root.dataset.state = s;
  show(q('#t-picker'), s === 'idle');
  show(q('#t-dial'), s !== 'idle');
  show(q('#t-finish'), s === 'finished');
  show(q('#t-addbox'), s !== 'idle');
  show(q('#t-presets'), s === 'idle');

  // Restart / Reset / Stop are always available once a timer exists
  const row = `<div class="ctl-row">
      <button class="btn secondary" data-act="restart">${icons.restart}Restart</button>
      <button class="btn secondary" data-act="reset">${icons.reset}Reset</button>
      <button class="btn secondary" data-act="stop">${icons.stop}Stop</button>
    </div>`;
  const main = {
    idle: `<button class="btn primary big wide" data-act="start">${icons.play}Start</button>`,
    running: `<button class="btn primary big wide" data-act="pause">${icons.pause}Pause</button>${row}`,
    paused: `<button class="btn primary big wide" data-act="resume">${icons.play}Resume</button>${row}`,
    finished: row,
  }[s];
  q('#t-controls').innerHTML = main;
  renderFinish();
  update();
}

function renderFinish() {
  q('#t-stop').hidden = !ringing;
  q('#t-adds').innerHTML = cfg.adds
    .map((sec) => `<button class="chip" data-act="add" data-sec="${sec}">+ ${shortDur(sec)}</button>`)
    .join('');
}

function update() {
  const now = Date.now();
  const s = st.status;
  const timeEl = q('#t-time');
  let left = 0;
  if (s === 'running') left = Math.max(0, st.endAt - now);
  else if (s === 'paused') left = st.left;

  if (s !== 'idle') {
    timeEl.textContent = clock(left);
    const frac = s === 'finished' ? 1 : left / st.total;
    q('#t-prog').style.strokeDashoffset = CIRC * (1 - frac);
    // keeps counting until you stop the alarm, then freezes at how late you were
    const over = s === 'finished' ? `Over by +${clock((st.silencedAt ?? now) - st.endAt, 'floor')}` : '';
    const bits = [];
    if (s === 'finished') bits.push("Time's up!");
    if (cfg.label) bits.push(cfg.label);
    if (st.cycles > 1 && s !== 'finished') bits.push(`Cycle ${st.cycle} of ${st.cycles}`);
    if (s === 'running') bits.push(`Ends ${new Date(st.endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    if (s === 'paused') bits.push('Paused');
    q('#t-meta').textContent = bits.join(' · ');
    q('#t-over').textContent = over;
  } else {
    q('#t-meta').textContent = cfg.label;
    q('#t-over').textContent = ''; // don't leave "Over by" showing on the setup screen
  }
  document.title = s === 'running' ? `${clock(left)} · Timer` : s === 'finished' ? "⏰ Time's up" : 'Custom Tools';
}

/* ---------- settings UI ---------- */

function initSettings() {
  // plain controls bound with data-cfg="key"
  for (const el of $$('[data-cfg]', root)) {
    const key = el.dataset.cfg;
    if (el.type === 'radio') el.checked = String(cfg[key]) === el.value;
    else if (el.type === 'checkbox') el.checked = !!cfg[key];
    else el.value = cfg[key];
    el.addEventListener('change', () => {
      if (el.type === 'checkbox') cfg[key] = el.checked;
      else if (el.type === 'range') cfg[key] = Number(el.value) / 100;
      else if (el.type === 'number') cfg[key] = Math.min(99, Math.max(1, parseInt(el.value, 10) || 1));
      else cfg[key] = el.value;
      onCfgChanged(key, el);
    });
    if (el.type === 'range' || el.type === 'text') {
      el.addEventListener('input', () => {
        cfg[key] = el.type === 'range' ? Number(el.value) / 100 : el.value;
        if (key === 'volume') testing?.setVolume(cfg.volume);
        if (key === 'label') { saveCfg(); update(); }
      });
    }
  }
  q('[data-cfg="volume"]').value = Math.round(cfg.volume * 100);
  q('#t-vol-out').textContent = `${Math.round(cfg.volume * 100)}%`;

  // "beep for N" duration
  q('#t-for-wrap').append(durField(cfg.forSecs, (s) => { cfg.forSecs = s; saveCfg(); arm(); }, 'Beep duration'));

  // custom add-time chips editor
  renderAddsEditor();
  q('#t-custom-add .btn').before(durField(customAddSecs, (s) => { customAddSecs = s; }, 'Custom add'));

  // notifications permission prompt happens on toggle (needs a tap)
  q('[data-cfg="notify"]').addEventListener('change', async (e) => {
    if (!e.target.checked) return;
    if (!('Notification' in window)) { toast('Notifications are not supported here'); }
    else if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
      toast('Notification permission was denied');
    } else return;
    e.target.checked = false;
    cfg.notify = false;
    saveCfg();
  });
  syncModeUi();
}

function onCfgChanged(key) {
  saveCfg();
  if (key === 'sound' || key === 'mode' || key === 'cycles' || key === 'volume') arm();
  if (key === 'mode') syncModeUi();
  if (key === 'volume') q('#t-vol-out').textContent = `${Math.round(cfg.volume * 100)}%`;
  if (key === 'wake' || key === 'keepAlive') syncRuntime();
  if (key === 'vibrate' && !cfg.vibrate) navigator.vibrate?.(0);
  if (key === 'sound') {
    updateCustomUi();
    if (cfg.sound === 'custom' && !customName) q('#t-file').click(); // nothing picked yet: open the file chooser
  }
  render();
}

function syncModeUi() {
  q('#t-for-wrap').hidden = cfg.mode !== 'for';
}

function renderAddsEditor() {
  const list = q('#t-adds-edit');
  list.innerHTML = '';
  cfg.adds.forEach((secs, i) => {
    const row = document.createElement('div');
    row.className = 'addrow';
    row.append('+ ');
    row.append(durField(secs, (s) => { cfg.adds[i] = s; saveCfg(); renderFinish(); }, `Add option ${i + 1}`));
    const rm = document.createElement('button');
    rm.className = 'icon-btn';
    rm.setAttribute('aria-label', `Remove add option ${i + 1}`);
    rm.textContent = '×';
    rm.addEventListener('click', () => { cfg.adds.splice(i, 1); saveCfg(); renderAddsEditor(); renderFinish(); });
    row.append(rm);
    list.append(row);
  });
  q('#t-add-option').hidden = cfg.adds.length >= 5;
}

function renderPresets() {
  const list = q('#t-preset-list');
  list.classList.toggle('editing', editingPresets);
  list.innerHTML = presets
    .map((sec, i) => `<button class="chip" data-act="preset" data-i="${i}">${shortDur(sec)}${editingPresets ? '<i aria-label="remove"> ×</i>' : ''}</button>`)
    .join('');
  q('#t-preset-edit').textContent = editingPresets ? 'Done' : 'Edit';
}

function updateCustomUi() {
  q('#t-custom-box').hidden = cfg.sound !== 'custom'; // file picker only matters for the Custom sound
  q('#t-custom-name').textContent = customName || 'No file chosen';
  q('#t-custom-clear').hidden = !customName;
  q('#t-custom-note').hidden = cfg.sound !== 'custom' || !!customName;
}

async function pickCustom(file) {
  if (!file) return;
  if (file.size > MAX_SOUND_BYTES) { toast('That file is too big (max 8 MB)'); return; }
  try {
    const secs = await alarm.loadCustom(file);
    await putFile('timer.sound', file, file.name);
    customName = file.name;
    cfg.sound = 'custom';
    saveCfg();
    $$('[data-cfg="sound"]', root).forEach((r) => { r.checked = r.value === 'custom'; });
    updateCustomUi();
    arm();
    toast(secs > 120 ? 'Loaded (long file – a short clip works best)' : 'Custom sound ready');
  } catch {
    toast("Couldn't read that audio file");
  }
}

async function restoreCustom() {
  const rec = await getFile('timer.sound');
  if (!rec) return;
  try {
    await alarm.loadCustom(rec.blob);
    customName = rec.name;
  } catch { /* corrupt or unsupported: fall back silently */ }
  updateCustomUi();
  arm();
}

function toggleTest() {
  const btn = q('#t-test');
  if (testing) { testing.stop(); testing = null; btn.innerHTML = `${icons.play}Test sound`; return; }
  alarm.unlock();
  testing = alarm.play({ kind: cfg.sound, volume: cfg.volume });
  if (!testing) { toast('Audio is not supported on this device'); return; }
  btn.innerHTML = `${icons.stop}Stop test`;
  const h = testing;
  h.onended = () => { if (testing === h) { testing = null; btn.innerHTML = `${icons.play}Test sound`; } };
}

/* ---------- mount ---------- */

const radio = (key, value, text) =>
  `<label><input type="radio" name="${key}" value="${value}" data-cfg="${key}"><span>${text}</span></label>`;
const toggle = (key, title, hint) =>
  `<label class="setting"><span><b>${title}</b>${hint ? `<small>${hint}</small>` : ''}</span>
     <input type="checkbox" class="switch" data-cfg="${key}"></label>`;

export default {
  id: 'timer',
  title: 'Timer',
  icon: 'timer',
  mount(el) {
    root = el;
    root.classList.add('timer');
    root.innerHTML = `
      <section class="card stage">
        <div class="meta" id="t-meta"></div>

        <div class="picker" id="t-picker">
          <label><input id="t-h" inputmode="numeric" maxlength="2" aria-label="Hours"><span>hours</span></label><i>:</i>
          <label><input id="t-m" inputmode="numeric" maxlength="2" aria-label="Minutes"><span>min</span></label><i>:</i>
          <label><input id="t-s" inputmode="numeric" maxlength="2" aria-label="Seconds"><span>sec</span></label>
        </div>

        <div class="dial" id="t-dial" hidden>
          <svg viewBox="0 0 200 200" aria-hidden="true">
            <circle class="track" cx="100" cy="100" r="90"/>
            <circle class="prog" id="t-prog" cx="100" cy="100" r="90" stroke-dasharray="${CIRC}" stroke-dashoffset="0"/>
          </svg>
          <div class="dial-center">
            <div class="time" id="t-time">00:00</div>
          </div>
        </div>
        <div class="over" id="t-over"></div>

        <div class="finish" id="t-finish" hidden>
          <button class="btn danger big wide" id="t-stop" data-act="silence" hidden>${icons.bellOff}Stop alarm</button>
        </div>

        <div class="controls stack" id="t-controls"></div>

        <div class="addbox" id="t-addbox" hidden>
          <div class="group-label" id="t-add-label">Add time</div>
          <div class="chips" id="t-adds"></div>
          <div class="custom-add" id="t-custom-add">
            <span class="muted">Custom</span>
            <button class="btn secondary small" data-act="add-custom">${icons.plus}Add</button>
          </div>
        </div>
      </section>

      <section class="card" id="t-presets">
        <div class="card-head"><h2>Quick picks</h2>
          <span><button class="link" data-act="preset-save">+ Save current</button>
          <button class="link" id="t-preset-edit" data-act="preset-edit">Edit</button></span></div>
        <div class="chips" id="t-preset-list"></div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Alarm sound</h2></div>
        <div class="seg" role="radiogroup" aria-label="Alarm sound">
          ${radio('sound', 'soft', 'Soft beep')}${radio('sound', 'loud', 'Loud beep')}${radio('sound', 'custom', 'Custom')}
        </div>
        <div id="t-custom-box" hidden>
          <div class="file-row">
            <button class="btn secondary small" data-act="browse">Browse…</button>
            <span class="file-name" id="t-custom-name">No file chosen</span>
            <button class="icon-btn" id="t-custom-clear" data-act="clear-custom" aria-label="Remove custom sound" hidden>×</button>
            <input type="file" id="t-file" accept="audio/*" hidden>
          </div>
          <p class="hint" id="t-custom-note" hidden>Pick an audio file from your phone. Until then, the loud beep is used.</p>
        </div>
        <div class="vol-row">
          <span>Volume</span>
          <input type="range" min="5" max="100" step="5" data-cfg="volume" aria-label="Volume">
          <output id="t-vol-out"></output>
        </div>
        <button class="btn secondary small" id="t-test" data-act="test">${icons.play}Test sound</button>
        <p class="hint">Loudness also follows your phone's media volume.</p>
      </section>

      <section class="card">
        <div class="card-head"><h2>When time's up</h2></div>
        <div class="seg stack" role="radiogroup" aria-label="When time is up">
          ${radio('mode', 'once', 'Beep once, then stop')}
          ${radio('mode', 'for', 'Beep for a set time')}
          ${radio('mode', 'until', 'Keep beeping until I stop it')}
        </div>
        <div class="inline-field" id="t-for-wrap" hidden><span>Beep for</span></div>
        ${toggle('vibrate', 'Vibrate', 'Buzz along with the alarm')}
      </section>

      <section class="card">
        <div class="card-head"><h2>After it ends</h2></div>
        <p class="hint">These buttons appear when time's up, next to Restart (which reruns the same duration).</p>
        <div id="t-adds-edit"></div>
        <button class="btn secondary small" id="t-add-option" data-act="add-option">${icons.plus}Add option</button>
      </section>

      <section class="card">
        <div class="card-head"><h2>Extras</h2></div>
        <label class="setting"><span><b>Label</b><small>Shown while running and on the alert</small></span>
          <input type="text" class="text" data-cfg="label" maxlength="40" placeholder="e.g. Tea"></label>
        <label class="setting"><span><b>Repeat cycles</b><small>Chimes between cycles, rings the alarm on the last</small></span>
          <input type="number" class="text narrow" min="1" max="99" inputmode="numeric" data-cfg="cycles"></label>
        ${toggle('wake', 'Keep screen on', 'While the timer runs or rings')}
        ${toggle('keepAlive', 'Keep running with screen off', 'Plays silence so Android keeps the timer alive')}
        ${toggle('notify', 'Notify when done', 'Shows an alert if the app is in the background')}
      </section>`;

    // time picker behavior
    for (const id of ['#t-h', '#t-m', '#t-s']) {
      const input = q(id);
      input.addEventListener('focus', () => input.select());
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 2); });
      input.addEventListener('blur', () => writePicker(readPicker())); // normalize 90 sec -> 1:30
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); start(); } });
    }
    writePicker(cfg.dur);

    const actions = {
      start, pause, resume, reset, stop, restart,
      silence: stopAlarm,
      add: (b) => addSecs(Number(b.dataset.sec)),
      'add-custom': () => addSecs(customAddSecs),
      'add-option': () => { cfg.adds.push(60); saveCfg(); renderAddsEditor(); renderFinish(); },
      browse: () => q('#t-file').click(),
      'clear-custom': async () => {
        await delFile('timer.sound');
        alarm.clearCustom();
        customName = '';
        if (cfg.sound === 'custom') { cfg.sound = 'loud'; $$('[data-cfg="sound"]', root).forEach((r) => { r.checked = r.value === 'loud'; }); }
        saveCfg();
        updateCustomUi();
        arm();
      },
      test: toggleTest,
      preset: (b) => {
        const i = Number(b.dataset.i);
        if (editingPresets) { presets.splice(i, 1); save('timer.presets', presets); renderPresets(); }
        else { writePicker(presets[i]); }
      },
      'preset-edit': () => { editingPresets = !editingPresets; renderPresets(); },
      'preset-save': () => {
        const secs = readPicker();
        if (secs < 1) { toast('Set a time first'); return; }
        if (presets.includes(secs)) { toast('Already saved'); return; }
        presets.push(secs);
        presets.sort((a, b) => a - b);
        save('timer.presets', presets);
        renderPresets();
        toast(`Saved ${shortDur(secs)}`);
      },
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && actions[b.dataset.act]) actions[b.dataset.act](b);
    });
    q('#t-file').addEventListener('change', (e) => { pickCustom(e.target.files[0]); e.target.value = ''; });

    initSettings();
    renderPresets();
    updateCustomUi();

    // resume a countdown that was running when the page was closed/reloaded
    if (st.status === 'running' && Date.now() >= st.endAt) st = { ...st, status: 'finished' };
    if (st.status === 'finished' && st.silencedAt == null) st = { ...st, silencedAt: Date.now() }; // nothing rings after a reload
    if (st.status === 'running') { writePicker(cfg.dur); arm(); }
    render();
    syncRuntime();
    restoreCustom();

    setInterval(tick, 250);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      tick();
      syncRuntime(); // wake lock is released when the page is hidden
    });
    alarm.onUnlock(() => { if (st.status === 'running') arm(); syncRuntime(); });
  },
};
