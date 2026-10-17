# Publicar OSTEOMUR Training en Google Play

Guía completa para subir la app. El código ya está preparado y verificado; lo que
queda son pasos en la consola de Google y tres datos legales que solo tienes tú.

---

## 1. Qué hay listo

| Elemento | Estado |
|---|---|
| Bundle firmado `.aab` | `mobile/android/app/build/outputs/bundle/release/app-release.aab` (5,28 MB) |
| Firma | SHA256withRSA 4096 bits, verificada (`jar verified`) |
| `applicationId` | `es.osteomur.training` |
| `versionCode` / `versionName` | `1` / `1.0.0` |
| `targetSdkVersion` | **36** — cumple el requisito vigente desde el 31/08/2026 |
| `minSdkVersion` | 24 (Android 7.0) |
| Permisos | Solo `INTERNET` |
| Tráfico en claro | Desactivado (`usesCleartextTraffic=false`) |
| Copia de seguridad | Desactivada (`allowBackup=false`, protege datos de salud) |
| Minificación (R8) | Desactivada a propósito |
| URL del backend | `https://osteomurtraining-production.up.railway.app/api` embebida |
| Política de privacidad | `public/privacidad.html` |
| Borrado de cuenta | `public/borrar-cuenta.html` |
| Gráfico de la ficha | `play-store/feature-graphic-1024x500.png` |
| Icono de la ficha | `play-store/icon-512.png` (32 bits con alfa) |
| Capturas | `play-store/screenshots/` (3 × 1080×1920) |

Comandos:

```bash
npm run android:bundle      # regenera web, sincroniza y compila el .aab firmado
npm run play:assets         # regenera icono y gráfico de la ficha
npm run play:screenshots    # regenera las capturas desde el emulador
npm run android:keystore    # SOLO la primera vez (ver sección 2)
```

---

## 2. Antes de nada: la clave de firma

La clave de firma ya está creada:

- Clave: `C:\Users\jball\.android\osteomur-release.jks` (**fuera del repositorio**)
- Contraseña y alias: en `mobile/android/keystore.properties` (**ignorado por git**)
- Alias: `osteomur` · Validez: hasta **2054**
- `keystore.properties` y `*.jks` están en `.gitignore`

> **Copia de seguridad ahora.** Si pierdes la clave no podrás publicar ninguna
> actualizacion de esta app. Play rechaza cualquier bundle firmado con una clave
> distinta de la del primer lanzamiento. Guárdala en un sitio seguro (y con copia
> de seguridad) junto con la contraseña.

`npm run android:bundle` falla con un mensaje claro si la clave no está, en lugar
de generar un bundle sin firmar que Play rechazaría.

---

## 3. Tres datos legales que tienes que rellenar

La app trata **datos personales y de salud**, así que Google y el RGPD obligan a
identificar al responsable del tratamiento. Son datos que no puedo inventar.

| Fichero | Buscar y sustituir |
|---|---|
| `public/privacidad.html` | `[TU RAZON SOCIAL]`, `[TU NIF O CIF]`, `[TU EMAIL DE CONTACTO]` |
| `public/borrar-cuenta.html` | `[TU EMAIL DE CONTACTO]` |

En ambos ficheros hay un bloque `.aviso`amarillo que debes **borrar** cuando
sustituyas los campos.

Después, comprueba que las URLs responden:

```
https://osteomurtraining-production.up.railway.app/privacidad.html
https://osteomurtraining-production.up.railway.app/borrar-cuenta.html
```

---

## 4. Cuenta de desarrollador (imprescindible leer)

- La cuenta de Google Play cuesta **25 USD, una sola vez**.
- **Cuentas personales creadas después del 13/11/2023 NO pueden publicar en
  producción directamente.** Antes necesitan:
  - una prueba **cerrada** (no interna) con **al menos 12 testers**
  - esos 12 deben estar suscritos **14 días consecutivos**
  - luego solicitar *Apply for production* y responder un cuestionario
  - la revisión de Google tarda **7 días o menos**, a veces más
- Cuentas de organización (con D-U-N-S) están exentas.
- El requisito es **por cuenta**, no por app: se cumple una vez.
- Recomendación: recluta 14-15 testers, no 12, para que una baja no reinicie el reloj.
- Mientras el test esté en marcha, responde a los testers y sube correcciones: Google
  penaliza los testers pasivos que instalan y no usan.

