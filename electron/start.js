'use strict';
/* Launcher for "npm start".
   Some editors (VS Code, Cursor and other Electron-based tools) export ELECTRON_RUN_AS_NODE=1
   in their integrated terminals. Electron then starts as plain Node and the app crashes with
   "Cannot read properties of undefined (reading 'getAppPath')". Clearing the variable here
   means the app starts the same way from any terminal. */
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');            // path to the electron executable

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('close', code => process.exit(code ?? 0));
