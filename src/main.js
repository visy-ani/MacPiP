const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  screen,
  session,
  shell,
  ipcMain,
  clipboard,
} = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PRESET_SITES = [
  { label: 'YouTube', url: 'https://www.youtube.com' },
  { label: 'YouTube Music', url: 'https://music.youtube.com' },
  { label: 'Twitch', url: 'https://www.twitch.tv' },
  { label: 'Vimeo', url: 'https://vimeo.com' },
];
const MAX_RECENT = 8;
const SIGNIN_URL =
  'https://accounts.google.com/ServiceLogin?service=youtube&continue=' +
  encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&next=%2F');
const PARTITION = 'persist:macpip';
const MIN_W = 320;
const MIN_H = 180;
// Extra windows default to a taller shape that suits articles and docs.
const READER_SIZE = { width: 460, height: 680 };
const NEW_WINDOW_PAGE = path.join(__dirname, 'newtab.html');
const BAR_HEIGHT = 24;
const EDGE_MARGIN = 16; // gap kept between the window and the screen edge when snapped
const SNAP_DISTANCE = 40; // drop the window this close to an edge and it snaps
const SIZE_PRESETS = [
  { label: 'Small', width: 320 },
  { label: 'Medium', width: 480 },
  { label: 'Large', width: 640 },
  { label: 'Extra Large', width: 854 },
];
const CORNERS = [
  { id: 'top-left', label: 'Top Left', key: '1' },
  { id: 'top-right', label: 'Top Right', key: '2' },
  { id: 'bottom-left', label: 'Bottom Left', key: '3' },
  { id: 'bottom-right', label: 'Bottom Right', key: '4' },
];

// Present as regular desktop Chrome (no "Electron"/app tokens) so Google sign-in isn't blocked.
const CHROME_UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;