Cronograma realista: **unos 17-24 días** desde el primer upload hasta estar en producción.

---

## 5. Pasos en Play Console

### 5.1 Crear la app
1. Play Console → **Create app**.
2. Nombre: `OSTEOMUR Training`.
3. Idioma: español (España). Cualquiera de los dos campos está bien.
4. App o juego: **App**.
5. Declaraciones. Completa las de **Privacy policy**, **Ads** (no hay
   anuncios → "No") y **App access**.

### 5.2 Formularios obligatorios
- **Privacy policy**: `https://osteomurtraining-production.up.railway.app/privacidad.html`
- **Data safety**: ver la sección 6, está casi rellenado con lo que hace el código real.
- **Content rating**: cuestionario estándar. OSTEOMUR no tiene contenido violento,
   ni lenguaje inapropiado, ni contenido generado por usuarios ni contenido de
  (no hay chat ni contenido de usuarios). Lo normal es marcar «ninguno» en todo.
- **App category**: **Salud y bienestar** (o *Deportes*).
- **Target audience**: 18+ (la app gestiona datos de salud).
- **Ads**: no contiene anuncios.

### 5.3 Gravedad del contenido
La app gestiona datos de salud, pero **no los "recopila" de forma promocional ni
los comparte con terceros**, así que normalmente **no** se declara como app de
información sanitaria. Si tienes dudas, revisa el resultado final que muestre el
cuestionario antes de enviarlo.

### 5.4 Subir el bundle (primera vez: prueba cerrada)
1. **Testing → Closed testing** → crea un track, p. ej. `Pre-launch beta`.
2. **Testers** → nueva lista de correo → añade a los 12+ testers.
3. **VersionCode 1** → *Upload new bundle* → sube
   `mobile/android/app/build/outputs/bundle/release/app-release.aab`.
4. Añade notas de la versión y lanza el rollout.
5. Espera la revisión de Google (unas horas; hasta 3 días en cuentas nuevas).
6. Comparte el **enlace de suscripción** con los testers. Deben aceptar e instalar
   desde ahí; descargar el APK por otro lado no cuenta.
7. Confirma que la app instala y funciona en un dispositivo real.

### 5.5 Ficha de la tienda
En **Grow → Store presence → Main store listing** sube:

- **Icono**: `play-store/icon-512.png`
- **Gráfico de función**: `play-store/feature-graphic-1024x500.png`
- **Capturas**: las 3 de `play-store/screenshots/`

Textos listos para pegar (sección 7).

### 5.6 Solicitar acceso a producción
1. **Dashboard → Apply for production** cuando se cumplan los 12 testers / 14 días.
2. Responde con datos reales: cuántos testers, qué prueban, qué retroalimentación recibiste,
   qué errores encontraste y qué cambiaste. Respuestas concretas; el marketing no suma.
3. Google revisa (7 días o menos). No detengas el test cerrado mientras revisas.

### 5.7 Publicar en producción
1. **Release → Testing → Production → Create new release**.
2. Sube el **mismo** bundle con el mismo `versionCode` (no compiles otro, se
   rechazaría por código duplicado).
3. Añade notas de la versión → *Start rollout to Production* → *Send changes for review*.
4. Cada `versionCode` nuevo es una revisión más (unas horas; hasta 7 días si cambia
   la ficha o hay requisitos nuevos).

---

## 6. Declaraciones de «Data safety» según el código real

Estas respuestas se deducen del código, no de suposiciones:

| Pregunta | Respuesta |
|---|---|
| ¿Recoge datos de usuario? | **Sí** |
| ¿Los comparte con terceros? | **No** (no hay SDK de terceros ni de analítica) |
| Datos recogidos | **Información personal** (nombre, correo), **Salud y deporte** (cuestionarios, medidas, constantes), **Actividad de la app** (reservas, planes, informes) |
| ¿Cifrado en tránsito? | **Sí** (HTTPS/TLS) |
| ¿El usuario puede pedir que los borren? | **Sí** → `public/borrar-cuenta.html` |
| ¿Se recogen para publicidad? | No aplica: no hay publicidad |
| ¿Cuenta con acceso para el entrenador? | Solo el entrenador ve los datos de sus clientes, nunca un cliente los de otro |

---

## 7. Textos para la ficha

**Nombre de la app** (máx. 30):
```
OSTEOMUR Training
```

