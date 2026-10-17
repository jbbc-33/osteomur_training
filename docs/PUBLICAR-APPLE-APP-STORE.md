# Publicar en Apple App Store

## Requisitos previos
- **Un Mac con Xcode** (Apple obliga a compilar iOS desde macOS; en este equipo
  Windows se prepara todo el proyecto pero el build/Archive es en Mac).
- **Programa de desarrolladores de Apple**: registro en
  https://developer.apple.com/programs/ (99 USD/año). El titular debe crear su
  cuenta (no se puede automatizar).
- **Backend desplegado con HTTPS** (ver `docs/DEPLOY-BACKEND.md`).
- **Política de privacidad publicada en una URL** (docs/POLITICA-PRIVACIDAD.md).

---

## 1) Preparar la app en el Mac

```bash
git clone https://github.com/jbbc-33/osteomur_training.git
cd osteomur_training/mobile

npm install

# OBLIGATORIO: genera mobile/web con la URL real del backend
OSTEOMUR_API_URL=https://osteomurtraining-production.up.railway.app/api npm run web

npx cap sync ios
npx cap open ios
```

> ⚠ **No hay `Podfile`: no instales CocoaPods.** La mayoría de tutoriales de
> Capacitor te hicieron ejecutar `pod install`; en este proyecto es un error.
> Capacitor 8 usa **Swift Package Manager** (`mobile/ios/App/CapApp-SPM`), y Xcode
> resuelve los paquetes solo al abrir el proyecto. La primera resolución descarga
> `capacitor-swift-pm` y los plugins desde GitHub y puede tardar varios minutos.

> ⚠ **`npm run web` es obligatorio y `OSTEOMUR_API_URL` es obligatoria.**
> `mobile/web/` está en `.gitignore`, así que tras clonar el repositorio está
> **vacía**: si te saltas este paso abres un proyecto en blanco.
> Peor: si lanzas el script sin la variable, **no da error**. Inyecta el valor por
> defecto `https://TU-API-PROD.ejemplo.com/api` y publicas una app apuntando a una
> URL inexistente. Falla en silencio.
>
> Comprueba siempre que el script imprime
> `apiBaseUrl inyectado: https://osteomurtraining-production.up.railway.app/api`.

## 2) Identificador (Bundle ID)

> ✅ **Identificadores alineados.** Ambos usan `es.osteomur.training`:
>
> - Android: `applicationId` en `mobile/android/app/build.gradle` (registrado en Play Console).
> - iOS: `PRODUCT_BUNDLE_IDENTIFIER` en las configuraciones Debug y Release de
>   `mobile/ios/App/App.xcodeproj/project.pbxproj`.
> - Compartido: `appId` en `mobile/capacitor.config.json`.
>
> Ese identificador es válido para Play, pero **no lo cambies si ya tienes la app
> creada en App Store Connect con otro Bundle ID**: cada tienda lleva su propio
> registro y Apple no admite cambiarlo tras la primera publicación.
>
> Antes de nada, registra `es.osteomur.training` como identificador explícito en
> https://developer.apple.com/account/resources/identifiers/list. Xcode solo puede
> firmarlo si el Bundle ID ya existe en tu cuenta; si no, da error al archivar.
>
> Recuerda también que `IPHONEOS_DEPLOYMENT_TARGET` sigue en iOS 15.0, y Apple
> exige un SDK de compilación reciente en cada ciclo de revisión.

## 3b) Preparar el web m�vil para iOS (obligatorio al clonar en Mac)

La carpeta mobile/web/ **no se versiona** (est� en .gitignore). Tras clonar el repositorio en macOS, antes de 
px cap sync ios o de abrir Xcode, genera esa carpeta con la API de producci�n:

`ash
cd mobile
npm install  # solo primera vez
OSTEOMUR_API_URL=https://osteomurtraining-production.up.railway.app/api npm run web
`