// Google blocks sign-in when a "Chrome" UA lacks real Chrome's client hints, which Electron
// can't provide. Firefox sends no client hints, so the sign-in window presents as Firefox.
// Firefox ships every 4 weeks; derive a current-looking version from 128 (2024-07-09).
const FIREFOX_VERSION = 128 + Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 864e5));
const FIREFOX_UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${FIREFOX_VERSION}.0) ` +
  `Gecko/20100101 Firefox/${FIREFOX_VERSION}.0`;

const injectCss = fs.readFileSync(path.join(__dirname, 'inject.css'), 'utf8');

// Every float window gets a state object. The "main" one is the original window: it remembers
// its bounds, and closing it only hides it. Extra windows (⌘N) are for articles, docs, a second
// video, etc.; closing one really closes it.
const floats = new Set();
let mainFloat = null;
let activeFloat = null; // last focused float; window-level shortcuts act on it

let tray = null;
let signinWin = null;
let quitting = false;
// Click-through ("ghost") mode applies to all windows. Not persisted, so a relaunch never
// leaves you with a window you can't click.
let clickThrough = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function active() {
  if (activeFloat && !activeFloat.win.isDestroyed()) return activeFloat;
  return mainFloat;
}

function floatFor(webContents) {
  for (const f of floats) if (!f.win.isDestroyed() && f.win.webContents === webContents) return f;
  return null;
}

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 480;
  const height = 270;
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
  };
}

// Put a new window beside the active one (left if there's room, else right), bottom-aligned.
function newWindowBounds() {
  const ref = active().win.getBounds();
  const a = workAreaFor(ref);
  const width = Math.min(READER_SIZE.width, a.width - 2 * EDGE_MARGIN);
  const height = Math.min(READER_SIZE.height, a.height - 2 * EDGE_MARGIN);
  let x;
  if (ref.x - width - EDGE_MARGIN >= a.x + EDGE_MARGIN) x = ref.x - width - EDGE_MARGIN;
  else if (ref.x + ref.width + EDGE_MARGIN + width <= a.x + a.width - EDGE_MARGIN) x = ref.x + ref.width + EDGE_MARGIN;
  else x = Math.min(ref.x + 32, a.x + a.width - width - EDGE_MARGIN);
  const y = Math.max(a.y + EDGE_MARGIN, Math.min(ref.y + ref.height - height, a.y + a.height - height - EDGE_MARGIN));
  return { x, y, width, height };
}

function boundsAreVisible(b) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 &&
    b.y < a.y + a.height - 40 && b.y + b.height > a.y);
}

function applyAlwaysOnTop(f) {
  // 'screen-saver' level floats above full-screen apps.
  f.win.setAlwaysOnTop(store.get('alwaysOnTop'), 'screen-saver');
  f.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

function applyAspect(f) {
  f.win.setAspectRatio(f.lockAspect ? 16 / 9 : 0);
}

function applyOpacity(f) {
  const base = store.get('opacity');
  f.win.setOpacity(clickThrough ? Math.min(base, store.get('ghostOpacity')) : base);
}

function applyClickThrough(f) {
  f.win.setIgnoreMouseEvents(clickThrough);
  applyOpacity(f);
}

function applyDock(show) {
  if (!app.dock) return;
  if (show) app.dock.show();
  else app.dock.hide();
}

function createFloat({ isMain = false, url = null, bounds = null, showUrlBarOnLoad = false } = {}) {
  let b = bounds;
  if (!b && isMain) {
    const saved = store.get('bounds');
    b = saved && boundsAreVisible(saved) ? saved : defaultBounds();
  }
  if (!b) b = newWindowBounds();

  const win = new BrowserWindow({
    ...b,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    resizable: true,
    hasShadow: true,
    roundedCorners: true,
    fullscreenable: false,
    backgroundColor: '#0f0f0f',
    show: false,
    title: 'MacPiP',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const f = {
    win,
    isMain,
    lockAspect: isMain ? store.get('lockAspect') : false,
    barVisible: false,
    barHideTimer: null,
    resumeOnShow: false, // hiding paused a playing video; resume it on show
    restoreOnShow: false, // was visible when ⌥⌘Y hid everything
    ignoreMovedUntil: 0, // animated moves fire 'moved' every frame; don't edge-snap during them
  };
  floats.add(f);
  if (isMain) mainFloat = f;

  applyAlwaysOnTop(f);
  applyAspect(f);
  applyClickThrough(f);

  const wc = win.webContents;
  wc.setUserAgent(CHROME_UA);

  wc.on('dom-ready', () => {
    wc.insertCSS(injectCss);
    wc.send('compact', store.get('compact'));
    wc.send('bar-visible', f.barVisible);
    if (showUrlBarOnLoad) {
      showUrlBarOnLoad = false;
      showUrlBar(f);
    }
  });

  // Send Google sign-in to the separate Firefox-UA window instead of the embedded page.
  const interceptSignin = (e, u) => {
    if (isSigninUrl(u)) {
      e.preventDefault();
      openSigninWindow(u);
    }
  };
  wc.on('will-navigate', (e) => interceptSignin(e, e.url));
  wc.on('will-redirect', (e) => interceptSignin(e, e.url));

  // ⌘-click / shift-click open a new float window. Plain popups stay here when they're the same
  // site (or YouTube/Google), and go to the default browser otherwise.
  wc.setWindowOpenHandler(({ url: u, disposition }) => {
    if (isSigninUrl(u)) {
      openSigninWindow(u);
    } else if (disposition === 'background-tab' || disposition === 'new-window') {
      newWindow(u);
    } else if (isInternalUrl(u, f)) {
      wc.loadURL(u);
    } else {
      shell.openExternal(u);
    }
    return { action: 'deny' };
  });

  wc.on('context-menu', (_e, params) => showContextMenu(f, params));

  const saveBounds = () => {
    if (f.isMain && !win.isDestroyed()) store.set('bounds', win.getBounds());
  };
  win.on('moved', () => {
    snapToEdges(f);
    saveBounds();
  });
  win.on('resized', saveBounds);
  win.on('focus', () => {
    activeFloat = f;
    updateMenus();
  });

  win.on('close', (e) => {
    saveBounds();
    if (f.isMain && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    floats.delete(f);
    if (activeFloat === f) activeFloat = null;
    if (lastMediaFloat === f) lastMediaFloat = null;
    clearTimeout(f.barHideTimer);
    updateMenus();
  });
  win.on('show', () => {
    updateTrayMenu();
    if (f.resumeOnShow) {
      f.resumeOnShow = false;
      sendMedia('play', f);
    }
  });
  win.on('hide', async () => {
    updateTrayMenu();
    if (store.get('pauseWhenHidden') && !quitting) {
      const wasPlaying = await sendMedia('pause', f);
      // The window may have come back while we waited for the page.
      if (win.isDestroyed()) return;
      if (wasPlaying && !win.isVisible()) f.resumeOnShow = true;
      else if (wasPlaying) sendMedia('play', f);
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    if (!isMain) win.focus();
  });
  if (url) win.loadURL(url);
  else win.loadFile(NEW_WINDOW_PAGE);
  return f;
}

// Open a new float window. With a URL it loads that; without one it shows the URL bar.
function newWindow(input) {
  const url = input ? normalizeUrl(input) : null;
  if (url) addRecent(url);
  const f = createFloat({ url, showUrlBarOnLoad: !url });
  activeFloat = f;
  updateMenus();
  return f;
}

function newWindowFromClipboard() {
  const text = clipboard.readText().trim();
  newWindow(/^https?:\/\/\S+$/i.test(text) ? text : null);
}

function closeFloat(f = active()) {
  if (f.isMain) f.win.hide();
  else f.win.close();
}

function closeExtraWindows() {
  for (const f of [...floats]) if (!f.isMain) f.win.close();
}

function showContextMenu(f, params) {
  const wc = f.win.webContents;
  const items = [];
  if (params.linkURL) {
    items.push(
      { label: 'Open Link in New Window', click: () => newWindow(params.linkURL) },
      { label: 'Open Link Here', click: () => wc.loadURL(params.linkURL) },
      { label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
      { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }
  if (params.isEditable) {
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
  } else if (params.selectionText) {
    const text = params.selectionText.trim();
    const short = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    items.push(
      { role: 'copy' },
      { label: `Search Google for “${short}”`, click: () => newWindow(text) },
      { type: 'separator' },
    );
  }
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'Open URL…', click: () => showUrlBar(f) },
    { label: 'Open Page in Browser', enabled: /^https?:/.test(wc.getURL()), click: () => shell.openExternal(wc.getURL()) },
    { label: 'Copy Page URL', enabled: /^https?:/.test(wc.getURL()), click: () => clipboard.writeText(wc.getURL()) },
    { type: 'separator' },
    { label: 'New Window', click: () => newWindow() },
    { label: f.isMain ? 'Hide Window' : 'Close Window', click: () => closeFloat(f) },
  );
  Menu.buildFromTemplate(items).popup({ window: f.win });
}

// "www.youtube.com" -> "youtube.com". Good enough to tell "same site" for popups.
function baseDomain(hostname) {
  return hostname.split('.').slice(-2).join('.');
}

// Popups stay in the window when they're YouTube/Google or the same site as the current page.
function isInternalUrl(url, f = active()) {
  try {
    const { hostname } = new URL(url);
    if (/(^|\.)(youtube\.com|youtu\.be|google\.com|googleusercontent\.com)$/.test(hostname)) return true;
    const current = f && !f.win.isDestroyed() ? f.win.webContents.getURL() : '';
    if (!/^https?:/.test(current)) return false;
    return baseDomain(new URL(current).hostname) === baseDomain(hostname);
  } catch {
    return false;
  }
}

// Turn whatever the user typed into a URL: add https:// to bare domains, search everything else.
function normalizeUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) return `http://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function addRecent(url) {
  const recent = store.get('recentUrls').filter((u) => u !== url);
  recent.unshift(url);
  store.set('recentUrls', recent.slice(0, MAX_RECENT));
}

