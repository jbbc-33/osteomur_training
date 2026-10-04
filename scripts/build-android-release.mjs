#!/usr/bin/env node
/**
 * Compila el bundle de release (.aab) listo para subir a Google Play.
 *
 * Encadena los pasos en el orden correcto, que es lo que suele fallar cuando se
 * hacen a mano: regenerar la web con la URL de produccion, sincronizar los
 * assets a Android y despues compilar firmado.
 *
 * Uso:  npm run android:bundle
 * Falla pronto y con un mensaje claro si falta la clave de firma, porque un
 * bundle sin firmar lo rechaza Play y no tiene arreglo despues.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE = path.join(RAIZ, 'mobile');
const ANDROID = path.join(MOBILE, 'android');
const PROPS = path.join(ANDROID, 'keystore.properties');
const AAB = path.join(ANDROID, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const GRADLE = path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const paso = (n, t) => console.log(`\n[${n}/4] ${t}`);

// Node 24 (desde el endurecimiento de CVE-2024-27980) se niega a lanzar .cmd y
// .bat sin shell, asi que en Windows ambos lanzadores necesitan esa via. Se usa
// execSync con la linea ya entrecomillada en lugar de execFileSync+shell, que
// avisa de deprecacion por no escapar los argumentos.
const ejecutar = (cmd, args, cwd) => {
  const cite = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
  const linea = [cmd, ...args].map(cite).join(' ');
  console.log(`      $ ${linea}`);
  if (/\.(cmd|bat)$/i.test(cmd)) execSync(linea, { cwd, stdio: 'inherit' });
  else execFileSync(cmd, args, { cwd, stdio: 'inherit' });
};

// ------------------------------------------------ 0. la clave de firma existe
if (!fs.existsSync(PROPS)) {
  console.error('\nNo existe mobile/android/keystore.properties, asi que el bundle');
  console.error('saldria SIN FIRMAR y Play lo rechazaria.\n');
  console.error('Genera la clave de firma con:\n');
  console.error('    npm run android:keystore\n');
  console.error('Guarda la clave a buen recaudo: sin ella no se puede publicar nunca');
  console.error('una actualizacion de esta app.\n');
  process.exit(1);}

// ------------------------------------------------------------- 1. web + config
paso(1, 'Generando la web movil con la URL del backend');
if (!process.env.OSTEOMUR_API_URL) {
  console.warn('      AVISO: OSTEOMUR_API_URL no esta definido.');
  console.warn('      Se usara el valor por defecto de scripts/build-mobile-web.mjs.');
  console.warn('      Para produccion:  OSTEOMUR_API_URL=https://tu-dominio/api npm run android:bundle\n');
}
ejecutar(process.execPath, [path.join(RAIZ, 'scripts', 'build-mobile-web.mjs')], RAIZ);

// ------------------------------------------------------------ 2. cap sync
paso(2, 'Sincronizando assets y configuracion en Android');
ejecutar(NPX, ['cap', 'sync', 'android'], MOBILE);

// ------------------------------------------------------------ 3. gradle
paso(3, 'Compilando el bundle de release firmado');
ejecutar(GRADLE, ['bundleRelease', '--no-daemon'], ANDROID);

// ------------------------------------------------------------ 4. comprobar
paso(4, 'Comprobando el resultado');
if (!fs.existsSync(AAB)) {
  console.error('\nGradle dijo que OK pero no encuentro el bundle en:\n  ' + AAB + '\n');
  process.exit(1);
}
const mb = (fs.statSync(AAB).size / 1024 / 1024).toFixed(2);

// Comprobar que la firma es real y no un build sin firmar.
let firmado = 'SIN VERIFICAR';
try {
  const props = Object.fromEntries(
    fs.readFileSync(PROPS, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  // En un .properties la barra invertida es un caracter de escape, asi que la
  // ruta se guardo con barras dobles. Hay que deshacerlas o jarsigner receberia
  // una ruta con "C:\\Users\\..." que no existe.
  for (const k of Object.keys(props)) props[k] = props[k].replace(/\\\\/g, '\\');
  const jdk = process.env.JAVA_HOME || path.join(process.env.ProgramFiles || '', 'Java');
  const jarsigner = path.join(jdk, 'bin', 'jarsigner.exe');
  if (fs.existsSync(jarsigner)) {
    execFileSync(jarsigner, ['-verify', '-keystore', props.storeFile, '-storepass', props.storePassword, AAB],
      { stdio: 'pipe' });
    firmado = 'FIRMADO (verificado)';
  }
} catch { firmado = 'FALLO LA VERIFICACION'; }

console.log(`\n      Bundle : ${AAB}`);
console.log(`      Tamano : ${mb} MB`);
console.log(`      Firma  : ${firmado}`);
console.log(`      Subible: ${AAB}\n`);

if (firmado !== 'FIRMADO (verificado)') {
  console.error('El bundle no supera la verificacion de firma. NO lo subas a Play.\n');
  process.exit(1);
}

console.log('Recuerda: antes de resubir, sube versionCode en');
console.log('  mobile/android/app/build.gradle  (Play rechaza repetir un versionCode).\n');
