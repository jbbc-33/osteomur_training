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

## 1) Preparar la app

```bash
# 1. Apunta la app a tu backend real
OSTEOMUR_API_URL=https://TU-DOMINIO.com/api node scripts/build-mobile-web.mjs

# 2. Sincroniza iOS
cd mobile
npx cap sync ios
```

## 2) Identificador (Bundle ID)

Ya está fijado: `com.osteomur.app` (`PRODUCT_BUNDLE_IDENTIFIER` + `capacitor.config.json`).
Debe ser **único a nivel mundial**. Si lo cambias, cámbialo en
`mobile/capacitor.config.json` y vuelve a `cap sync`:

```jsonc
{ "appId": "com.tugimnasio.osteomur" }
```

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
- Bundle ID: `com.osteomur.app` (el de tu cuenta)
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