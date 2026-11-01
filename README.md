# Layer dashboard

An offline GIS analytics dashboard built with MapLibre GL JS, DuckDB-WASM and GDAL-WASM. It needs no server and no internet connection.

## Run it in a browser (Windows)

1. Download or clone this repository.
2. Double-click **Open in browser.cmd**. It starts a small local web server (built into Windows, nothing to install) and opens the dashboard at http://localhost:8765/.
3. Close the window to stop it.

The dashboard has to come from a web server, because browsers won't run its WebAssembly engine from a page opened as a plain file.

## Desktop app (Electron)

```
npm install
npm start          # run the desktop app
npm run dist       # build Windows installer, zip and portable .exe into dist/
```

## Libraries and basemap

The `lib/` folder already contains everything the dashboard needs. To download it again, or to build an offline basemap for a different area:

```
node get-libs.mjs
node get-libs.mjs --basemap-only --bbox=minLon,minLat,maxLon,maxLat
```
