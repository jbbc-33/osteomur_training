# Desplegar el backend (requisito para la app móvil)

La app nativa (iOS/Android) NO lleva el backend dentro: habla con tu servidor por
HTTPS. Para que la app funcione en las tiendas necesitas **alojar el servidor
Express + SQLite** en un sitio con **URL pública y HTTPS**.

> La app móvil se la URL del API desde `mobile/web/js/app-config.js`, que se genera
> con:
>
> ```bash
> OSTEOMUR_API_URL=https://TU-DOMINIO.com/api node scripts/build-mobile-web.mjs
> cd mobile && npx cap sync
> ```
>
> La URL debe incluir el sufijo `/api`.

---

## Opciones de hosting

### 1. Render (más fácil, gratis para empezar)
1. Crea una cuenta en https://render.com.
2. **New → Web Service**, conecta tu repo de GitHub (o "From source").
3. Configuración:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Runtime: **Node 24** (necesita `node:sqlite` integrado, Node ≥ 23.4).
   - **Disk**: añade un disco persistente montado en `/data` (la BD SQLite vive ahí).
4. Variables de entorno: `PORT=3000` (Render lo inyecta), `OSTEOMUR_API_URL`.
5. **HTTPS** te lo da Render automáticamente en `https://tu-app.onrender.com`.

### 2. Railway (recomendado: el repo ya trae `railway.json`)

**Paso 1 — Publicar el código en GitHub.** El repo es local y todavía no tiene
remoto:

```bash
git remote add origin https://github.com/TU-USUARIO/osteomur.git
git push -u origin main
```

**Paso 2 — Crear el servicio.** En https://railway.com → *New Project* →
*Deploy from GitHub Repo* → elige el repo. Railway lee `railway.json`, que ya fija:

| Campo | Valor | Por qué |
|---|---|---|
| `build.command` | `npm ci` | Instalación reproducible desde el lockfile |
| `start.command` | `node server.js` | Arranque directo, sin wrapper |
| `healthcheckPath` | `/api/health` | Railway enruta tráfico solo cuando responde |
| `numReplicas` | `1` | SQLite no admite dos procesos sobre el mismo volumen |
| `restartPolicy` | `ON_FAILURE`, 3 intentos | Reinicio ante fallo, no ante salida limpia |
| `drainingSeconds` | `10` | Margen para el cierre ordenado |
| `requiredMountPath` | `/data` | **Falla el deploy si falta el volumen**, en vez de perder la BD |

**Paso 3 — Fijar Node 24.** En *Variables* del servicio: `NODE_VERSION=24`.
Obligatorio: el proyecto usa `node:sqlite`, que necesita Node ≥ 23.4.

**Paso 4 — Crear el volumen, ANTES del primer deploy.** En el servicio →
*Volumes* → *Add Volume*, con mount path `/data`. Crea primero el volumen y luego
despliega: si el volumen se crea después, el primer arranque escribe la BD en la
capa efímera y se pierde al reiniciar.

**Paso 5 — Variables de entorno.**

| Variable | Valor | Notas |
|---|---|---|
| `DATA_DIR` | `/data` | Raíz de la BD, el secreto JWT y las claves VAPID |
| `NODE_VERSION` | `24` | Railway la usa para elegir la imagen |
| `PORT` | *no la fijes* | Railway la inyecta; el servidor ya lee `process.env.PORT` y escucha en `0.0.0.0` |

**Paso 6 — Seed inicial (una sola vez).** `db/seed.js` es **destructivo**: borra 23
tablas, incluidos los usuarios. Solo sobre una BD vacía. Con el servicio ya
desplegado y el volumen montado, desde el terminal del servicio en el dashboard o
con la CLI conectada al proyecto:

```bash
npm run seed
```

Nunca lo añadas al build ni al start command: un redeploy no debe ejecutarlo.

**Paso 7 — HTTPS.** Railway asigna `https://TU-SERVICIO.up.railway.app`
automáticamente. Anota ese dominio: es la `OSTEOMUR_API_URL` del paso siguiente.

**Paso 8 — Apuntar la app nativa al dominio.**

```bash
OSTEOMUR_API_URL=https://TU-SERVICIO.up.railway.app/api node scripts/build-mobile-web.mjs
cd mobile
npx cap sync android
cd android && gradlew.bat assembleDebug
```

