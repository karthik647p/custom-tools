import { $, clock, icons } from '../util.js';
import { load, save } from '../storage.js';

// state survives reloads: { running, startedAt, base, laps: [totalMs, ...] }
let st = load('stopwatch', { running: false, startedAt: 0, base: 0, laps: [] });
let root, raf = 0;

const elapsed = () => st.base + (st.running ? Date.now() - st.startedAt : 0);
const persist = () => save('stopwatch', st);

function fmt(ms) {
  const cs = Math.floor((ms % 1000) / 10);
  return `${clock(ms, 'floor')}.${String(cs).padStart(2, '0')}`;
}

function frame() {
  $('#sw-time', root).textContent = fmt(elapsed());
  if (st.laps.length) $('#sw-cur', root).textContent = fmt(elapsed() - st.laps[st.laps.length - 1]);
  raf = st.running && !document.hidden ? requestAnimationFrame(frame) : 0;
}

function renderControls() {
  const idle = !st.running && st.base === 0;
  $('#sw-controls', root).innerHTML = `
    <button class="btn secondary big" data-act="${st.running ? 'lap' : 'reset'}" ${idle ? 'disabled' : ''}>
      ${st.running ? icons.flag + 'Lap' : icons.reset + 'Reset'}
    </button>
    <button class="btn ${st.running ? 'danger' : 'primary'} big" data-act="toggle">
      ${st.running ? icons.pause + 'Stop' : icons.play + (st.base ? 'Resume' : 'Start')}
    </button>`;
}

function renderLaps() {
  const laps = st.laps;
  const splits = laps.map((t, i) => t - (laps[i - 1] ?? 0));
  const best = Math.min(...splits), worst = Math.max(...splits);
  $('#sw-laps', root).innerHTML = [...laps].reverse().map((t, r) => {
    const i = laps.length - 1 - r;
    const cls = laps.length > 2 ? (splits[i] === best ? 'best' : splits[i] === worst ? 'worst' : '') : '';
    return `<li class="${cls}"><span>Lap ${i + 1}</span><b>${fmt(splits[i])}</b><span>${fmt(t)}</span></li>`;
  }).join('');
  $('#sw-current', root).hidden = !laps.length;
}

function render() {
  renderControls();
  renderLaps();
  frame();
}

export default {
  id: 'stopwatch',
  title: 'Stopwatch',
  icon: 'stopwatch',
  mount(el) {
    root = el;
    root.innerHTML = `
      <div class="card stage">
        <div class="time big-time" id="sw-time">00:00.00</div>
        <div class="sub" id="sw-current" hidden>Current lap <b id="sw-cur">00:00.00</b></div>
        <div class="controls" id="sw-controls"></div>
      </div>
      <ul class="laps card" id="sw-laps" aria-label="Laps"></ul>`;
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'toggle') {
        if (st.running) st = { ...st, running: false, base: elapsed() };
        else st = { ...st, running: true, startedAt: Date.now() };
      } else if (act === 'lap') {
        st.laps = [...st.laps, elapsed()];
      } else if (act === 'reset') {
        st = { running: false, startedAt: 0, base: 0, laps: [] };
      }
      persist();
      render();
    });
    document.addEventListener('visibilitychange', () => { if (!raf) frame(); });
    render();
  },
  show() { if (!raf) frame(); },
};