function openUrl(input, f = active()) {
  const url = normalizeUrl(input);
  if (!url) return;
  addRecent(url);
  f.win.webContents.loadURL(url);
  if (!f.win.isVisible()) f.win.show();
  updateMenus();
}

function showUrlBar(f = active()) {
  if (!f.win.isVisible()) f.win.show();
  f.win.focus();
  const current = f.win.webContents.getURL();
  f.win.webContents.send('url-bar', /^https?:/.test(current) ? current : '');
}

function openClipboardUrl() {
  const text = clipboard.readText().trim();
  if (/^https?:\/\/\S+$/i.test(text)) openUrl(text);
}

function setCurrentAsHome() {
  const url = active().win.webContents.getURL();
  if (/^https?:/i.test(url)) {
    store.set('homeUrl', url);
    updateMenus();
  }
}

function goHome(f = active()) {
  f.win.webContents.loadURL(store.get('homeUrl'));
}

function isSigninUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'accounts.google.com' &&
      /^\/(ServiceLogin|signin|v3\/signin|AccountChooser|AddSession)/i.test(u.pathname);
  } catch {
    return false;
  }
}

// Frameless windows can't hover-detect reliably over drag regions, so poll the cursor.
function startHoverWatcher() {
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    for (const f of floats) {
      if (f.win.isDestroyed() || !f.win.isVisible()) continue;
      if (clickThrough) {
        setBarVisible(f, false);
        continue;
      }
      const b = f.win.getBounds();
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      const inTopStrip = inside && p.y < b.y + BAR_HEIGHT + 4;
      if (inTopStrip) {
        clearTimeout(f.barHideTimer);
        f.barHideTimer = null;
        setBarVisible(f, true);
      } else if (f.barVisible && !f.barHideTimer) {
        f.barHideTimer = setTimeout(() => {
          f.barHideTimer = null;
          setBarVisible(f, false);
        }, 500);
      }
    }
  }, 100);
}