**Descripción breve** (máx. 80 caracteres):
```
Entrenamiento personal: valoración, reservas y seguimiento de tu progreso.
```

**Descripción completa** (máx. 4000):
```
OSTEOMUR Training es la aplicación de tu entrenador para que lleves todo tu
entrenamiento en el móvil: tus valoraciones, tus reservas de sesión y el
seguimiento de tu progreso, siempre actualizado y en un solo sitio.

QUÉ PUEDES HACER

· Ver tu próxima sesión reservada y gestionarla.
· Controlar tus créditos y bonos, y avisarte antes de que caduquen.
· Registrar tu bienestar diario en segundos.
· Consultar tu valoración inicial y tus measurements.
· Revisar tu plan de entrenamiento y tu historial de sesiones.
· Leer los informes de progreso que prepara tu entrenador.

PARA TU ENTRENADOR

· Panel completo de clientes con sus datos de salud y condición física.
· Crear y ajustar planes de entrenamiento personalizados.
· Gestionar reservas, asistencia, créditos y bonos de cada cliente.
· Generar informes de progreso por cliente y compararlos en el tiempo.

PENSADA PARA EL CUIDADO DE TUS DATOS

Todos los datos viajan cifrados por HTTPS, la copia de seguridad del
dispositivo está desactivada y tu cuenta se puede eliminar cuando quieras
desde la propia web. Puedes consultar la política de privacidad completa y
solicitar el borrado de tus datos en los enlaces de abajo.
```

---

## 8. Para la siguiente actualización

Antes de cada nueva subida **incrementa `versionCode`**:

`mobile/android/app/build.gradle` → `versionCode 2`, `versionName "1.1.0"`

Y vuelve a ejecutar:

```bash
OSTEOMUR_API_URL=https://osteomurtraining-production.up.railway.app/api npm run android:bundle
```

Reglas que Play impone:

- Cada `versionCode` debe ser **mayor** que todos los anteriores. Play **no
  permite** reutilizar uno, ni siquiera para un bundle que cambió.
- Los mensajes de las notas de versión son obligatorios.
- **No cambies `applicationId` a partir de ahora.** `es.osteomur.training` es el
  identificador con el que la app está registrada en Play Console y pasa a ser
  permanente: si lo cambias, Play ve una app distinta y no podrás publicar
  actualizaciones de la que ya está publicada.

> **Nota sobre el historial de este identificador.** La app quedó registrada en
> Play Console como `es.osteomur.training`, así que el proyecto se renombró de
> `com.osteomur.app` a `es.osteomur.training` **antes** de la primera publicación.
> Ese cambio afecta a cuatro sitios, y deben coincidir entre sí:
> `applicationId` y `namespace` en `mobile/android/app/build.gradle`, el `appId`
> de `mobile/capacitor.config.json`, el `package` y la ruta de
> `MainActivity.java`, y las strings `package_name` y `custom_url_scheme` de
> `strings.xml`. También quedó desalineado el bundle ID de iOS: ver
> `docs/PUBLICAR-APPLE-APP-STORE.md`.

---

## 9. Causas habituales de rechazo

- **Falta `targetSdk 36`.** Ya está cubierto; el requisito es Android 16 desde el
  31/08/2026 y sube cada año.
- **Falta la política de privacidad** en una URL accesible públicamente.
- **Falta la vía de borrado de cuenta.** Ya cubierta por `borrar-cuenta.html`;
  Play la exige desde que la app permite registrarse («Crear cuenta»).
- **La política dice datos que la app no declara**, o al revés. La de aquí está
  redactada contra lo que hace el código real.
- **Faltan capturas** (mínimo 2 en móvil) o no cumplen la proporción 16:9 / 9:16.
  Las de este repo son 1080×1920 exactos.
- **Declarar publicidad que no existe**, o SDK de terceros sin declarar. Aquí no hay ninguno.
- **No pasar la prueba cerrada** de 12 testers / 14 días.

---

## 10. Nota sobre iOS

El proyecto iOS (`mobile/ios`) existe pero mantiene la URL de ejemplo en
`mobile/ios/App/App/capacitor.config.json`. Configurarlo requiere un **Mac** con
Xcode y una cuenta de **Apple Developer** (99 USD/año), y Apple pide cabeceras HTTP
en `Info.plist` o un proxy HTTPS para la app. Está fuera del alcance de esta guía.
