#!/usr/bin/env node
// Observador de archivos de FlowScore.
//
// Vigila public/, settings/, wasmer.toml, app.yaml y package.json. Al detectar
// un cambio recompila el paquete de Wasmer (contenedor .webc, que empaqueta el
// módulo .wasm de static-web-server junto con los archivos de la app) y reinicia
// el proceso local de Wasmer (`wasmer run --net`) para recargar la app.
//
// Con el argumento `--deploy` además despliega en Wasmer Edge tras recargar:
//     node watch.js --deploy
// (requiere haber hecho `wasmer login`).
//
// Uso normal:
//     node watch.js
//     npm run watch

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, '.webc');
const OUT_FILE = path.join(OUT_DIR, 'flowscores.webc');
const APP_YAML = path.join(ROOT, 'app.yaml');
const DEBOUNCE_MS = 500;
const RESTART_WAIT_MS = 400;
const KILL_TIMEOUT_MS = 3000;

const WATCH_DIRS = ['public', 'settings'];
const WATCH_FILES = ['wasmer.toml', 'app.yaml', 'package.json'];

const deployEnabled = process.argv.includes('--deploy');

let child = null;
let pending = null;
let rebuilding = false;
let queued = false;
const watchers = [];
let appYamlKnown = existsSync(APP_YAML) ? readFileSync(APP_YAML, 'utf8') : null;

const sleep = ms => new Promise(res => setTimeout(res, ms));

function log(...args) {
  console.log('[' + new Date().toLocaleTimeString() + ']', ...args);
}

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', encoding: 'utf8' });
  return r.status;
}

// Recompila el proyecto: empaqueta el manifiesto wasmer.toml en un contenedor
// .webc (módulo .wasm + archivos). Es el paso "compilar a .wasm" de este proyecto.
function build() {
  // `wasmer package build` no sobrescribe: hay que borrar el artefacto previo.
  rmSync(OUT_FILE, { force: true });
  log('Recompilando paquete .webc (.wasm + archivos)...');
  const code = runSync('wasmer', ['package', 'build', '.', '-o', OUT_FILE]);
  if (code !== 0) {
    console.error('  ERROR: no se pudo recompilar el paquete.');
    return false;
  }
  log('  OK: ' + OUT_FILE);
  return true;
}

// Detiene el proceso local de Wasmer y espera a que libere el puerto.
function stopServer() {
  return new Promise(resolve => {
    const target = child;
    if (!target || target.exitCode !== null) return resolve();
    let finished = false;
    const finish = () => {
      if (!finished) { finished = true; clearTimeout(timer); resolve(); }
    };
    const timer = setTimeout(() => {
      // Fuerza el cierre si el proceso no murió (necesario en Windows).
      if (target.exitCode === null) {
        try { spawnSync('taskkill', ['/pid', String(target.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (_) {}
      }
      finish();
    }, KILL_TIMEOUT_MS);
    target.once('exit', finish);
    try { target.kill('SIGTERM'); } catch (_) {}
  });
}

// Arranca el servidor local de Wasmer en el puerto de settings/config.toml (8080).
function startServer() {
  log('Arrancando Wasmer (wasmer run --net)...');
  child = spawn('wasmer', ['run', '--net', OUT_FILE], { cwd: ROOT, stdio: 'inherit' });
  child.on('error', err => {
    console.error('  ERROR al iniciar el servidor: ' + err.message);
  });
  child.on('exit', code => {
    if (code !== null && code !== 0) console.error('  El servidor de Wasmer se detuvo (código ' + code + ').');
  });
  log('  App local disponible en http://localhost:8080 (recarga manual para ver los cambios).');
}

// Despliega la app en Wasmer Edge (requiere sesión: `wasmer login`).
function deploy() {
  log('Desplegando en Wasmer Edge...');
  const code = runSync('wasmer', ['deploy', '--non-interactive', '--no-wait']);
  if (code !== 0) {
    console.error('  ERROR: falló el despliegue (¿estás con sesión iniciada? prueba `wasmer login`).');
    return;
  }
  appYamlKnown = existsSync(APP_YAML) ? readFileSync(APP_YAML, 'utf8') : appYamlKnown;
  log('  Despliegue OK.');
}

async function rebuild() {
  if (rebuilding) { queued = true; return; }
  rebuilding = true;
  try {
    log('== Cambios detectados ==');
    if (build()) {
      await stopServer();
      await sleep(RESTART_WAIT_MS);
      startServer();
      if (deployEnabled) deploy();
    }
  } finally {
    rebuilding = false;
    if (queued) { queued = false; schedule(); }
  }
}

function schedule() {
  clearTimeout(pending);
  pending = setTimeout(rebuild, DEBOUNCE_MS);
}

// Ignora eventos que provoca el propio watcher (salida .webc, o app.yaml
// reescrito por `wasmer deploy`).
function isSelfWrite(pathName) {
  const base = path.basename(pathName);
  if (/\.webc$/i.test(base) || base.endsWith('.log')) return true;
  if (base === 'app.yaml') {
    if (!existsSync(APP_YAML)) return true;
    return readFileSync(APP_YAML, 'utf8') === appYamlKnown;
  }
  return false;
}

function onEvent(eventType, fileName) {
  if (!fileName) return;
  const name = String(fileName);
  if (isSelfWrite(name)) return;
  log('  archivo cambiado: ' + name);
  schedule();
}

function addWatcher(target) {
  let w;
  try {
    w = watch(target, { recursive: true }, onEvent);
  } catch (err) {
    w = watch(target, onEvent);
  }
  w.on('error', err => {
    if (err.code === 'EPERM' || err.code === 'ENOENT') {
      // Disney: algunos editores reemplazan ficheros/carpetas temporalmente
    } else {
      console.error('  error del watcher en ' + target + ': ' + err.message);
    }
  });
  watchers.push(w);
}

function shutdown() {
  log('Deteniendo watcher y servidor de Wasmer...');
  watchers.forEach(w => { try { w.close(); } catch (_) {} });
  stopServer().then(() => process.exit(0));
}

async function main() {
  const pre = spawnSync('wasmer', ['--version'], { encoding: 'utf8' });
  if (pre.status !== 0) {
    console.error('ERROR: no se encontró el CLI de Wasmer en el PATH.');
    process.exit(1);
  }

  for (const d of WATCH_DIRS) {
    if (existsSync(path.join(ROOT, d))) addWatcher(path.join(ROOT, d));
  }
  for (const f of WATCH_FILES) {
    if (existsSync(path.join(ROOT, f))) addWatcher(path.join(ROOT, f));
  }

  log('Observador de archivos activo.');
  log('  Zonas vigiladas: ' + WATCH_DIRS.join(', ') + ', ' + WATCH_FILES.join(', '));
  if (deployEnabled) {
    log('  Modo despliegue activado: se publicará en Wasmer Edge en cada cambio.');
  } else {
    log('  Sin despliegue automático (usa `node watch.js --deploy` para publicar en Edge).');
  }

  if (build()) startServer();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();