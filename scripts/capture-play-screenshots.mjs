#!/usr/bin/env node
/**
 * Captura las capturas de pantalla para la ficha de Google Play.
 *
 * No se usa `adb exec-out screencap` a proposito: eso captura la pantalla
 * completa del dispositivo (1080x2424, proporcion 19.5:9) con barras de sistema,
 * y Play solo acepta 16:9 o 9:16. Con el protocolo DevTools se captura solo el
 * contenido del WebView y con un recorte exacto de 9:16, sin recortes ni
 * barras de sistema.
 *
 * El recorte sale del viewport CSS dividido por la densidad real del dispositivo,
 * de modo que el resultado es siempre 1080x1920 sea cual sea la densidad.
 *
 * Uso:  node scripts/capture-play-screenshots.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = path.join(RAIZ, 'play-store', 'screenshots');
const ADB = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Android', 'Sdk', 'platform-tools', 'adb.exe',
);
const PAQUETE = 'com.osteomur.app';
const PUERTO = 9222;

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim();

// ------------------------------------------------------ dimensiones del emulador
const phys = adb('shell', 'wm', 'size');                    // "Physical size: 1080x2424"
const dens = adb('shell', 'wm', 'density');                 // "Physical density: 420"
const mpx = /(\d+)x(\d+)/.exec(phys);
const mdp = /(\d+)/.exec(dens);
if (!mpx || !mdp) throw new Error('no puedo leer el tamaño/densidad del emulador');
const dpr = Number(mdp[1]) / 160;                           // device pixel ratio
const cssW = Number(mpx[1]) / dpr;
const cssH = Number(mpx[2]) / dpr;
const scale = Number(mpx[1]) / cssW;                        // vuelve a 1080 px de ancho
// Alto del recorte como float, no redondeado: 1920/scale da exactamente 1920 px
// de alto. Si se redondea a entero, el resultado sale en 1919 y la relación
// dejan de ser 9:16 exacta, que es justo lo que Play comprueba.
const ALTO = (Number(mpx[1]) * 16) / 9 / scale;
console.log(`Emulador ${mpx[1]}x${mpx[2]} @ ${mdp[1]}dpi -> viewport ${cssW.toFixed(1)}x${cssH.toFixed(1)} CSS`);
console.log(`Recorte ${cssW.toFixed(2)}x${ALTO.toFixed(2)} CSS x${scale.toFixed(4)} -> ${Math.round(cssW * scale)}x${Math.round(ALTO * scale)} px\n`);

fs.mkdirSync(SALIDA, { recursive: true });

// ------------------------------------------------------------- conectar con CDP
const pid = adb('shell', 'pidof', PAQUETE);
if (!pid) throw new Error(`la app ${PAQUETE} no esta en marcha`);
adb('forward', `tcp:${PUERTO}`, `localabstract:webview_devtools_remote_${pid}`);

const targets = await (await fetch(`http://127.0.0.1:${PUERTO}/json/list`)).json();
const page = targets.find((t) => t.webSocketDebuggerUrl);
if (!page) throw new Error('el WebView no expone webSocketDebuggerUrl');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let idSeq = 0;
const pendientes = new Map();
const eventos = new Map();

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pendientes.has(m.id)) {
    const { res, rej } = pendientes.get(m.id);
    pendientes.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  } else if (m.method && eventos.has(m.method)) {
    for (const cb of eventos.get(m.method)) cb(m.params);
  }
});

const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++idSeq;
  pendientes.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

const esperarEvento = (method, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout esperando ' + method)), ms);
  const cb = () => { clearTimeout(t); res(); };
  if (!eventos.has(method)) eventos.set(method, []);
  eventos.get(method).push(cb);
});

const esperarIdle = (ms = 1400) => new Promise((r) => setTimeout(r, ms));

const evaluar = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS fallo: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

const navegar = async (url) => {
  const carga = esperarEvento('Page.loadEventFired').catch(() => {});
  await send('Page.navigate', { url });
  await carga;
  await esperarIdle();
};

const capturar = async (nombre) => {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: cssW, height: ALTO, scale },
  });
  const destino = path.join(SALIDA, nombre + '.png');
  fs.writeFileSync(destino, Buffer.from(r.data, 'base64'));
  const kb = (fs.statSync(destino).size / 1024).toFixed(0);
  console.log(`  ${nombre}.png  ${kb} KB`);
};

// --------------------------------------------------------------- autenticacion
const BASE = 'https://osteomurtraining-production.up.railway.app/api';

const iniciarSesion = (email) => `
  fetch('${BASE}/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(email)}, password: 'demo1234' })
  }).then(r => r.json()).then(j => {
    if (!j.token) throw new Error('login fallo: ' + JSON.stringify(j));
    localStorage.setItem('pp_token', j.token);
    localStorage.setItem('pp_user', JSON.stringify(j.user));
    return j.user.role + ' ' + j.user.email;
  })`;

// --------------------------------------------------------------------- guiones
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');

console.log('Capturando:');

const hechos = [];

// 1) Login, sin sesion.
await evaluar(`localStorage.clear()`);
await navegar('https://localhost/client.html');
await capturar('01-login');
hechos.push('01-login');

// 2) Panel del cliente con datos reales (Carlos tiene plan, nutricion y bienestar).
const rol = await evaluar(iniciarSesion('carlos@demo.com'));
console.log(`  (sesion: ${rol})`);
await navegar('https://localhost/client.html');
await capturar('02-panel-cliente');
hechos.push('02-panel-cliente');

// 3) Seccion de entrenamiento del cliente, si existe la pestana.
const hayEntreno = await evaluar(`
  (() => {
    const b = [...document.querySelectorAll('button,a,[role=tab],.tab,.nav-item')]
      .find(e => /entrenamiento/i.test(e.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  })()`);
if (hayEntreno) { await esperarIdle(1600); await capturar('03-entrenamiento'); hechos.push('03-entrenamiento'); }
else console.log('  (no hay pestana de entrenamiento: se omite 03)');

// 4) Panel del entrenador.
await evaluar(iniciarSesion('entrenador@osteomur.es'));
await navegar('https://localhost/trainer.html');
await capturar('04-panel-entrenador');
hechos.push('04-panel-entrenador');

console.log('\nCapturas en play-store/screenshots: ' + hechos.length);
hechos.forEach((h) => console.log('  ' + h));

adb('forward', '--remove', `tcp:${PUERTO}`);
ws.close();
process.exit(0);
