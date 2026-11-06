# MacPiP

> Based on [YT Float](https://github.com/dadhichgaurav1/yt_float) by Gaurav Dadhich. Thanks for the great foundation!

![MacPiP: YouTube floating over a code editor](docs/social-preview.png)

Picture-in-picture for any website on your Mac. MacPiP puts YouTube (or Twitch, Vimeo, or any page you like) in a small, frameless, always-on-top window. It floats over everything, including full-screen apps and every Space. It stays signed in to your own account and stays out of the way when you're not using it.

Built with Electron and plain JavaScript. There's no frontend framework, no tracking and no updater.

## Features

- **Floats everywhere:** always on top, including above full-screen apps, and visible on all Spaces.
- **Any website:** press ⌘L (or the ⌕ button) to type a URL or a search. ⌃⌥⌘V opens the URL on your clipboard from any app. There are preset sites, a list of recent URLs, and a home page you can set.
- **More than one window:** open an article, docs or a second video in its own floating window next to your video. Use ⌘N, the **+** button, right-click a link → **Open Link in New Window**, or ⌘/⇧-click a link. Copy a link anywhere and press ⌃⌥⌘N to open it in a new window. New windows start tall and narrow for reading.
- **Control playback from any app:** play/pause, skip 10s, mute and change speed without switching to the window. A small indicator shows what happened. Works on any site with an HTML5 video.
- **Click-through (ghost) mode:** ⌃⌥⌘X makes the window see-through and ignores the mouse, so you can keep working underneath it.
- **Snap to corners:** ⌃⌥⌘1–4 sends the window to a screen corner, and ⌃⌥⌘= / ⌃⌥⌘- resize it. Drop the window near a screen edge and it snaps into place.
- **Pauses when hidden:** hiding the window pauses the video, and showing it again resumes.
- **Stays out of the way:** frameless window with rounded corners and a subtle shadow. A thin drag bar with **Back / Home / Open URL / YouTube / New Window / Close** appears only when you hover the top edge. The YouTube button opens YouTube in its own 16:9 window beside the current page, or brings an open YouTube window forward.
- **Sized for video:** resizable from any edge or corner, with size presets (Small to Extra Large). Locked to 16:9 by default (toggleable).
- **Remembers itself:** last position and size are restored on launch.
- **Compact mode:** hides YouTube's header and sidebar. On a video page, the player fills the window.
- **Adjustable opacity:** from 40% to 100%.
- **Menu bar app:** a menu bar icon with all the controls. The Dock icon is hidden by default (optional).
- **Stays signed in:** persistent session, so you sign in once.

## Screenshots

| Normal | Compact mode (⌥⌘C) with the hover drag bar |
|---|---|
| ![Normal mode](docs/screenshot-normal.png) | ![Compact mode](docs/screenshot-compact.png) |

<sub>Video: *Big Buck Bunny* © Blender Foundation, CC BY 3.0.</sub>

## Keyboard shortcuts

**Global** (work from any app):

| Shortcut | Action |
|---|---|
| ⌥⌘Y | Show / hide the window |
| ⌃⌥⌘V | Open the URL on the clipboard |
| ⌃⌥⌘N | Open the URL on the clipboard in a new window |
| ⌃⌥⌘X | Turn click-through mode on / off |
| ⌃⌥⌘Space | Play / pause |
| ⌃⌥⌘← / ⌃⌥⌘→ | Back / forward 10 seconds |
| ⌃⌥⌘M | Mute / unmute |
| ⌃⌥⌘[ / ⌃⌥⌘] | Slower / faster (0.5× to 3×) |
| ⌃⌥⌘0 | Normal speed |
| ⌃⌥⌘1 / 2 / 3 / 4 | Move to top-left / top-right / bottom-left / bottom-right |
| ⌃⌥⌘= / ⌃⌥⌘- | Bigger / smaller |

**When MacPiP is the active app:**

| Shortcut | Action |
|---|---|
| ⌘L | Open URL / search (⇧↩ opens it in a new window) |
| ⌘N | New window |
| ⌘Y | Open YouTube (in a video window beside the current one) |
| ⌘W | Close window (the main window just hides) |
| ⌥⌘T | Toggle always-on-top |
| ⌥⌘↑ / ⌥⌘↓ | Opacity up / down |
| ⌥⌘C | Toggle compact mode |
| ⌘[ / ⌘] | Back / forward |
| ⇧⌘H | Home |

Window shortcuts (corners, size, 16:9 lock) act on the window you clicked last. Media shortcuts go to the window that's playing a video. ⌥⌘Y hides all windows, then brings back the ones that were showing. If another app already uses one of the global shortcuts, MacPiP logs a warning and skips it.

Right-click anywhere in a page for links (open in a new window, open in browser, copy), back/forward, reload, and new/close window.

## Menu bar icon

Show/Hide · New Window · Open YouTube · New Window from Clipboard · Close Extra Windows · Open URL… · Open URL from Clipboard · Sites (presets, recent, set home) · Compact Mode · Click-Through Mode · Always on Top · Lock 16:9 Aspect Ratio · Show Dock Icon · Open at Login · Playback · Position & Size · Sign in with Google (separate window) · Quit

Close (in the drag bar) hides the window to the menu bar. Use **Quit** to exit.

## Download

Grab `MacPiP-<version>-mac-universal.zip` from the [latest release](https://github.com/visy-ani/MacPiP/releases/latest). It runs on Apple Silicon and Intel Macs.

1. Unzip it and move `MacPiP.app` into Applications.
2. Open it. macOS blocks the first launch, because the app is not notarized by Apple.
3. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the MacPiP message. You only need to do this once.

If you prefer the terminal, this does the same thing:

```bash
xattr -dr com.apple.quarantine "/Applications/MacPiP.app"
```

## Build from source

Requires macOS and Node.js 18+.

```bash
git clone https://github.com/visy-ani/MacPiP.git
cd MacPiP
npm install
```

Run in development:

```bash
npm start
```

Or create a double-clickable dev launcher, `~/Applications/MacPiP (Dev).app`. It shows up in Spotlight and can be kept in the Dock. Each click quits any running MacPiP and starts this checkout's source, logging to `/tmp/macpip-dev.log`:

```bash
npm run make-launcher
```

Build a standalone app:

```bash
npm run build
```

This produces `dist/mac-<arch>/MacPiP.app` for your Mac's architecture (`npm run build:universal` builds one that runs on both). The build is ad-hoc signed, so no Apple Developer account is needed, and Apple Silicon Macs won't report it as "damaged". Copy it into Applications:

```bash
ditto --noextattr "dist/mac-arm64/MacPiP.app" "/Applications/MacPiP.app"
```

If macOS warns on first launch, right-click the app and choose **Open**, once.

> If the project lives in an iCloud-synced folder (like `~/Documents`), a Finder drag can carry over file attributes that break the signature. Use the `ditto --noextattr` command above, or run `xattr -cr "/Applications/MacPiP.app"` afterwards.

## Install from source (one command)

```bash
npm install
npm run install-app
```

This builds `MacPiP.app`, copies it into `/Applications` (replacing any older copy), and launches it. Run it again after pulling changes to update. Then turn on **Open at Login** in the menu bar icon, and MacPiP will start quietly in the menu bar every time you log in.

## Signing in to Google

Google blocks sign-in from many embedded browsers ("This browser or app may not be secure"). To work around this, MacPiP never signs you in inside the floating window. Clicking **Sign in** on YouTube (or using the menu bar item) opens a separate, normal window that presents itself as Firefox. It shares the same session with the floating window. Once Google sends you back to YouTube, that window closes and the floating window reloads signed in.

Google may change its checks at any time, so this can break without warning.

## How it works

| File | Purpose |
|---|---|
| `src/main.js` | Main process: window, shortcuts, tray, cursor polling for the drag bar, sign-in window |
| `src/preload.js` | Injected into every page: drag bar, URL bar, media controls and their indicator, compact mode |
| `src/newtab.html` | Blank start page for new windows |
| `src/inject.css` | Drag bar, URL bar, indicator and compact-mode styles |
| `src/signin-preload.js` | Makes the sign-in window look consistently like Firefox |
| `src/store.js` | Tiny JSON settings store |
| `scripts/make-icons.py` | Draws the app icon and menu bar icon (`python3 scripts/make-icons.py --preview out.png` to compare color themes) |
| `build/adhoc-sign.js` | Post-package hook that ad-hoc signs the `.app` |

Settings and the login session live in `~/Library/Application Support/MacPiP/`. Delete that folder to reset everything.

The drag bar is shown by polling the cursor position from the main process. Frameless windows don't reliably deliver hover events over drag regions, so the page can't detect the hover on its own.

## Limitations

- macOS only.
- Compact mode relies on YouTube's current page structure and may need updating when YouTube changes its layout.
- DRM-protected streaming sites (Netflix, Prime Video, Disney+) won't play, because stock Electron doesn't include the Widevine DRM module.
- Media controls only reach videos on the main page, not videos embedded in iframes.

## Disclaimer

Not affiliated with, endorsed by, or sponsored by YouTube or Google. YouTube is a trademark of Google LLC. This is a personal wrapper around regular websites. Use it in line with YouTube's Terms of Service.

## License

Public domain, under the [Unlicense](LICENSE). Do whatever you want with it.
