'use strict';

// Botón de impresión para documentos estáticos (consentimiento informado).
(function () {
  const btn = document.getElementById('btn-print');
  if (btn) btn.addEventListener('click', () => window.print());
})();
