#!/usr/bin/env node
/**
 * Genera la clave de firma de release para Google Play.
 *
 * Por que este script y no hacerlo a mano:
 *   - La clave se crea FUERA del repositorio (en ~/.android), asi que no hay
 *     ninguna posibilidad de acabarla subiendola a git por error.
 *   - Las contrasenas se generan al azar y en mayusculas/minusculas/numeros
 *     para que no haya que escaparlas ni en el .properties ni en keytool.
 *   - La validez es de 10000 dias (~27 anos). Play exige que la clave siga
 *     valida hasta al menos el 22 de octubre de 2033.
 *
 * IMPORTANTE: la clave es el activo mas critico del proyecto. Si se pierde, no
 * hay forma de publicar ninguna actualizacion de la app. Copiala en un sitio
 * seguro (y con copia de seguridad) en cuanto se genere.
 *
 * Uso:  node scripts/gen-release-keystore.mjs [--force]
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(RAIZ, 'mobile', 'android');
const PROPS_PATH = path.join(ANDROID_DIR, 'keystore.properties');

const ALIAS = 'osteomur';
const VALIDEZ_DIAS = 10000;
const DN = 'CN=OSTEOMUR Training, OU=App Movil, O=OSTEOMUR, L=Valencia, ST=Valencia, C=ES';

// Sin : ni = ni espacios, para que el .properties nunca necesite escapes.
const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const contrasena = (n) => {
  const b = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += alfabeto[b[i] % alfabeto.length];
  return out;
};

function die(msg) {
  console.error('\nERROR: ' + msg + '\n');
  process.exit(1);
}

function buscarKeytool() {
  const candidatos = [];
  if (process.env.KEYTOOL) candidatos.push(process.env.KEYTOOL);
  if (process.env.JAVA_HOME) candidatos.push(path.join(process.env.JAVA_HOME, 'bin', 'keytool.exe'));
  candidatos.push(path.join(ANDROID_DIR, '..', '..', 'jbr', 'bin', 'keytool.exe'));
  // Android Studio en sus rutas habituales de instalacion.
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!base) continue;
    candidatos.push(path.join(base, 'Android', 'Android Studio', 'jbr', 'bin', 'keytool.exe'));
  }
  candidatos.push('keytool');

  for (const c of candidatos) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      if (c === 'keytool') {
        execFileSync(cmd, [c], { stdio: 'ignore' });
        return c;
      }
      const base = c.endsWith('keytool.exe') ? path.dirname(c) : c;
      execFileSync(process.platform === 'win32' ? 'where' : 'which',
        ['keytool'], { cwd: base, stdio: 'ignore' });
      if (fs.existsSync(c)) return c;
    } catch { /* siguiente candidato */ }
  }
  return null;
}

const force = process.argv.includes('--force');
const keystoreDir = path.join(os.homedir(), '.android');
const keystorePath = path.join(keystoreDir, 'osteomur-release.jks');

if (fs.existsSync(keystorePath) && !force) {
  console.log('\nLa clave ya existe:\n  ' + keystorePath);
  console.log('\nNO se regenera: si cambias la clave tendras dos apps distintas en');
  console.log('Play y no podras publicar actualizaciones de la ya subida.');
  console.log('\nSi la has perdido, recuperala de tu copia de seguridad. Solo si estas');
  console.log('seguro de que es una app nueva sin publicar, usa --force.\n');
  process.exit(0);
}

const keytool = buscarKeytool();
if (!keytool) {
  die('no encuentro keytool. Instala un JDK o Android Studio, o define KEYTOOL\n' +
      '  con la ruta completa a keytool.exe.');
}

const storePassword = contrasena(32);
// PKCS12 no admite contrasena de clave distinta de la del almacen: Java ignora
// -keypass y usa storepass. Asi que aquí van necesariamente iguales. Si se
// separaran, Gradle firmaria con una contrasena que no existe y el fallo aparece
// al compilar el bundle, no al generar la clave.
const keyPassword = storePassword;

fs.mkdirSync(keystoreDir, { recursive: true });

console.log('\nGenerando clave de firma de release...');
console.log('  keytool : ' + keytool);
console.log('  destino : ' + keystorePath);
console.log('  alias   : ' + ALIAS);
console.log('  validez : ' + VALIDEZ_DIAS + ' dias (~27 anos)\n');

try {
  execFileSync(keytool, [
    '-genkeypair',
    '-alias', ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '4096',
    '-sigalg', 'SHA256withRSA',
    '-validity', String(VALIDEZ_DIAS),
    '-dname', DN,
    '-keystore', keystorePath,
    '-storetype', 'PKCS12',
    '-storepass', storePassword,
    '-keypass', keyPassword,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (e) {
  die('keytool fallo:\n' + (e.stderr ? e.stderr.toString() : e.message));
}

const props = [
  '# Generado por scripts/gen-release-keystore.mjs',
  '# NO SUBIR A GIT: contiene las contrasenas de la clave de firma.',
  '# keystore.properties y la clave estan en .gitignore.',
  '#',
  '# El almacen es PKCS12, que no admite contrasena de clave distinta de la del',
  '# almacen, por eso storePassword y keyPassword coinciden.',
  '',
  'storeFile=' + keystorePath.replace(/\\/g, '\\\\'),
  'storePassword=' + storePassword,
  'keyAlias=' + ALIAS,
  'keyPassword=' + keyPassword,
  '',
].join('\n');

fs.writeFileSync(PROPS_PATH, props, { encoding: 'utf8' });

console.log('Clave creada correctamente.\n');
console.log('  ' + keystorePath);
console.log('  ' + PROPS_PATH + '\n');
console.log('  Alias     : ' + ALIAS);
console.log('  Contrasena: ' + storePassword);
console.log('  (alias y contrasena de la clave son el mismo valor)\n');
console.log('='.repeat(70));
console.log('GUARDA ESTOS DATOS EN UN SITIO SEGURO AHORA MISMO:');
console.log('  clave     : ' + keystorePath);
console.log('  contrasena: ' + storePassword);
console.log('='.repeat(70));
console.log('\nSi pierdes la clave no podras publicar mas actualizaciones:');
console.log('Play rechaza cualquier bundle firmado con una clave distinta.\n');
console.log('Siguiente paso:  npm run android:bundle\n');