function setBarVisible(f, v) {
  if (v === f.barVisible || f.win.isDestroyed()) return;
  f.barVisible = v;
  f.win.webContents.send('bar-visible', v);
}

ipcMain.on('bar-action', (e, action) => {
  const f = floatFor(e.sender);
  if (!f) return;
  const wc = f.win.webContents;
  if (action === 'back') {
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  } else if (action === 'home') {
    goHome(f);
  } else if (action === 'url') {
    showUrlBar(f);
  } else if (action === 'new') {
    newWindow();
  } else if (action === 'close') {
    closeFloat(f);
  }
});

ipcMain.on('open-url', (e, input, opts = {}) => {
  if (opts.newWindow) newWindow(input);
  else openUrl(input, floatFor(e.sender) || active());
});

const MEDIA_SHORTCUTS = [
  { label: 'Play / Pause', action: 'play-pause', accel: 'Control+Alt+Command+Space' },
  { label: 'Back 10 Seconds', action: 'seek-back', accel: 'Control+Alt+Command+Left' },
  { label: 'Forward 10 Seconds', action: 'seek-forward', accel: 'Control+Alt+Command+Right' },
  { label: 'Mute / Unmute', action: 'mute', accel: 'Control+Alt+Command+M' },
  { label: 'Faster', action: 'speed-up', accel: 'Control+Alt+Command+]' },
  { label: 'Slower', action: 'speed-down', accel: 'Control+Alt+Command+[' },
  { label: 'Normal Speed', action: 'speed-reset', accel: 'Control+Alt+Command+0' },
];

let mediaReplyId = 0;
const mediaReplies = new Map();

let lastMediaFloat = null; // window the last media shortcut went to

// Ask a window's page to run a media action. Resolves to { playing, hasVideo }, where `playing`
// is whether a video was playing before the action.
function mediaRequest(action, f) {
  const none = { playing: false, hasVideo: false };
  if (!f || f.win.isDestroyed()) return Promise.resolve(none);
  const id = ++mediaReplyId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { mediaReplies.delete(id); resolve(none); }, 1000);
    mediaReplies.set(id, (state) => { clearTimeout(timer); resolve(state); });
    f.win.webContents.send('media', action, id);
  });
}

// Same, resolving to whether a video was playing beforehand.
async function sendMedia(action, f) {
  return (await mediaRequest(action, f)).playing;
}

ipcMain.on('media-reply', (_e, id, playing, hasVideo) => {
  const done = mediaReplies.get(id);
  mediaReplies.delete(id);
  if (done) done({ playing: !!playing, hasVideo: !!hasVideo });
});

