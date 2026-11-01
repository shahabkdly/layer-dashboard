'use strict';
/* Layer dashboard, desktop build.

   The page is the same index.html that runs in a browser. It is served to the window over a
   private app:// protocol instead of file://, because the dashboard needs things browsers
   refuse on file://: a Web Worker for DuckDB, WebAssembly with the right media type, fetch(),
   localStorage (which is where saved layouts live) and byte-range reads for the basemap.
   No network port is opened; app:// is handled inside this process and reads only this
   app's own folder. */
const electron = require('electron');
if (typeof electron === 'string' || !electron.app) {     // started as plain Node (ELECTRON_RUN_AS_NODE=1)
  console.error('Start the app with "npm start" (which clears ELECTRON_RUN_AS_NODE), not with node or a bare "electron ." in an editor terminal.');
  process.exit(1);
}
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, shell } = electron;
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { zipFolder } = require('./zipdir');

/* Portable: a build that was not installed (the zip, the unpacked folder, or the one-file
   portable .exe) keeps its settings and saved layouts in a "data" folder beside the program,
   so the whole folder can be copied to another place or PC and still has them. The installed
   build (an uninstaller sits beside the .exe) uses the usual per-user folder. If the folder is
   read-only (a CD, a locked share), the usual per-user folder is used as well. */
function portableDataDir() {
  if (!app.isPackaged) return null;
  const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  try {
    if (!process.env.PORTABLE_EXECUTABLE_DIR && fs.readdirSync(base).some(f => /^Uninstall .*\.exe$/i.test(f))) return null;
    const dir = path.join(base, process.env.PORTABLE_EXECUTABLE_DIR ? 'Layer dashboard data' : 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch { return null; }
}
const DATA_DIR = portableDataDir();
if (DATA_DIR) app.setPath('userData', DATA_DIR);

const ROOT = app.getAppPath();                 // holds index.html and lib/ (asar is off, see package.json)
const ICON = path.join(__dirname, 'icon.png');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://dashboard/`;
const DATA_FILTERS = [
  { name: 'Map data', extensions: ['gpkg', 'geojson', 'json', 'zip', 'shp', 'dbf', 'shx', 'prj', 'cpg'] },
  { name: 'GeoPackage', extensions: ['gpkg'] },
  { name: 'GeoJSON', extensions: ['geojson', 'json'] },
  { name: 'Shapefile parts', extensions: ['shp', 'dbf', 'shx', 'prj', 'cpg'] },
  { name: 'Zipped shapefile or geodatabase', extensions: ['zip'] },
  { name: 'All files', extensions: ['*'] }
];
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.pbf': 'application/x-protobuf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pmtiles': 'application/octet-stream',
  '.data': 'application/octet-stream', '.txt': 'text/plain', '.map': 'application/json'
};

// app:// behaves like https: secure context, fetch/XHR, streaming, and its own localStorage
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

let win = null;
let pending = [];                               // files named on the command line before the window exists

function serve() {
  protocol.handle(SCHEME, async req => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });      // never outside the app folder
    let st;
    try { st = await fs.promises.stat(file); } catch { return new Response('Not found', { status: 404 }); }
    if (!st.isFile()) return new Response('Not found', { status: 404 });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };

    // Byte ranges: the offline basemap (PMTiles) reads small slices of a 20 MB file
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    if (range) {
      let start = range[1] === '' ? null : Number(range[1]);
      let end = range[2] === '' ? st.size - 1 : Number(range[2]);
      if (start === null) { start = Math.max(0, st.size - end); end = st.size - 1; }     // suffix range
      if (!(start <= end && start < st.size)) return new Response('Range not satisfiable', { status: 416, headers: { 'content-range': `bytes */${st.size}` } });
      end = Math.min(end, st.size - 1);
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': String(end - start + 1) }
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { ...headers, 'content-length': String(st.size) } });
  });
}

