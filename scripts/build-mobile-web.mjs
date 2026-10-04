'use strict';

/*
  Construye la carpeta mobile/web (webDir de Capacitor):

  1. Copia todo public/ (frontend web) a mobile/web/.
  2. Sobrescribe mobile/web/js/app-config.js con la URL pública del backend.

  Uso:
    node scripts/build-mobile-web.mjs
    OSTEOMUR_API_URL=https://api.mi-gimnasio.com/api node scripts/build-mobile-web.mjs
*/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const DST = path.join(ROOT, 'mobile', 'web');

const API_URL = process.env.OSTEOMUR_API_URL || 'https://TU-API-PROD.ejemplo.com/api';

// 1) Copiar el frontend
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
fs.cpSync(SRC, DST, { recursive: true, filter: (src) => !src.endsWith('.map') });

// 2) Inyectar la URL del backend para la app nativa
const config = [
  "'use strict';",
  '',
  '/* Generado por scripts/build-mobile-web.mjs. No editar (se sobrescribe). */',
  `window.APP_CONFIG = Object.freeze({ apiBaseUrl: '${API_URL}' });`,
  '',
].join('\n');

fs.writeFileSync(path.join(DST, 'js', 'app-config.js'), config);

// 3) Fingerprint anti-cache: añade ?v=<timestamp> a los assets en los HTML
//    copiados para que una instalación/actualización de la app nunca sirva
//    versiones viejas de JS/CSS cacheadas por el WebView.
const VERSION = Date.now().toString(36);
for (const page of fs.readdirSync(DST).filter((f) => f.endsWith('.html'))) {
  const file = path.join(DST, page);
  const html = fs.readFileSync(file, 'utf8');
  const next = html.replace(/(<script[^>]*\ssrc="[^"]+")(>)/g, `$1?v=${VERSION}$2`)
    .replace(/(<link[^>]*\shref="[^"]+\.css")(>)/g, `$1?v=${VERSION}$2`);
  if (next !== html) fs.writeFileSync(file, next);
}

console.log(`Frontend copiado a mobile/web (${fs.readdirSync(DST).length} entradas).`);
console.log(`Versión assets: v${VERSION}`);
console.log(`apiBaseUrl inyectado: ${API_URL}`);
console.log('Para cambiar la URL del backend: OSTEOMUR_API_URL=https://... node scripts/build-mobile-web.mjs');