// Where media shortcuts go: a window that's playing; else one that has a video (preferring the
// one last controlled); else the active window. The active window wins ties.
async function mediaTarget() {
  const visible = [...floats].filter((f) => !f.win.isDestroyed() && f.win.isVisible());
  const states = await Promise.all(visible.map((f) => mediaRequest('status', f)));
  const pick = (list) => [active(), lastMediaFloat].find((f) => list.includes(f)) || list[0];
  return pick(visible.filter((_f, i) => states[i].playing)) ||
    pick(visible.filter((_f, i) => states[i].hasVideo)) ||
    active();
}

async function mediaAction(action) {
  const f = await mediaTarget();
  lastMediaFloat = f;
  sendMedia(action, f);
}

function togglePauseWhenHidden() {
  store.set('pauseWhenHidden', !store.get('pauseWhenHidden'));
  if (!store.get('pauseWhenHidden')) for (const f of floats) f.resumeOnShow = false;
  updateMenus();
}

function mediaMenu() {
  return [
    ...MEDIA_SHORTCUTS.map((m) => ({
      label: m.label,
      accelerator: m.accel,
      registerAccelerator: false,
      click: () => mediaAction(m.action),
    })),
    { type: 'separator' },
    { label: 'Pause When Hidden', type: 'checkbox', checked: store.get('pauseWhenHidden'), click: togglePauseWhenHidden },
  ];
}

function anyVisible() {
  return [...floats].some((f) => !f.win.isDestroyed() && f.win.isVisible());
}

// ⌥⌘Y hides every window, and brings back the ones that were showing.
function toggleWindow() {
  if (anyVisible()) {
    for (const f of floats) {
      f.restoreOnShow = f.win.isVisible();
      if (f.restoreOnShow) f.win.hide();
    }
  } else {
    const toShow = [...floats].filter((f) => f.restoreOnShow);
    for (const f of toShow.length ? toShow : [mainFloat]) f.win.show();
    active().win.focus();
  }
}

function toggleAlwaysOnTop() {
  store.set('alwaysOnTop', !store.get('alwaysOnTop'));
  for (const f of floats) applyAlwaysOnTop(f);
  updateMenus();
}

function changeOpacity(delta) {
  const next = Math.round(Math.min(1, Math.max(0.4, store.get('opacity') + delta)) * 100) / 100;
  store.set('opacity', next);
  for (const f of floats) applyOpacity(f);
}

function toggleClickThrough() {
  clickThrough = !clickThrough;
  for (const f of floats) {
    applyClickThrough(f);
    // A focused window would still swallow key presses meant for the app underneath.
    if (clickThrough) f.win.blur();
  }
  if (clickThrough && !anyVisible()) mainFloat.win.showInactive();
  if (tray) tray.setToolTip(clickThrough ? 'MacPiP (click-through: ⌃⌥⌘X to exit)' : 'MacPiP');
  updateMenus();
}

function toggleCompact() {
  const on = !store.get('compact');
  store.set('compact', on);
  for (const f of floats) f.win.webContents.send('compact', on);
  updateMenus();
}

// The 16:9 lock is per window; only the main window's choice is remembered.
function toggleAspect() {
  const f = active();
  f.lockAspect = !f.lockAspect;
  if (f.isMain) store.set('lockAspect', f.lockAspect);
  applyAspect(f);
  if (f.lockAspect) {
    const b = f.win.getBounds();
    f.win.setBounds({ ...b, height: Math.max(MIN_H, Math.round(b.width * 9 / 16)) });
  }
  updateMenus();
}

function toggleDock() {
  const show = !store.get('showInDock');
  store.set('showInDock', show);
  applyDock(show);
  updateMenus();
  // Hiding the dock icon can drop focus; bring the window back.
  if (active().win.isVisible()) active().win.show();
}

function workAreaFor(b) {
  return screen.getDisplayMatching(b).workArea;
}

// Which screen corner the window is closest to, e.g. "bottom-right".
function nearestCorner(b) {
  const a = workAreaFor(b);
  const v = b.y + b.height / 2 < a.y + a.height / 2 ? 'top' : 'bottom';
  const h = b.x + b.width / 2 < a.x + a.width / 2 ? 'left' : 'right';
  return `${v}-${h}`;
}

