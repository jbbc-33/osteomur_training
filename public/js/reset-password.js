'use strict';

// Pantalla para crear una contraseña nueva desde el enlace de recuperación.
// Fichero externo por la CSP (script-src 'self').
(function () {
  const MIN_PASSWORD_LENGTH = 8;
  const $ = (id) => document.getElementById(id);
  const box = $('error-box');
  const token = new URLSearchParams(location.search).get('token') || '';

  function showErr(msg) { box.textContent = msg; box.classList.add('show'); }
  function hideErr() { box.classList.remove('show'); }

  function showDone() {
    $('reset-form-wrap').style.display = 'none';
    $('reset-done').style.display = '';
  }

  $('link-login').addEventListener('click', () => { location.href = '/index.html'; });

  if (!token) {
    showErr('El enlace no es válido o ha caducado. Solicita uno nuevo desde la pantalla de inicio de sesión.');
    $('reset-submit').disabled = true;
    $('form-reset').style.display = 'none';
  }

  $('form-reset').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr();
    const password = $('reset-password').value;
    const repeat = $('reset-repeat').value;
    if (password.length < MIN_PASSWORD_LENGTH) {
      return showErr(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
    }
    if (password !== repeat) return showErr('Las dos contraseñas no coinciden');
    $('reset-submit').disabled = true;
    try {
      await API.post('/auth/reset-password', { token, password });
      showDone();
    } catch (err) {
      $('reset-submit').disabled = false;
      showErr(err.message);
    }
  });
})();
