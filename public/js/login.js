'use strict';

// Lógica de la pantalla de acceso (login, registro y recuperación).
// Vive en un fichero externo para cumplir la CSP (script-src 'self').
(function () {
  const $ = (id) => document.getElementById(id);

  const box = $('error-box');
  function showErr(msg) { box.textContent = msg; box.classList.add('show'); }
  function hideErr() { box.classList.remove('show'); }

  $('tab-login').addEventListener('click', () => switchTab('login'));
  $('tab-register').addEventListener('click', () => switchTab('register'));
  $('link-forgot').addEventListener('click', () => switchTab('forgot'));
  $('link-back-login').addEventListener('click', () => switchTab('login'));

  function switchTab(t) {
    hideErr();
    $('tab-login').classList.toggle('active', t === 'login' || t === 'forgot');
    $('tab-register').classList.toggle('active', t === 'register');
    $('form-login').style.display = t === 'login' ? '' : 'none';
    $('form-register').style.display = t === 'register' ? '' : 'none';
    $('form-forgot').style.display = t === 'forgot' ? '' : 'none';
    if (t === 'forgot') {
      $('forgot-ok').style.display = 'none';
      $('forgot-submit').disabled = false;
      $('forgot-email').focus();
    }
  }

  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr();
    try {
      const data = await API.post('/auth/login', {
        email: $('login-email').value.trim(),
        password: $('login-password').value,
      });
      finish(data);
    } catch (err) { showErr(err.message); }
  });

  $('form-register').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr();
    try {
      const data = await API.post('/auth/register', {
        email: $('reg-email').value.trim(),
        password: $('reg-password').value,
        full_name: $('reg-name').value.trim(),
        phone: $('reg-phone').value.trim(),
        age: $('reg-age').value ? Number($('reg-age').value) : undefined,
        height_cm: $('reg-height').value ? Number($('reg-height').value) : undefined,
        sport: $('reg-sport').value.trim(),
        active_injuries: $('reg-injuries').value.trim(),
      });
      finish(data);
    } catch (err) { showErr(err.message); }
  });

  $('form-forgot').addEventListener('submit', async (e) => {
    e.preventDefault(); hideErr();
    const okBox = $('forgot-ok');
    okBox.style.display = 'none';
    $('forgot-submit').disabled = true;
    try {
      const data = await API.post('/auth/forgot-password', { email: $('forgot-email').value.trim() });
      okBox.textContent = data.message;
      okBox.style.display = 'block';
    } catch (err) {
      $('forgot-submit').disabled = false;
      showErr(err.message);
    }
  });

  function finish(data) {
    API.setAuth(data.token, data.user);
    location.href = data.user.role === 'trainer' ? '/trainer.html' : '/client.html';
  }
})();