No omitas la variable de entorno. Si no la pasas, scripts/build-mobile-web.mjs usa un valor de prueba (https://TU-API-PROD.ejemplo.com/api) y la app nativa apuntar� a una URL que no responde. 

Notas sobre dependencias iOS:

- **No uses pod install.** Este proyecto usa Capacitor 8 + Swift Package Manager (SPM). No existe Podfile.
- Al abrir el proyecto en Xcode (
px cap open ios), Xcode descargar� autom�ticamente las dependencias SPM desde GitHub y de 
ode_modules. La primera vez puede tardar varios minutos. 


## 3b) Preparar el web m�vil para iOS (obligatorio al clonar en Mac)

La carpeta mobile/web/ **no se versiona** (est� en .gitignore). Tras clonar el repositorio en macOS, antes de 
px cap sync ios o de abrir Xcode, genera esa carpeta con la API de producci�n:

`ash
cd mobile
npm install  # solo primera vez
OSTEOMUR_API_URL=https://osteomurtraining-production.up.railway.app/api npm run web
`

No omitas la variable de entorno. Si no la pasas, scripts/build-mobile-web.mjs usa un valor de prueba (https://TU-API-PROD.ejemplo.com/api) y la app nativa apuntar� a una URL que no responde.

Notas sobre dependencias iOS:

- **No uses pod install.** Este proyecto usa Capacitor 8 + Swift Package Manager (SPM). No existe Podfile.
- Al abrir el proyecto en Xcode (
px cap open ios), Xcode descargar� autom�ticamente las dependencias SPM. La primera vez puede tardar varios minutos.

## 3) Abrir y firmar en Xcode (en el Mac)

```bash
cd mobile
npx cap open ios
```

1. En Xcode, selecciona el target **App**.
2. **Signing & Capabilities → Team**: elige tu cuenta Apple (o crea un personal team).
3. Verifica **Bundle Identifier** = el de tu cuenta de Apple Developer.
4. **Deployment target:** iOS 15.0+ (ya configurado).
5. Dispositivos: iPhone e iPad (TARGETED_DEVICE_FAMILY 1,2).

## 4) Crear el registro en App Store Connect

En https://appstoreconnect.apple.com → **My Apps → + → New App**:
- Platform: iOS
- Name: **OSTEOMUR**
- Primary language: Español (España)
- Bundle ID: `es.osteomur.training` (ver la sección 2)
- SKU: código interno libre (p. ej. `osteomur001`)

## 5) Archivar y subir (Archive)

En Xcode, con el dispositivo de destino **Any iOS Device (arm64)**:

1. **Product → Archive**.
2. En el **Organizer**, selecciona el archive y pulsa **Distribute App →
   App Store Connect → Upload** (o **Export** para guardar el .ipa).
3. La app aparece en la sección **TestFlight / Versiones** de App Store Connect.

> La primera subida puede requerir aceptar los acuerdos legales de apple.

## 6) Rellenar la ficha (App Information / Version)

- **Description** (ficha): plantilla en español:

```
OSTEOMUR es la app de tu centro de entrenamiento personal.

Reserva tus sesiones según disponibilidad y gestiona tus créditos con un solo toque.

Sigue tus planes de entrenamiento, consulta la técnica de cada ejercicio con claves y vídeos, registra tu bienestar diario (fatiga, sueño, dolor, estrés) y mide tu progreso: peso corporal, % de grasa y masa muscular, con informes de valoración física.

Recibe notificaciones de recordatorios y avisos de caducidad de créditos. El entrenador gestiona asistencia, plantilla semanal, bonos, valoraciones e informes desde su panel.

Requiere cuenta creada por tu centro.
```

- **Keywords** (máx. 100 car.): `entrenamiento personal, gimnasio, fitness, nutrición, salud, reservas`
- **Support URL:** https://TU-DOMINIO (web del centro)
- **Marketing URL (opcional)**, **Privacy Policy URL:** https://TU-DOMINIO/privacidad (**obligatorio**)
- **Categoría:** Salud y bienestar (o "Deportes" según criterio). **Subcategoría:** opcional.
- **Calificación por edad (Age rating):** rellena el cuestionario. Por contener
  contenido de salud es información médica, sin contenido violento ni para adultos.
  Resultado típico: **4+**.
- **Screenshots:** 6.7" (iPhone Pro Max) y 6.5" como mínimo; prepara capturas reales
  de la app: login, Sesiones, Ejercicios, Wellness, Progreso y vista entrenador.
- **App Review Information:** cuenta demo para el revisor
  (cliente `carlos@demo.com` / `demo1234` y entrenador `entrenador@osteomur.es` /
  `demo1234`) — solo si se le solicita; también notes de contacto.

## 7) Enviar a revisión

- Sube primero una build desde el Organizer (paso 5).
- En la pestaña de la versión: elige la build de TestFlight/Upload, rellena todo y
  pulsa **Add for Review → Submit for Review**.
- La primera revisión suele tardar de 24 h a unos días.

## Versiones futuras
- Bumps: incrementa `CFBundleShortVersionString` en Xcode (Signing & Capabilities o
  en `Info.plist`) y el `CFBundleVersion`.
- Repite pasos 1–5 (re-sync + Archive) y sube la nueva versión.