const dataArgs = argv => argv.slice(1).filter(a => !a.startsWith('-') && /\.(gpkg|geojson|json|zip|shp)$/i.test(a) && fs.existsSync(a));

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 420, minHeight: 480,
    backgroundColor: themeBackground(), title: 'Layer dashboard', show: false,
    ...(fs.existsSync(ICON) ? { icon: ICON } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(ORIGIN + 'index.html');
  win.webContents.on('did-finish-load', () => { if (pending.length) { win.webContents.send('open-paths', pending); pending = []; } });
  // links (the OpenStreetMap credit) open in the real browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

const send = action => win && win.webContents.send('menu', action);

/* the page remembers light or dark; the window background (seen before the page paints) follows it */
const themeFile = () => path.join(app.getPath('userData'), 'theme.txt');
function themeBackground() {
  let t = null;
  try { t = fs.readFileSync(themeFile(), 'utf8').trim(); } catch { /* first start */ }
  const dark = t ? t === 'dark' : nativeTheme.shouldUseDarkColors;
  return dark ? '#0e1115' : '#eef1f5';
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Open data files…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Open geodatabase folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('openFolder') },
        { label: 'Load sample data', click: () => send('sample') },
        { type: 'separator' },
        { label: 'Export filtered features (GeoJSON)…', click: () => send('exportGeoJSON') },
        { label: 'Export filtered features (CSV)…', click: () => send('exportCSV') },
        { label: 'Export map image (PNG)…', click: () => send('exportPNG') },
        { label: 'Print or save as PDF…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        { label: 'Save layout file…', click: () => send('saveLayout') },
        { label: 'Load layout file…', click: () => send('loadLayout') },
        { label: 'Reset to automatic layout', click: () => send('resetLayout') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '&Dashboard',
      submenu: [
        { label: 'Edit layout', accelerator: 'CmdOrCtrl+E', click: () => send('edit') },
        { label: 'Add widget…', click: () => send('add') },
        { label: 'Clear all filters', accelerator: 'CmdOrCtrl+Backspace', click: () => send('clearFilters') },
        { label: 'Zoom map to results', click: () => send('zoomResults') }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Light or dark theme', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('theme') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About Layer dashboard',
          click: () => dialog.showMessageBox(win, {
            type: 'info', title: 'Layer dashboard',
            message: `Layer dashboard ${app.getVersion()}`,
            detail: 'Offline GIS analytics: MapLibre GL JS, DuckDB-WASM and GDAL-WASM.\n\n'
              + 'Everything runs on this computer. Nothing is sent anywhere unless you pick the\n'
              + 'OpenStreetMap basemap, which downloads map tiles while it is selected.\n\n'
              + 'Basemap data © OpenStreetMap contributors, tiles built with Protomaps.',
            buttons: ['Close']
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const readFiles = paths => paths.map(p => ({ name: path.basename(p), data: fs.readFileSync(p) }));

function wireIpc() {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open map data', buttonLabel: 'Open',
      properties: ['openFile', 'multiSelections'], filters: DATA_FILTERS
    });
    return r.canceled ? [] : readFiles(r.filePaths);
  });

  // a .gdb is a folder; zip it here so the page reads it exactly as it reads a dropped .gdb.zip
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open a file geodatabase (.gdb folder)', buttonLabel: 'Open', properties: ['openDirectory']
    });
    if (r.canceled) return null;
    const dir = r.filePaths[0], name = path.basename(dir);
    if (!/\.gdb$/i.test(name)) throw new Error(`“${name}” is not a .gdb folder. Choose the folder whose name ends in .gdb.`);
    return { name: name + '.zip', data: zipFolder(dir) };
  });

  ipcMain.handle('files:read', (_e, paths) => readFiles(paths.filter(p => fs.existsSync(p))));

  ipcMain.handle('dialog:save', async (_e, suggested, data, filters) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save', defaultPath: suggested, filters: filters || [{ name: 'All files', extensions: ['*'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, typeof data === 'string' ? data : Buffer.from(data));
    return r.filePath;
  });

  ipcMain.on('app:title', (_e, t) => { if (win && t) win.setTitle(String(t).slice(0, 120) + ' — Layer dashboard'); });
  ipcMain.on('app:theme', (_e, t) => {
    if (t !== 'dark' && t !== 'light') return;
    try { fs.writeFileSync(themeFile(), t); } catch { /* read-only: fine */ }
    if (win) win.setBackgroundColor(t === 'dark' ? '#0e1115' : '#eef1f5');
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const files = dataArgs(argv);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (files.length) win.webContents.send('open-paths', files); }
  });
  app.on('open-file', (e, p) => { e.preventDefault(); if (win) win.webContents.send('open-paths', [p]); else pending.push(p); });

  app.whenReady().then(() => {
    serve();
    wireIpc();
    buildMenu();
    pending = dataArgs(process.argv);
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
