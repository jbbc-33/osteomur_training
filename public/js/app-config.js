'use strict';

/*
  Configuración global de la aplicación (web y móvil).

  - En la versión web (servida por el propio Express) apiBaseUrl queda en '' y el
    navegador llama al mismo origen ("/api/...").
  - En la app nativa (Capacitor) el frontend se sirve desde la WebView local, así
    que aquí se inyecta la URL pública del backend. El script
    scripts/build-mobile-web.mjs genera esa versión automáticamente al hacer build.
*/
window.APP_CONFIG = Object.freeze({
  apiBaseUrl: '',
});