function boundsAtCorner(corner, width, height, a) {
  const [v, h] = corner.split('-');
  return {
    width,
    height,
    x: h === 'left' ? a.x + EDGE_MARGIN : a.x + a.width - width - EDGE_MARGIN,
    y: v === 'top' ? a.y + EDGE_MARGIN : a.y + a.height - height - EDGE_MARGIN,
  };
}

function animateBounds(f, bounds) {
  f.ignoreMovedUntil = Date.now() + 600;
  f.win.setBounds(bounds, true);
}

function moveToCorner(corner, f = active()) {
  const b = f.win.getBounds();
  animateBounds(f, boundsAtCorner(corner, b.width, b.height, workAreaFor(b)));
  if (!f.win.isVisible()) f.win.showInactive();
}

// Resize to a given width, keeping the window pinned to its nearest corner.
function resizeToWidth(width, f = active()) {
  const b = f.win.getBounds();
  const a = workAreaFor(b);
  const w = Math.round(Math.min(a.width - 2 * EDGE_MARGIN, Math.max(MIN_W, width)));
  let h = f.lockAspect ? Math.round(w * 9 / 16) : Math.round(b.height * w / b.width);
  h = Math.min(a.height - 2 * EDGE_MARGIN, Math.max(MIN_H, h));
  animateBounds(f, boundsAtCorner(nearestCorner(b), w, h, a));
}

function scaleWindow(factor) {
  resizeToWidth(active().win.getBounds().width * factor);
}

// After a drag, pull the window onto any screen edge it was dropped close to.
function snapToEdges(f) {
  if (!store.get('snapToEdges') || f.win.isDestroyed() || Date.now() < f.ignoreMovedUntil) return;
  const b = f.win.getBounds();
  const a = workAreaFor(b);
  let { x, y } = b;
  if (Math.abs(b.x - a.x) < SNAP_DISTANCE) x = a.x + EDGE_MARGIN;
  else if (Math.abs(a.x + a.width - (b.x + b.width)) < SNAP_DISTANCE) x = a.x + a.width - b.width - EDGE_MARGIN;
  if (Math.abs(b.y - a.y) < SNAP_DISTANCE) y = a.y + EDGE_MARGIN;
  else if (Math.abs(a.y + a.height - (b.y + b.height)) < SNAP_DISTANCE) y = a.y + a.height - b.height - EDGE_MARGIN;
  if (x !== b.x || y !== b.y) animateBounds(f, { ...b, x, y });
}

function toggleSnapToEdges() {
  store.set('snapToEdges', !store.get('snapToEdges'));
  updateMenus();
}

function positionMenu() {
  return [
    ...CORNERS.map((c) => ({
      label: c.label,
      accelerator: `Control+Alt+Command+${c.key}`,
      registerAccelerator: false,
      click: () => moveToCorner(c.id),
    })),
    { type: 'separator' },
    ...SIZE_PRESETS.map((p) => ({
      label: `${p.label} (${p.width}×${Math.round(p.width * 9 / 16)})`,
      click: () => resizeToWidth(p.width),
    })),
    { label: 'Bigger', accelerator: 'Control+Alt+Command+=', registerAccelerator: false, click: () => scaleWindow(1.15) },
    { label: 'Smaller', accelerator: 'Control+Alt+Command+-', registerAccelerator: false, click: () => scaleWindow(1 / 1.15) },
    { type: 'separator' },
    { label: 'Snap to Screen Edges', type: 'checkbox', checked: store.get('snapToEdges'), click: toggleSnapToEdges },
    { label: 'Reset Window Position', click: resetPosition },
  ];
}

// Only meaningful for the packaged app; in dev it would register the bare Electron binary.
function openAtLoginSupported() {
  return app.isPackaged;
}

function toggleOpenAtLogin() {
  const on = !app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: on });
  updateMenus();
}

function resetPosition() {
  const f = active();
  f.win.setBounds(f.isMain ? defaultBounds() : newWindowBounds());
  if (f.isMain) store.set('bounds', f.win.getBounds());
  if (!f.win.isVisible()) f.win.show();
}

