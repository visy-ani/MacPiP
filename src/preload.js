// Injected into every page the main window loads (YouTube and Google sign-in).
// Adds the hover drag bar and the compact-mode flag. Runs in an isolated world.
const { ipcRenderer } = require('electron');

const BAR_ID = 'macpip-dragbar';

function makeButton(label, title, action) {
  const b = document.createElement('button');
  b.className = 'macpip-btn';
  b.textContent = label;
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
  input.placeholder = 'Type a URL or search…';
  input.value = currentUrl || '';
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger the site's own keyboard shortcuts
    if (e.key === 'Enter') {
      ipcRenderer.send('open-url', input.value);
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
