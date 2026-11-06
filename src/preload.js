// Injected into every page a float window loads. Adds the hover drag bar, URL bar, media
// controls and the compact-mode flag. Runs in an isolated world.
const { ipcRenderer } = require('electron');

const BAR_ID = 'macpip-dragbar';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Small red play badge for the YouTube button. Built with DOM calls, not innerHTML, because
// YouTube enforces Trusted Types.
function youtubeGlyph() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 14');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '12');
  const badge = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: 20, height: 14, rx: 4, fill: '#ff0033' })) badge.setAttribute(k, v);
  const play = document.createElementNS(SVG_NS, 'path');
  play.setAttribute('d', 'M8 4 L13.5 7 L8 10 Z');
  play.setAttribute('fill', '#fff');
  svg.append(badge, play);
  return svg;
}

function makeButton(label, title, action) {
  const b = document.createElement('button');
  b.className = 'macpip-btn';
  if (typeof label === 'string') b.textContent = label;
  else b.append(label);
  b.title = title;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('bar-action', action);
  });
  return b;
}

function ensureBar() {
  if (!document.body || document.getElementById(BAR_ID)) return;
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  const buttons = document.createElement('div');
  buttons.className = 'macpip-buttons';
  buttons.append(
    makeButton('‹', 'Back', 'back'),
    makeButton('⌂', 'Home', 'home'),
    makeButton('⌕', 'Open URL (⌘L)', 'url'),
    makeButton(youtubeGlyph(), 'YouTube (⌘Y)', 'youtube'),
    makeButton('+', 'New Window (⌘N)', 'new'),
    makeButton('✕', 'Close', 'close'),
  );
  bar.append(buttons);
  document.body.append(bar);
}

const URLBAR_ID = 'macpip-urlbar';

function closeUrlBar() {
  document.getElementById(URLBAR_ID)?.remove();
}

// A small centered input for typing a URL or search. Enter opens it, Esc or blur cancels.
function showUrlBar(currentUrl) {
  if (!document.body) return;
  closeUrlBar();
  const wrap = document.createElement('div');
  wrap.id = URLBAR_ID;
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'Type a URL or search…  (⇧↩ opens in a new window)';
  input.value = currentUrl || '';
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger the site's own keyboard shortcuts
    if (e.key === 'Enter') {
      ipcRenderer.send('open-url', input.value, { newWindow: e.shiftKey || e.metaKey });
      closeUrlBar();
    } else if (e.key === 'Escape') {
      closeUrlBar();
    }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());
  input.addEventListener('blur', () => setTimeout(closeUrlBar, 100));
  wrap.append(input);
  document.body.append(wrap);
  input.focus();
  input.select();
}

ipcRenderer.on('url-bar', (_e, currentUrl) => showUrlBar(currentUrl));

// ---- Media controls (driven by global shortcuts in the main process) ----

const TOAST_ID = 'macpip-toast';
let toastTimer = null;

function toast(text) {
  if (!document.body) return;
  let el = document.getElementById(TOAST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = TOAST_ID;
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('macpip-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('macpip-show'), 900);
}

// The video that matters: one that's playing, otherwise the biggest one on the page.
function findVideo() {
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) return null;
  const playing = videos.find((v) => !v.paused && !v.ended && v.readyState > 2);
  if (playing) return playing;
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  return videos.sort((a, b) => area(b) - area(a))[0];
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return '';
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const mediaActions = {
  status: () => {}, // just report whether something is playing
  'play-pause': (v) => {
    if (v.paused) { v.play(); toast('▶'); } else { v.pause(); toast('❚❚'); }
  },
  pause: (v) => { if (!v.paused) v.pause(); },
  play: (v) => { if (v.paused) v.play(); },
  'seek-back': (v) => { v.currentTime = Math.max(0, v.currentTime - 10); toast(`« 10s  ${fmtTime(v.currentTime)}`); },
  'seek-forward': (v) => { v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10); toast(`10s »  ${fmtTime(v.currentTime)}`); },
  mute: (v) => { v.muted = !v.muted; toast(v.muted ? 'Muted' : 'Sound on'); },
  'speed-up': (v) => {
    v.playbackRate = SPEEDS.find((s) => s > v.playbackRate + 0.01) ?? SPEEDS[SPEEDS.length - 1];
    toast(`${v.playbackRate}×`);
  },
  'speed-down': (v) => {
    v.playbackRate = [...SPEEDS].reverse().find((s) => s < v.playbackRate - 0.01) ?? SPEEDS[0];
    toast(`${v.playbackRate}×`);
  },
  'speed-reset': (v) => { v.playbackRate = 1; toast('1×'); },
};

// Replies with whether a video was playing before the action (so "pause when hidden" can resume
// later) and whether the page has a video at all (so shortcuts can pick the right window).
ipcRenderer.on('media', (_e, action, replyId) => {
  const v = findVideo();
  const wasPlaying = !!v && !v.paused && !v.ended;
  if (v && mediaActions[action]) mediaActions[action](v);
  else if (!v && !['pause', 'play', 'status'].includes(action)) toast('No video on this page');
  if (replyId) ipcRenderer.send('media-reply', replyId, wasPlaying, !!v);
});

// Main process polls the cursor and tells us when it's over the top strip.
ipcRenderer.on('bar-visible', (_e, visible) => {
  ensureBar();
  document.documentElement.toggleAttribute('data-macpip-bar', visible);
});

ipcRenderer.on('compact', (_e, on) => {
  document.documentElement.toggleAttribute('data-macpip-compact', on);
  // Let YouTube's player re-measure itself.
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  setTimeout(() => window.dispatchEvent(new Event('resize')), 400);
});

window.addEventListener('DOMContentLoaded', () => {
  ensureBar();
  // YouTube is a SPA and occasionally rebuilds parts of the page; keep the bar present.
  setInterval(ensureBar, 2000);
});