// Fallback: Google sign-in in a normal framed window that shares the same session.
function openSigninWindow(url = SIGNIN_URL) {
  if (signinWin && !signinWin.isDestroyed()) {
    signinWin.show();
    signinWin.focus();
    return;
  }
  signinWin = new BrowserWindow({
    width: 480,
    height: 680,
    title: 'Sign in to Google',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'signin-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  signinWin.setAlwaysOnTop(true, 'screen-saver');
  const swc = signinWin.webContents;
  swc.setUserAgent(FIREFOX_UA);
  swc.setWindowOpenHandler(({ url: u }) => {
    swc.loadURL(u);
    return { action: 'deny' };
  });
  swc.on('did-navigate', (_e, u) => {
    // Once Google hands us back to YouTube, we're signed in.
    if (new URL(u).hostname.endsWith('youtube.com')) {
      signinWin.close();
      goHome(mainFloat);
      mainFloat.win.show();
    }
  });
  signinWin.on('closed', () => { signinWin = null; });
  signinWin.loadURL(url);
}

function buildAppMenu() {
  // Hidden app menu: provides the local shortcuts and standard Edit keys (⌘C/⌘V in sign-in forms).
  return Menu.buildFromTemplate([
    {
      label: 'MacPiP',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'Command+N', click: () => newWindow() },
        { label: 'New Window from Clipboard', accelerator: 'Control+Alt+Command+N', registerAccelerator: false, click: newWindowFromClipboard },
        { label: 'Open URL…', accelerator: 'Command+L', click: () => showUrlBar() },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'Command+W', click: () => closeFloat() },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Always on Top', type: 'checkbox', checked: store.get('alwaysOnTop'), accelerator: 'Alt+Command+T', click: toggleAlwaysOnTop },
        { label: 'Compact Mode', type: 'checkbox', checked: store.get('compact'), accelerator: 'Alt+Command+C', click: toggleCompact },
        { label: 'Click-Through Mode', type: 'checkbox', checked: clickThrough, accelerator: 'Control+Alt+Command+X', registerAccelerator: false, click: toggleClickThrough },
        { label: 'Lock 16:9 Aspect Ratio', type: 'checkbox', checked: !!active()?.lockAspect, click: toggleAspect },
        { type: 'separator' },
        { label: 'Increase Opacity', accelerator: 'Alt+Command+Up', click: () => changeOpacity(0.1) },
        { label: 'Decrease Opacity', accelerator: 'Alt+Command+Down', click: () => changeOpacity(-0.1) },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Command+[', click: () => { const h = active().win.webContents.navigationHistory; if (h.canGoBack()) h.goBack(); } },
        { label: 'Forward', accelerator: 'Command+]', click: () => { const h = active().win.webContents.navigationHistory; if (h.canGoForward()) h.goForward(); } },
        { label: 'Home', accelerator: 'Shift+Command+H', click: () => goHome() },
        { type: 'separator' },
        { label: 'Playback', submenu: mediaMenu() },
        { label: 'Position & Size', submenu: positionMenu() },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
  ]);
}

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

function sitesMenu() {
  const recent = store.get('recentUrls');
  const home = store.get('homeUrl');
  return [
    ...PRESET_SITES.map((s) => ({ label: s.label, click: () => openUrl(s.url) })),
    { type: 'separator' },
    {
      label: 'Recent',
      enabled: recent.length > 0,
      submenu: recent.length
        ? [
          ...recent.map((u) => ({ label: u.length > 60 ? `${u.slice(0, 57)}…` : u, click: () => openUrl(u) })),
          { type: 'separator' },
          { label: 'Clear Recent', click: () => { store.set('recentUrls', []); updateMenus(); } },
        ]
        : [{ label: 'None', enabled: false }],
    },
    { type: 'separator' },
    { label: `Home: ${home.replace(/^https?:\/\//, '')}`, enabled: false },
    { label: 'Set Current Page as Home', click: setCurrentAsHome },
  ];
}

function buildTrayMenu() {
  const extras = [...floats].filter((f) => !f.isMain).length;
  return Menu.buildFromTemplate([
    { label: anyVisible() ? 'Hide' : 'Show', accelerator: 'Alt+Command+Y', click: toggleWindow },
    { type: 'separator' },
    { label: 'New Window', click: () => newWindow() },
    { label: 'New Window from Clipboard', accelerator: 'Control+Alt+Command+N', click: newWindowFromClipboard },
    { label: `Close Extra Windows (${extras})`, enabled: extras > 0, click: closeExtraWindows },
    { type: 'separator' },
    { label: 'Open URL…', click: () => showUrlBar() },
    { label: 'Open URL from Clipboard', accelerator: 'Control+Alt+Command+V', click: openClipboardUrl },
    { label: 'Sites', submenu: sitesMenu() },
    { type: 'separator' },
    { label: 'Compact Mode', type: 'checkbox', checked: store.get('compact'), click: toggleCompact },
    { label: 'Click-Through Mode', type: 'checkbox', checked: clickThrough, accelerator: 'Control+Alt+Command+X', click: toggleClickThrough },
    { label: 'Always on Top', type: 'checkbox', checked: store.get('alwaysOnTop'), click: toggleAlwaysOnTop },
    { label: 'Lock 16:9 Aspect Ratio', type: 'checkbox', checked: !!active()?.lockAspect, click: toggleAspect },
    { label: 'Show Dock Icon', type: 'checkbox', checked: store.get('showInDock'), click: toggleDock },
    {
      label: openAtLoginSupported() ? 'Open at Login' : 'Open at Login (installed app only)',
      type: 'checkbox',
      enabled: openAtLoginSupported(),
      checked: openAtLoginSupported() && app.getLoginItemSettings().openAtLogin,
      click: toggleOpenAtLogin,
    },
    { type: 'separator' },
    { label: 'Playback', submenu: mediaMenu() },
    { label: 'Position & Size', submenu: positionMenu() },
    { label: 'Sign in with Google (separate window)…', click: () => openSigninWindow() },
    { type: 'separator' },
    { label: 'Quit MacPiP', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

function updateTrayMenu() {
  if (tray && mainFloat) tray.setContextMenu(buildTrayMenu());
}

function updateMenus() {
  if (quitting || !mainFloat) return;
  Menu.setApplicationMenu(buildAppMenu());
  updateTrayMenu();
}

app.on('second-instance', () => {
  if (mainFloat) { mainFloat.win.show(); mainFloat.win.focus(); }
});

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(CHROME_UA);
  // Strip Chromium client hints from the sign-in window so it looks consistently like Firefox.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (signinWin && !signinWin.isDestroyed() && details.webContentsId === signinWin.webContents.id) {
      for (const k of Object.keys(headers)) {
        if (/^sec-ch-ua/i.test(k)) delete headers[k];
      }
      headers['User-Agent'] = FIREFOX_UA;
    }
    callback({ requestHeaders: headers });
  });
  applyDock(store.get('showInDock'));

  createFloat({ isMain: true, url: store.get('homeUrl') });
  startHoverWatcher();

  tray = new Tray(trayImage());
  tray.setToolTip('MacPiP');
  updateMenus();

  registerGlobalShortcuts();
});

app.on('before-quit', () => {
  quitting = true;
  if (mainFloat && !mainFloat.win.isDestroyed()) store.set('bounds', mainFloat.win.getBounds());
  store.flush();
});

const GLOBAL_SHORTCUTS = [
  ['Alt+Command+Y', toggleWindow],
  ['Control+Alt+Command+V', openClipboardUrl],
  ['Control+Alt+Command+N', newWindowFromClipboard],
  ['Control+Alt+Command+X', toggleClickThrough],
  ...CORNERS.map((c) => [`Control+Alt+Command+${c.key}`, () => moveToCorner(c.id)]),
  ['Control+Alt+Command+=', () => scaleWindow(1.15)],
  ['Control+Alt+Command+-', () => scaleWindow(1 / 1.15)],
  ...MEDIA_SHORTCUTS.map((m) => [m.accel, () => mediaAction(m.action)]),
];

function registerGlobalShortcuts() {
  for (const [accel, fn] of GLOBAL_SHORTCUTS) {
    if (!globalShortcut.register(accel, fn)) {
      console.warn(`Could not register global shortcut ${accel} (already in use by another app).`);
    }
  }
}

app.on('will-quit', () => globalShortcut.unregisterAll());

// Keep running in the menu bar when every window is hidden or closed.
app.on('window-all-closed', (e) => e.preventDefault());
