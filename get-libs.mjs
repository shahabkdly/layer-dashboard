// Run once, with internet:   node get-libs.mjs
// Copies MapLibre GL JS, DuckDB-WASM, GDAL-WASM and an offline basemap into ./lib,
// so index.html never needs the network.
//
// Options
//   --bbox=minLon,minLat,maxLon,maxLat   basemap area (default: Riyadh / Diriyah)
//   --maxzoom=N                          basemap detail, 0-15 (default 15; 13 is ~4x smaller)
//   --basemap-only                       redo just the basemap, e.g. for a new area
//   --no-basemap                         skip the basemap
// Example: node get-libs.mjs --basemap-only --bbox=39.0,21.3,39.4,21.7
import { execSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync, writeFileSync, rmSync, statSync } from 'node:fs';

const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : dflt; };
const flag = name => process.argv.includes(`--${name}`);
const BBOX = arg('bbox', '46.30,24.30,47.10,25.10');
const MAXZOOM = arg('maxzoom', '15');
const doLibs = !flag('basemap-only'), doBasemap = !flag('no-basemap');
if (!/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(BBOX)) throw new Error('--bbox must be minLon,minLat,maxLon,maxLat');

// fetch with retries: parallel downloads occasionally hit transient TLS/network errors
const get = async (url, tries = 4) => {
  for (let i = 1; ; i++) {
    try { return await fetch(url); } catch (e) { if (i >= tries) throw e; await new Promise(r => setTimeout(r, 500 * i)); }
  }
};
const download = async (url, to) => {
  const res = await get(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
};

// Pinned on purpose: maplibre-gl 6+ ships ES modules only (no dist/maplibre-gl.js), and the
// duckdb-wasm "latest" npm tag points at -dev builds whose spatial extension may not be hosted.
// gdal3.js (GDAL-WASM) reads file geodatabases, which DuckDB-WASM's spatial build cannot.
// pmtiles + @protomaps/basemaps + rtl-text are for the offline basemap.
execSync('npm install --no-save --no-package-lock maplibre-gl@5.24.0 @duckdb/duckdb-wasm@1.32.0 gdal3.js@2.8.1 esbuild ' +
  'pmtiles@4.5.0 @protomaps/basemaps@5.7.2 @mapbox/mapbox-gl-rtl-text@0.4.0', { stdio: 'inherit' });

if (doLibs) {
  mkdirSync('lib/duckdb', { recursive: true });
  mkdirSync('lib/gdal', { recursive: true });
  const ml = 'node_modules/maplibre-gl/dist/';
  const dd = 'node_modules/@duckdb/duckdb-wasm/dist/';
  const gd = 'node_modules/gdal3.js/dist/package/';
  const jobs = [
    [gd + 'gdal3.js', 'lib/gdal/gdal3.js'],
    [gd + 'gdal3WebAssembly.wasm', 'lib/gdal/gdal3WebAssembly.wasm'],
    [gd + 'gdal3WebAssembly.data', 'lib/gdal/gdal3WebAssembly.data'],
    [ml + 'maplibre-gl.js', 'lib/maplibre-gl.js'],
    [ml + 'maplibre-gl.css', 'lib/maplibre-gl.css'],
    [dd + 'duckdb-mvp.wasm', 'lib/duckdb/duckdb-mvp.wasm'],
    [dd + 'duckdb-eh.wasm', 'lib/duckdb/duckdb-eh.wasm'],
    [dd + 'duckdb-browser-mvp.worker.js', 'lib/duckdb/duckdb-browser-mvp.worker.js'],
    [dd + 'duckdb-browser-eh.worker.js', 'lib/duckdb/duckdb-browser-eh.worker.js'],
  ];
  for (const [from, to] of jobs) {
    if (!existsSync(from)) { console.error('Missing ' + from + ' (the package layout may have changed)'); process.exitCode = 1; continue; }
    cpSync(from, to);
    console.log('copied', to);
  }

  // duckdb-browser.mjs imports "apache-arrow" by bare name, which a browser cannot resolve
  // without a bundler, so bundle the two into one self-contained ES module. The page also
  // uses a few Arrow builders (to load the attribute table without DuckDB's json extension).
  const esbuild = await import('esbuild');
  await esbuild.build({
    stdin: {
      contents: `export * from '@duckdb/duckdb-wasm';
                 export { Table, vectorFromArray, Float64, Int32, Utf8 } from 'apache-arrow';`,
      resolveDir: '.', loader: 'js'
    },
    bundle: true, format: 'esm', minify: true, platform: 'browser', target: 'es2020',
    mainFields: ['module', 'main'], outfile: 'lib/duckdb/duckdb-browser.mjs', logLevel: 'warning'
  });
  console.log('bundled lib/duckdb/duckdb-browser.mjs (duckdb-wasm + apache-arrow)');

  // DuckDB's "spatial" extension (.gpkg / .shp) is normally downloaded on first use.
  // Keep a local copy instead, in the same folder layout as extensions.duckdb.org.
  // DUCKDB_VERSION must match the engine inside the pinned duckdb-wasm (1.32.0 -> v1.4.3);
  // the page prints the right path in its error message if they ever drift apart.
  const DUCKDB_VERSION = 'v1.4.3';
  for (const platform of ['wasm_eh', 'wasm_mvp']) {
    const rel = `${DUCKDB_VERSION}/${platform}/spatial.duckdb_extension.wasm`;
    mkdirSync(`lib/ext/${DUCKDB_VERSION}/${platform}`, { recursive: true });
    try { await download('https://extensions.duckdb.org/' + rel, 'lib/ext/' + rel); console.log('downloaded lib/ext/' + rel); }
    catch (e) { console.error('Could not download ' + rel + ': ' + e.message); process.exitCode = 1; }
  }
}

/* ---- Offline basemap (Protomaps / OpenStreetMap data) ----
   lib/basemap/basemap.pmtiles   vector tiles for BBOX, cut from today's Protomaps world build
   lib/basemap/layers.json       map style layers ("light" flavour, English labels first)
   lib/basemap/fonts/, sprites/  label fonts and icons
   lib/pmtiles.js, lib/rtl-text.js  PMTiles reader, and the plugin that shapes Arabic text */
if (doBasemap) {
  mkdirSync('lib/basemap/sprites', { recursive: true });
  cpSync('node_modules/pmtiles/dist/pmtiles.js', 'lib/pmtiles.js');
  cpSync('node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js', 'lib/rtl-text.js');
  console.log('copied lib/pmtiles.js, lib/rtl-text.js');

  // style layers from @protomaps/basemaps; the page adds the source, fonts and sprites
  const { layers, namedFlavor } = await import('@protomaps/basemaps');
  const L = layers('protomaps', namedFlavor('light'), { lang: 'en' });
  writeFileSync('lib/basemap/layers.json', JSON.stringify(L));
  console.log(`wrote lib/basemap/layers.json (${L.length} layers)`);

  // icons
  const assets = 'https://protomaps.github.io/basemaps-assets/';
  for (const f of ['light.json', 'light.png', 'light@2x.json', 'light@2x.png']) await download(assets + 'sprites/v4/' + f, 'lib/basemap/sprites/' + f);
  console.log('downloaded lib/basemap/sprites/');

  // fonts: every 256-character range the style's three font stacks provide (missing ranges are skipped)
  const stacks = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
  let got = 0;
  for (const s of stacks) {
    mkdirSync(`lib/basemap/fonts/${s}`, { recursive: true });
    const ranges = Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}`);
    for (let i = 0; i < ranges.length; i += 16) {
      await Promise.all(ranges.slice(i, i + 16).map(async r => {
        const res = await get(`${assets}fonts/${encodeURIComponent(s)}/${r}.pbf`);
        if (res.ok) { writeFileSync(`lib/basemap/fonts/${s}/${r}.pbf`, Buffer.from(await res.arrayBuffer())); got++; }
      }));
    }
  }
  console.log(`downloaded ${got} font files into lib/basemap/fonts/`);

  // the pmtiles command-line tool (Go, single binary) cuts the area out of the world build
  // using HTTP range requests, so only the tiles inside BBOX are downloaded
  const rel = await (await get('https://api.github.com/repos/protomaps/go-pmtiles/releases/latest')).json();
  const os = { win32: 'Windows', darwin: 'Darwin', linux: 'Linux' }[process.platform];
  const cpu = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const asset = rel.assets.find(a => a.name.includes(`_${os}_${cpu}.`));
  if (!asset) throw new Error(`No go-pmtiles build for ${os} ${cpu}; download one from github.com/protomaps/go-pmtiles and run "pmtiles extract" yourself.`);
  mkdirSync('node_modules/.pmtiles', { recursive: true });
  const archive = 'node_modules/.pmtiles/' + asset.name;
  await download(asset.browser_download_url, archive);
  execFileSync('tar', ['-xf', asset.name], { cwd: 'node_modules/.pmtiles' });
  const exe = 'node_modules/.pmtiles/pmtiles' + (process.platform === 'win32' ? '.exe' : '');

  const builds = await (await get('https://build-metadata.protomaps.dev/builds.json')).json();
  const world = 'https://build.protomaps.com/' + builds[builds.length - 1].key;
  rmSync('lib/basemap/basemap.pmtiles', { force: true });
  console.log(`extracting ${BBOX} up to zoom ${MAXZOOM} from ${world} ...`);
  execFileSync(exe, ['extract', world, 'lib/basemap/basemap.pmtiles', `--bbox=${BBOX}`, `--maxzoom=${MAXZOOM}`], { stdio: 'inherit' });
  console.log(`wrote lib/basemap/basemap.pmtiles (${(statSync('lib/basemap/basemap.pmtiles').size / 1e6).toFixed(1)} MB)`);
}

console.log(`
Done. lib/ now holds everything the page needs; no internet is used from here on.
Next:  npm start                      desktop app
       double-click "Open in browser.cmd"   the page in your browser (nothing to install)
       npm run dist                   portable zip, one-file portable .exe and installer in dist/
`);
