# Publicar en Google Play Store

## Requisitos previos
- **Cuenta de desarrollador de Google Play**: crear en https://play.google.com/console
  (pago único, ~25 USD). La crea el titular del negocio (no se puede automatizar).
- **Backend desplegado con HTTPS** (ver `docs/DEPLOY-BACKEND.md`).
- **JDK 17+** y **Android Studio** (o solo el Android SDK + `platforms;android-xx`).
  En este equipo hay Java 23 pero falta el Android SDK: instala Android Studio en
  https://developer.android.com/studio.

---

## 1) Preparar el frontend nativo

```bash
# 1. Apunta la app a tu backend real (¡importante!)
OSTEOMUR_API_URL=https://TU-DOMINIO.com/api node scripts/build-mobile-web.mjs

# 2. Regenera las plataformas nativas
cd mobile
npx cap sync
```

## 2) Identificador (package name)

Ya está fijado en `mobile/capacitor.config.json` → `appId: "com.osteomur.app"`.
Si en la Play Console ese nombre está ocupado por otra app, cámbialo **antes** de
generar el APK/AAB (también se usa en iOS, pero es independiente por tienda):

```jsonc
// mobile/capacitor.config.json
{ "appId": "com.tugimnasio.osteomur", "appName": "OSTEOMUR" }
npx cap sync
```

## 3) Firma de la release (keystore)

Crea tu clave con **keytool** (viene con el JDK). Guárdala en un sitio seguro y NO
la pierdas: no podrás actualizar la app sin ella.

```bash
keytool -genkey -v -keystore osteomur-release.jks -alias osteomur \
  -keyalg RSA -keysize 2048 -validity 10000
```

Configúrala en `mobile/android/app/build.gradle` (dentro de `android { }`):

```gradle
signingConfigs {
    release {
        storeFile file("ruta/AL/osteomur-release.jks")
        storePassword "TU-CLAVE"
        keyAlias "osteomur"
        keyPassword "TU-CLAVE"
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

> Opción alternativa recomendada: **Play App Signing** (Google gestiona la clave de
> firma y tú solo subes la clave de subida). Si la usas, la configuración de
> `build.gradle` no es necesaria: Play la pide al primer subir el AAB.

## 4) Generar el AAB

Abre `mobile/android` en **Android Studio** y elige **Build → Generate Signed
Bundle / APK → Android App Bundle**, o por consola:

```bash
cd mobile/android
.\gradlew.bat bundleRelease
# Resultado: mobile/android/app/build/outputs/bundle/release/app-release.aab
```

## 5) Subir a Play Console

1. **Play Console** → **Create app** (nombre, idioma, app de tipo app, gratis).
2. **Test track** cuando quieras probar en listas cerradas, o ve directo a
   **Production → Create new release**.
3. Sube el `app-release.aab` y rellena las **release notes** (mín. 1 línea).

## 6) Ficha de producto (listing)

Traducciones: **Español (España) y cualquier otro idioma que uses**.

- **Nombre:** OSTEOMUR
- **Descripción corta** (≤80 car.): `Entrena, reserva y mide tu progreso con tu entrenador personal.`
- **Descripción completa** (≤4000 car.): plantilla:

```
OSTEOMUR es la app de tu centro de entrenamiento personal.

Reserva tus sesiones según disponibilidad y gestiona tus créditos: cada sesión consume un crédito de tu bono con un solo toque.

Sigue tus planes de entrenamiento, consulta la técnica de cada ejercicio con claves y vídeos, y registra tu bienestar diario (fatiga, sueño, dolor, estrés) para que tu entrenador ajuste tu preparación.

Mide tu progreso: peso corporal, % de grasa y masa muscular. Recibe informes de valoración física con radar de capacidades y evolución.

Notificaciones: recordatorios de tus clases y avisos cuando tus créditos están a punto de caducar.

El entrenador gestiona la asistencia del día, la plantilla semanal, los bonos, las valoraciones y los informes desde su panel.

Para usar la app necesitas una cuenta creada por tu centro.
```

- **Categoría:** Salud y bienestar.
- **Gráficos:** portada 512×512, icono 512×512, **capturas de pantalla** de teléfono
  (mín. 2, recomendado 8). Genera capturas de la app en un emulador (Android Studio,
  6.7" o similar) y sube las de cada vista: Sesiones, Ejercicios, Wellness, Progreso
  y la vista del entrenador.
- **Clasificación de contenido:** realiza el cuestionario (juego real, contenido de
  salud informativo, sin violencia. Resultado típico: para todas las edades con
  mención a salud).

## 7) Formulario de Datos (Data safety) — OBLIGATORIO

Declara lo que realmente hace la app (importante por los datos de salud):

- **Datos recopilados:** información personal (nombre, email, teléfono), estado de
  salud y forma física, actividad física.
- **Finalidades:** funcionalidad de la app, comunicaciones con el usuario.
- **Cifrado en tránsito:** sí (HTTPS).
- **¿Permite eliminar los datos?:** sí, mediante el derecho de supresión (contáctanos).
- Enlaza la URL de tu **política de privacidad** (docs/POLITICA-PRIVACIDAD.md).

## 8) Revisión y publicación

- **App access:** si el login es tras alta por el centro, marca "Todas las funciones
  requieren acceso" y facilita una cuenta demo (cliente + entrenador) en el formulario.
- Envía a revisión. La primera revisión suele tardar de unas horas a unos días.

## Versiones futuras
- Incrementa `versionCode` (en `build.gradle`, también se puede en Play Console) y
  `versionName`.
- Repite el paso 1 y 4 (con la nueva URL si cambia el backend), sube el nuevo AAB.