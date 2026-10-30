import { $, icons } from './util.js';
import { alarm } from './audio.js';
import timer from './tools/timer.js';
import stopwatch from './tools/stopwatch.js';

// To add a tool: create js/tools/<name>.js exporting { id, title, icon, mount(root) } and list it here.
// The first entry is the first tab.
const tools = [timer, stopwatch];

$('#boot-msg')?.remove();
const tabbar = $('#tabbar');
const panels = $('#panels');
const titleEl = $('#tool-title');

for (const tool of tools) {
  const tab = document.createElement('button');
  tab.className = 'tab';
  tab.role = 'tab';
  tab.id = `tab-${tool.id}`;
  tab.setAttribute('aria-controls', `panel-${tool.id}`);
  tab.innerHTML = `${icons[tool.icon] ?? ''}<span>${tool.title}</span>`;
  tab.addEventListener('click', () => select(tool.id));
  tabbar.append(tab);

  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.role = 'tabpanel';
  panel.id = `panel-${tool.id}`;
  panel.setAttribute('aria-labelledby', tab.id);
  panel.hidden = true;
  panels.append(panel);
  tool.mount(panel); // every tool stays mounted so a running timer survives tab switches
}

function select(id) {
  for (const tool of tools) {
    const on = tool.id === id;
    $(`#tab-${tool.id}`).setAttribute('aria-selected', on);
    $(`#panel-${tool.id}`).hidden = !on;
    if (on) {
      titleEl.textContent = tool.title;
      tool.show?.();
    } else {
      tool.hide?.();
    }
  }
  history.replaceState(null, '', `#${id}`);
  window.scrollTo(0, 0);
}

const fromHash = location.hash.slice(1);
select(tools.some((t) => t.id === fromHash) ? fromHash : tools[0].id);

// Browsers keep sound muted until the first tap.
addEventListener('pointerdown', () => { if (!alarm.running()) alarm.unlock(); }, { passive: true });

// "Install app" button (Chrome/Android fires this when the app is installable)
let installEvent = null;
const installBtn = $('#install-btn');
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  installBtn.hidden = true;
});
addEventListener('appinstalled', () => { installBtn.hidden = true; });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
