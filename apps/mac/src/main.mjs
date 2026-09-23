import {app, BrowserWindow, dialog, shell} from "electron";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createApp} from "../../../packages/app/dist/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEME = "contextdeck";
let win = null;
let base = null;
const pending = [];

const isDeepLink = (value) => typeof value === "string" && value.startsWith(`${SCHEME}://`);

function openLink(link) {
  if (!win || !base) { pending.push(link); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  win.webContents.executeJavaScript(`window.contextDeck && window.contextDeck.openDeepLink(${JSON.stringify(link)})`).catch(() => {});
}

// One running copy: later launches (Windows/Linux deep links) hand their link to it.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_event, argv) => { const link = argv.find(isDeepLink); if (link) openLink(link); else win?.focus(); });
// macOS delivers contextdeck:// links here, including the one that launched the app.
app.on("open-url", (event, link) => { event.preventDefault(); openLink(link); });

if (process.defaultApp) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [process.argv[1]]);
else app.setAsDefaultProtocolClient(SCHEME);

app.whenReady().then(async () => {
  const {server} = createApp({
    uiDir: join(here, "..", "ui"),
    pickFile: async () => {
      const result = await dialog.showOpenDialog(win, {title: "Choose a video or audio file", properties: ["openFile"],
        filters: [{name: "Video and audio", extensions: ["mp4", "m4v", "mov", "webm", "mkv", "mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"]}]});
      return result.canceled ? null : result.filePaths[0] ?? null;
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}/`;
  win = new BrowserWindow({width: 1280, height: 900, minWidth: 900, minHeight: 640, title: "Context Deck", backgroundColor: "#f7f7f4",
    webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false}});
  win.webContents.setWindowOpenHandler(({url}) => { if (/^https?:/.test(url)) shell.openExternal(url); return {action: "deny"}; });
  win.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(base)) { event.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  const initial = process.argv.find(isDeepLink);
  if (initial) pending.push(initial);
  win.webContents.once("did-finish-load", () => { for (const link of pending.splice(0)) openLink(link); });
  await win.loadURL(base);
  app.on("before-quit", () => server.close());
});

app.on("window-all-closed", () => app.quit());
