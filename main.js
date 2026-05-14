const { app, BrowserWindow, Menu } = require('electron');
const http = require('http');
const path = require('path');

// ── Start the proxy server ────────────────────────────────────────────────────
// proxy.js calls server.listen() immediately on require.
// If port 3001 is already taken (e.g. a leftover terminal instance) we just
// connect to whichever instance answers on that port.
try { require('./proxy'); } catch (e) { /* port already in use — that's fine */ }

// ── Create the main window ────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',   // macOS traffic-light overlay
    backgroundColor: '#0a0a0c',
    title: 'stream.',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Wait until the proxy is accepting connections, then load the player
  const load = (attempts = 0) => {
    http.get('http://127.0.0.1:3001/health', (res) => {
      res.resume();
      win.loadURL('http://127.0.0.1:3001');
    }).on('error', () => {
      if (attempts < 30) setTimeout(() => load(attempts + 1), 100);
      else win.loadURL('http://127.0.0.1:3001'); // try anyway
    });
  };
  load();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.setName('stream.');

// Minimal native menu (keeps standard Copy/Paste/Quit shortcuts)
app.whenReady().then(() => {
  const template = [
    { label: 'stream.', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: 'Edit', submenu: [
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'reload' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { role: 'close' },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
