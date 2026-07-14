import './shell.css';

interface ShowcaseEntry {
  readonly accent: string;
  readonly blurb: string;
  readonly eyebrow: string;
  readonly id: string;
  readonly title: string;
}

const SHOWCASES: readonly ShowcaseEntry[] = [
  {
    accent: '#5fe6ff',
    blurb: 'Twin crescent slashes with blade trails, sparks, and a layered shockwave.',
    eyebrow: 'Stylized action',
    id: 'slash',
    title: 'Resonance Slash',
  },
  {
    accent: '#c86bff',
    blurb: 'A white-hot beam with a scrolling plasma sheath, blowback, and screen distortion.',
    eyebrow: 'Ultimate beam',
    id: 'beam',
    title: 'Plasma Lance',
  },
  {
    accent: '#5fffa8',
    blurb: 'A pillar of dawn light, ground ring wave, and a curl-noise fountain of healing motes.',
    eyebrow: 'Ultimate healing',
    id: 'heal',
    title: 'Sanctuary Bloom',
  },
  {
    accent: '#4fc8ff',
    blurb: 'A snap-deployed hexagonal energy dome with shock ring and shield-cell glints.',
    eyebrow: 'Ultimate defense',
    id: 'barrier',
    title: 'Aegis Barrier',
  },
  {
    accent: '#9fe8ff',
    blurb: 'An erupting forest of ice spikes, a great center pillar, then a glittering crumble.',
    eyebrow: 'Ultimate freeze',
    id: 'ice',
    title: 'Glacial Requiem',
  },
  {
    accent: '#ffc94a',
    blurb: 'A circuit circle boots up and an orbital laser barrage rains down in amber afterglow.',
    eyebrow: 'Tech machina',
    id: 'machina',
    title: 'Machina Judgment',
  },
];

const PANEL_MESSAGE = 'nachi-showcase:set-panel';

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing shell element: ${selector}`);
  return value;
}

const nav = required<HTMLElement>('#showcase-nav');
const frame = required<HTMLIFrameElement>('#viewer-frame');
const stageFrame = required<HTMLElement>('#stage-frame');
const viewerEyebrow = required<HTMLElement>('#viewer-eyebrow');
const viewerTitle = required<HTMLElement>('#viewer-title');
const viewerNote = required<HTMLElement>('#viewer-note');
const panelToggle = required<HTMLButtonElement>('#panel-toggle');
const fullscreenToggle = required<HTMLButtonElement>('#fullscreen-toggle');
const standaloneLink = required<HTMLAnchorElement>('#standalone-link');

let active: ShowcaseEntry = SHOWCASES[0]!;
let panelVisible = false;

const buttons = new Map<string, HTMLButtonElement>();
for (const entry of SHOWCASES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-item';
  button.style.setProperty('--accent', entry.accent);
  button.innerHTML = `
    <span class="nav-eyebrow">${entry.eyebrow}</span>
    <span class="nav-title">${entry.title}</span>
    <span class="nav-blurb">${entry.blurb}</span>
  `;
  button.addEventListener('click', () => select(entry, true));
  buttons.set(entry.id, button);
  nav.appendChild(button);
}

function setPanelVisible(visible: boolean): void {
  panelVisible = visible;
  panelToggle.setAttribute('aria-pressed', String(visible));
  frame.contentWindow?.postMessage({ type: PANEL_MESSAGE, visible }, location.origin);
}

function select(entry: ShowcaseEntry, pushHash: boolean): void {
  active = entry;
  for (const [id, button] of buttons) button.classList.toggle('active', id === entry.id);
  viewerEyebrow.textContent = `Showcase · ${entry.eyebrow}`;
  viewerTitle.textContent = entry.title;
  viewerNote.textContent = entry.blurb;
  document.title = `${entry.title} · Nachi VFX Showcase`;
  stageFrame.style.setProperty('--accent', entry.accent);
  standaloneLink.href = `${import.meta.env.BASE_URL}${entry.id}/`;
  frame.src = `${import.meta.env.BASE_URL}${entry.id}/?embed=1`;
  // The tuning pane starts hidden in embed mode; keep the toggle in sync.
  panelVisible = false;
  panelToggle.setAttribute('aria-pressed', 'false');
  if (pushHash) history.replaceState(null, '', `#${entry.id}`);
}

panelToggle.addEventListener('click', () => setPanelVisible(!panelVisible));

fullscreenToggle.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stageFrame.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  fullscreenToggle.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});

window.addEventListener('hashchange', () => {
  const entry = SHOWCASES.find((candidate) => candidate.id === location.hash.slice(1));
  if (entry && entry.id !== active.id) select(entry, false);
});

const initial =
  SHOWCASES.find((candidate) => candidate.id === location.hash.slice(1)) ?? SHOWCASES[0]!;
select(initial, false);
