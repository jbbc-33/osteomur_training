'use strict';

/*
  Puente nativo (Capacitor). Solo se activa dentro de la app nativa iOS/Android
  (window.Capacitor existe). En navegador web no hace nada.
  - Botón "atrás" de Android con navegación por historial.
  - Barra de estado del color de marca.
  - Oculta la splash screen al cargar.
  Requiere los plugins: @capacitor/app, @capacitor/status-bar, @capacitor/splash-screen
*/
(function () {
  if (!window.Capacitor) return;

  const plugins = window.Capacitor.Plugins || {};
  const { App, StatusBar, SplashScreen } = plugins;

  if (App) {
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) history.back();
      else App.minimizeApp();
    });
  }

  if (StatusBar) {
    StatusBar.setBackgroundColor({ color: '#063DA8' });
    StatusBar.setStyle({ style: 'LIGHT' });
    StatusBar.setOverlaysWebView({ overlay: false });
  }

  if (SplashScreen) {
    window.addEventListener('load', () => {
      SplashScreen.hide({ fadeOutDuration: 200 });
    });
  }
})();