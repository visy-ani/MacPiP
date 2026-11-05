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

let win = null;
let tray = null;
let signinWin = null;
let barVisible = false;
let barHideTimer = null;
let quitting = false;
// Click-through ("ghost") mode: the window ignores the mouse and goes translucent.
// Not persisted, so a relaunch never leaves you with a window you can't click.
let clickThrough = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
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

function boundsAreVisible(b) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 &&
    b.y < a.y + a.height - 40 && b.y + b.height > a.y);
}

function applyAlwaysOnTop(on) {
  // 'screen-saver' level floats above full-screen apps.
  win.setAlwaysOnTop(on, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

function applyAspect(on) {
  win.setAspectRatio(on ? 16 / 9 : 0);
}

function applyDock(show) {
  if (!app.dock) return;
  if (show) app.dock.show();
  else app.dock.hide();
}

function createWindow() {
  const saved = store.get('bounds');
  const bounds = saved && boundsAreVisible(saved) ? saved : defaultBounds();

  win = new BrowserWindow({
    ...bounds,
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

  applyAlwaysOnTop(store.get('alwaysOnTop'));
  applyAspect(store.get('lockAspect'));
  applyOpacity();

  const wc = win.webContents;
  wc.setUserAgent(CHROME_UA);

  wc.on('dom-ready', () => {
    wc.insertCSS(injectCss);
    wc.send('compact', store.get('compact'));
    wc.send('bar-visible', barVisible);
  });

  // Keep YouTube/Google links in this window; send everything else to the default browser.
  // Send Google sign-in to the separate Firefox-UA window instead of the embedded page.
  const interceptSignin = (e, url) => {
    if (isSigninUrl(url)) {
      e.preventDefault();
      openSigninWindow(url);
    }
  };
  wc.on('will-navigate', (e) => interceptSignin(e, e.url));
  wc.on('will-redirect', (e) => interceptSignin(e, e.url));

  wc.setWindowOpenHandler(({ url }) => {
    if (isSigninUrl(url)) {
      openSigninWindow(url);
      return { action: 'deny' };
    }
    if (isInternalUrl(url)) wc.loadURL(url);
    else shell.openExternal(url);
    return { action: 'deny' };
  });

  const saveBounds = () => {
    if (!win.isDestroyed()) store.set('bounds', win.getBounds());
  };
  win.on('moved', () => {
    snapToEdges();
    saveBounds();
  });
  win.on('resized', saveBounds);

  win.on('close', (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('show', updateTrayMenu);
  win.on('hide', updateTrayMenu);

  win.once('ready-to-show', () => win.show());
  win.loadURL(store.get('homeUrl'));

  startHoverWatcher();
}

// "www.youtube.com" -> "youtube.com". Good enough to tell "same site" for popups.
function baseDomain(hostname) {
  return hostname.split('.').slice(-2).join('.');
}

// Popups stay in the window when they're YouTube/Google or the same site as the current page.
function isInternalUrl(url) {
  try {
    const { hostname } = new URL(url);
    if (/(^|\.)(youtube\.com|youtu\.be|google\.com|googleusercontent\.com)$/.test(hostname)) return true;
    const current = win && !win.isDestroyed() ? win.webContents.getURL() : '';
    return current !== '' && baseDomain(new URL(current).hostname) === baseDomain(hostname);
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

function openUrl(input) {
  const url = normalizeUrl(input);
  if (!url) return;
  addRecent(url);
  win.webContents.loadURL(url);
  if (!win.isVisible()) win.show();
  updateMenus();
}

function showUrlBar() {
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.send('url-bar', win.webContents.getURL());
}

function openClipboardUrl() {
  const text = clipboard.readText().trim();
  if (/^https?:\/\/\S+$/i.test(text)) openUrl(text);
}

function setCurrentAsHome() {
  const url = win.webContents.getURL();
  if (/^https?:/i.test(url)) {
    store.set('homeUrl', url);
    updateMenus();
  }
}

function goHome() {
  win.webContents.loadURL(store.get('homeUrl'));
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
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (clickThrough) {
      setBarVisible(false);
      return;
    }
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    const inTopStrip = inside && p.y < b.y + BAR_HEIGHT + 4;
    if (inTopStrip) {
      clearTimeout(barHideTimer);
      barHideTimer = null;
      setBarVisible(true);
    } else if (barVisible && !barHideTimer) {
      barHideTimer = setTimeout(() => {
        barHideTimer = null;
        setBarVisible(false);
      }, 500);
    }
  }, 100);
}

function setBarVisible(v) {
  if (v === barVisible) return;
  barVisible = v;
  win.webContents.send('bar-visible', v);
}

ipcMain.on('bar-action', (_e, action) => {
  const wc = win.webContents;
  if (action === 'back') {
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  } else if (action === 'home') {
    goHome();
  } else if (action === 'url') {
    showUrlBar();
  } else if (action === 'close') {
    win.hide();
  }
});

ipcMain.on('open-url', (_e, input) => openUrl(input));

function toggleWindow() {
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function toggleAlwaysOnTop() {
  const on = !store.get('alwaysOnTop');
  store.set('alwaysOnTop', on);
  applyAlwaysOnTop(on);
  updateMenus();
}

function applyOpacity() {
  const base = store.get('opacity');
  win.setOpacity(clickThrough ? Math.min(base, store.get('ghostOpacity')) : base);
}

function changeOpacity(delta) {
  const next = Math.round(Math.min(1, Math.max(0.4, store.get('opacity') + delta)) * 100) / 100;
  store.set('opacity', next);
  applyOpacity();
}

function toggleClickThrough() {
  clickThrough = !clickThrough;
  win.setIgnoreMouseEvents(clickThrough);
  // A focused window would still swallow key presses meant for the app underneath.
  if (clickThrough) win.blur();
  applyOpacity();
  if (clickThrough && !win.isVisible()) win.showInactive();
  if (tray) tray.setToolTip(clickThrough ? 'MacPiP (click-through: ⌃⌥⌘X to exit)' : 'MacPiP');
  updateMenus();
}

function toggleCompact() {
  const on = !store.get('compact');
  store.set('compact', on);
  win.webContents.send('compact', on);
  updateMenus();
}

function toggleAspect() {
  const on = !store.get('lockAspect');
  store.set('lockAspect', on);
  applyAspect(on);
  if (on) {
    const b = win.getBounds();
    win.setBounds({ ...b, height: Math.max(MIN_H, Math.round(b.width * 9 / 16)) });
  }
  updateMenus();
}

function toggleDock() {
  const show = !store.get('showInDock');
  store.set('showInDock', show);
  applyDock(show);
  updateMenus();
  // Hiding the dock icon can drop focus; bring the window back.
  if (win.isVisible()) win.show();
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

function moveToCorner(corner) {
  const b = win.getBounds();
  win.setBounds(boundsAtCorner(corner, b.width, b.height, workAreaFor(b)), true);
  if (!win.isVisible()) win.showInactive();
  store.set('bounds', win.getBounds());
}

// Resize to a given width, keeping the window pinned to its nearest corner.
function resizeToWidth(width) {
  const b = win.getBounds();
  const a = workAreaFor(b);
  const w = Math.round(Math.min(a.width - 2 * EDGE_MARGIN, Math.max(MIN_W, width)));
  let h = store.get('lockAspect') ? Math.round(w * 9 / 16) : Math.round(b.height * w / b.width);
  h = Math.min(a.height - 2 * EDGE_MARGIN, Math.max(MIN_H, h));
  win.setBounds(boundsAtCorner(nearestCorner(b), w, h, a), true);
  store.set('bounds', win.getBounds());
}

function scaleWindow(factor) {
  resizeToWidth(win.getBounds().width * factor);
}

// After a drag, pull the window onto any screen edge it was dropped close to.
function snapToEdges() {
  if (!store.get('snapToEdges') || win.isDestroyed()) return;
  const b = win.getBounds();
  const a = workAreaFor(b);
  let { x, y } = b;
  if (Math.abs(b.x - a.x) < SNAP_DISTANCE) x = a.x + EDGE_MARGIN;
  else if (Math.abs(a.x + a.width - (b.x + b.width)) < SNAP_DISTANCE) x = a.x + a.width - b.width - EDGE_MARGIN;
  if (Math.abs(b.y - a.y) < SNAP_DISTANCE) y = a.y + EDGE_MARGIN;
  else if (Math.abs(a.y + a.height - (b.y + b.height)) < SNAP_DISTANCE) y = a.y + a.height - b.height - EDGE_MARGIN;
  if (x !== b.x || y !== b.y) win.setPosition(x, y, true);
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

function resetPosition() {
  win.setBounds(defaultBounds());
  store.set('bounds', win.getBounds());
  if (!win.isVisible()) win.show();
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
      goHome();
      win.show();
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
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Always on Top', type: 'checkbox', checked: store.get('alwaysOnTop'), accelerator: 'Alt+Command+T', click: toggleAlwaysOnTop },
        { label: 'Compact Mode', type: 'checkbox', checked: store.get('compact'), accelerator: 'Alt+Command+C', click: toggleCompact },
        { label: 'Click-Through Mode', type: 'checkbox', checked: clickThrough, accelerator: 'Control+Alt+Command+X', registerAccelerator: false, click: toggleClickThrough },
        { label: 'Lock 16:9 Aspect Ratio', type: 'checkbox', checked: store.get('lockAspect'), click: toggleAspect },
        { type: 'separator' },
        { label: 'Increase Opacity', accelerator: 'Alt+Command+Up', click: () => changeOpacity(0.1) },
        { label: 'Decrease Opacity', accelerator: 'Alt+Command+Down', click: () => changeOpacity(-0.1) },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Command+[', click: () => ipcMain.emit('bar-action', null, 'back') },
        { label: 'Home', accelerator: 'Shift+Command+H', click: goHome },
        { label: 'Open URL…', accelerator: 'Command+L', click: showUrlBar },
        { type: 'separator' },
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
  return Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Hide' : 'Show', accelerator: 'Alt+Command+Y', click: toggleWindow },
    { type: 'separator' },
    { label: 'Open URL…', click: showUrlBar },
    { label: 'Open URL from Clipboard', accelerator: 'Control+Alt+Command+V', click: openClipboardUrl },
    { label: 'Sites', submenu: sitesMenu() },
    { type: 'separator' },
    { label: 'Compact Mode', type: 'checkbox', checked: store.get('compact'), click: toggleCompact },
    { label: 'Click-Through Mode', type: 'checkbox', checked: clickThrough, accelerator: 'Control+Alt+Command+X', click: toggleClickThrough },
    { label: 'Always on Top', type: 'checkbox', checked: store.get('alwaysOnTop'), click: toggleAlwaysOnTop },
    { label: 'Lock 16:9 Aspect Ratio', type: 'checkbox', checked: store.get('lockAspect'), click: toggleAspect },
    { label: 'Show Dock Icon', type: 'checkbox', checked: store.get('showInDock'), click: toggleDock },
    { type: 'separator' },
    { label: 'Position & Size', submenu: positionMenu() },
    { label: 'Sign in with Google (separate window)…', click: () => openSigninWindow() },
    { type: 'separator' },
    { label: 'Quit MacPiP', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

function updateTrayMenu() {
  if (tray && win) tray.setContextMenu(buildTrayMenu());
}

function updateMenus() {
  Menu.setApplicationMenu(buildAppMenu());
  updateTrayMenu();
}

app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
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

  createWindow();

  tray = new Tray(trayImage());
  tray.setToolTip('MacPiP');
  updateMenus();

  registerGlobalShortcuts();
});

app.on('before-quit', () => {
  quitting = true;
  if (win && !win.isDestroyed()) store.set('bounds', win.getBounds());
  store.flush();
});

const GLOBAL_SHORTCUTS = [
  ['Alt+Command+Y', toggleWindow],
  ['Control+Alt+Command+V', openClipboardUrl],
  ['Control+Alt+Command+X', toggleClickThrough],
  ...CORNERS.map((c) => [`Control+Alt+Command+${c.key}`, () => moveToCorner(c.id)]),
  ['Control+Alt+Command+=', () => scaleWindow(1.15)],
  ['Control+Alt+Command+-', () => scaleWindow(1 / 1.15)],
];

function registerGlobalShortcuts() {
  for (const [accel, fn] of GLOBAL_SHORTCUTS) {
    if (!globalShortcut.register(accel, fn)) {
      console.warn(`Could not register global shortcut ${accel} (already in use by another app).`);
    }
  }
}

app.on('will-quit', () => globalShortcut.unregisterAll());

// Keep running in the menu bar when the window is hidden.
app.on('window-all-closed', (e) => e.preventDefault());