APK resultante: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
Para iOS, `npx cap sync ios` y compilar desde Xcode (hace falta macOS).

### 2.b. Fly.io
Igual que Render: desplegar el repo, runtime Node 24 y **volumen persistente**.
No se ha probado con la configuración de este repo.

### 3. VPS (mayor control)
- Ubuntu 22.04/24.04 + Node 24 (mediante `nvm install 24`).
- Copiar el proyecto (sin `node_modules`, `npm install --production`).
- Ejecutar como servicio con **systemd**:

```ini
# /etc/systemd/system/osteomur.service
[Unit]
Description=OSTEOMUR API
After=network.target

[Service]
WorkingDirectory=/opt/osteomur
ExecStart=/usr/bin/env node server.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

- HTTPS con **Caddy** (certificado automático):

```
tu-dominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

---

## Cosas importantes

- **BD persistente**: los cambios en SQLite no duran si el contenedor se recrea sin
  volumen. Monta siempre un volumen y apunta `DATA_DIR` a él.
- **Todo el estado persistente cuelga de `DATA_DIR`** (`config/paths.js`):
  - `training.db` y sus ficheros `-wal` / `-shm`
  - `jwt-secret` (si se pierde, se invalidan todos los tokens y hay que volver a
    iniciar sesión)
  - `vapid.json` (si se pierde, las suscripciones push dejan de valer)
- **Cierre ordenado**: `server.js` atiende `SIGTERM`/`SIGINT`, deja de aceptar
  conexiones, ejecuta `db.close()` y sale con código 0 (con 5 s de tope). Railway
  avisa con `SIGTERM` antes de cada reinicio. Sin esto, un corte a mitad de una
  escritura deja el WAL sin consolidar y el siguiente arranque se queda esperando
  un lock que nadie va a liberar.
- **Una sola réplica.** SQLite es un fichero, no un servicio: dos contenedores
  escribiendo a la vez sobre el mismo volumen corrompen la BD. Para escalar hay que
  migrar a Postgres.
- **Backups**: detén el servidor (o usa `sqlite3 .backup`) y copia la BD a un
  almacenamiento seguro con frecuencia. Railway permite descargar el contenido del
  volumen desde el dashboard del servicio.
- **CORS**: ya está configurado en `server.js` (refleja el `Origin` y acepta
  `Authorization`). No hay cookies: la autenticación es Bearer token.
- **Web Push (web)**: para que funcione en la web de producción, el frontend y el
  backend deben servirse desde el mismo origen HTTPS (ya ocurre si sirves `public/`
  desde el propio Express). No es necesario para la app nativa.

---

## Probar localmente la app nativa contra un backend local

Para desarrollo, puedes apuntar la app a tu PC (mismo Wi-Fi):

```bash
OSTEOMUR_API_URL=http://IP-DE-TU-PC:3000/api node scripts/build-mobile-web.mjs
cd mobile && npx cap sync
```

Si el backend usara HTTP (no HTTPS), en Android tendrías que permitir tráfico claro
(`android:usesCleartextTraffic="true"` en `AndroidManifest.xml`) y en iOS
configurar ATS. **Solo para desarrollo**: nunca lo publiques así en las tiendas, que
exigen HTTPS.

---

## Ejecutar los tests sin tocar tu BD de desarrollo

`npm test` (`test-api.js`) crea usuarios, reservas, valoraciones y notificaciones:
es un smoke test **destructivo y no idempotente** (la segunda vez falla porque
`nuevo@demo.com` ya existe). Aísla siempre la BD con `DATA_DIR`:

```bash
# Linux / macOS
DATA_DIR=/tmp/osteomur-test npm run seed && DATA_DIR=/tmp/osteomur-test npm test
```

```powershell
# Windows PowerShell
$env:DATA_DIR = "$env:TEMP\osteomur-test"
npm run seed
npm test
Remove-Item Env:DATA_DIR
```

Estado actual: `npm run test:informe` pasa entero. `npm test` da **108 OK / 13
ERROR**, y esos 13 fallos son **preexistentes** (no los introdujo el soporte de
`DATA_DIR`): esperando 409 y recibiendo 400 en cancelaciones y aforo, y campos de
scoring/VBT/radar sin valor. Requieren una BD recién sembrada para ser
comparables.