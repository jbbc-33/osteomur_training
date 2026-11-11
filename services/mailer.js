'use strict';

/*
  Envío de correo transaccional por Gmail SMTP.

  Configuración (variables de entorno):
    GMAIL_USER          cuenta de Gmail desde la que se envía
    GMAIL_APP_PASSWORD  contraseña de aplicación de Google (requiere 2FA)
    MAIL_FROM           remitente opcional ("OSTEOMUR Training <cuenta@gmail.com>")
    MAIL_OUTBOX_ONLY    si vale "1", nunca se envía de verdad (tests/desarrollo)

  Si no hay credenciales, el mensaje se guarda en un "outbox" en memoria y se
  escribe el enlace en el log. Así la recuperación sigue siendo probable en local
  y en los tests sin necesidad de Gmail.
*/

const nodemailer = require('nodemailer');

const OUTBOX_LIMIT = 100;
const outbox = [];

let transporter = null;

function isConfigured() {
  if (process.env.MAIL_OUTBOX_ONLY === '1') return false;
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function fromAddress() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  return `OSTEOMUR Training <${process.env.GMAIL_USER || 'no-reply@osteomur.es'}>`;
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: String(process.env.GMAIL_USER).trim(),
        pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, ''),
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  if (!to) return { delivered: false, error: 'Destinatario vacío' };
  const message = {
    from: fromAddress(),
    to,
    subject,
    text,
    ...(html ? { html } : {}),
  };

  const record = {
    to,
    subject,
    text,
    html: html || null,
    sent_at: new Date().toISOString(),
    delivered: false,
    error: null,
  };
  outbox.push(record);
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();

  if (!isConfigured()) {
    record.error = 'Gmail no configurado';
    console.log(`[mailer] Gmail no configurado. Correo para ${to} no enviado. Asunto: ${subject}`);
    if (text) console.log(`[mailer] Contenido:\n${text}`);
    return { delivered: false, outbox: record };
  }

  try {
    const info = await getTransporter().sendMail(message);
    record.delivered = true;
    record.message_id = info.messageId;
    return { delivered: true, messageId: info.messageId, outbox: record };
  } catch (e) {
    record.error = e.message;
    console.warn(`[mailer] No se pudo enviar el correo a ${to}: ${e.message}`);
    return { delivered: false, error: e.message, outbox: record };
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#063DA8;">${escapeHtml(title)}</h1>
      ${bodyHtml}
      <p style="margin-top:24px;font-size:12px;color:#64748b;">OSTEOMUR Training · Entrenamiento personal</p>
    </div>
  </body>
</html>`;
}

async function sendPasswordResetEmail(user, link, expiresMinutes = 60) {
  const name = user.full_name || 'cliente';
  const text = [
    `Hola ${name},`,
    '',
    'Hemos recibido una solicitud para cambiar la contraseña de tu cuenta de OSTEOMUR Training.',
    `Abre este enlace para crear una nueva contraseña (caduca en ${expiresMinutes} minutos):`,
    link,
    '',
    'Si no has solicitado el cambio, puedes ignorar este correo: tu contraseña actual seguirá funcionando.',
  ].join('\n');

  const html = layout('Recupera tu contraseña', `
    <p>Hola <b>${escapeHtml(name)}</b>,</p>
    <p>Hemos recibido una solicitud para cambiar la contraseña de tu cuenta de OSTEOMUR Training.</p>
    <p style="margin:22px 0;">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#063DA8;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;">Crear nueva contraseña</a>
    </p>
    <p style="font-size:13px;color:#475569;">El enlace caduca en ${expiresMinutes} minutos y solo se puede usar una vez.</p>
    <p style="font-size:13px;color:#475569;">Si no has solicitado el cambio, ignora este correo: tu contraseña actual seguirá funcionando.</p>
  `);

  return sendMail({ to: user.email, subject: 'Recupera tu contraseña · OSTEOMUR Training', text, html });
}

async function sendPasswordChangedEmail(user, reason = 'self') {
  const name = user.full_name || 'cliente';
  const intro = reason === 'trainer'
    ? 'Tu entrenador ha asignado una nueva contraseña a tu cuenta de OSTEOMUR Training.'
    : 'La contraseña de tu cuenta de OSTEOMUR Training se ha cambiado correctamente.';
  const warning = reason === 'trainer'
    ? 'Si no esperabas este cambio, contacta con tu entrenador.'
    : 'Si no has realizado este cambio, solicita la recuperación de tu cuenta lo antes posible.';

  const text = [
    `Hola ${name},`,
    '',
    intro,
    'A partir de ahora solo funciona la contraseña más reciente. Las anteriores han dejado de ser válidas.',
    '',
    warning,
  ].join('\n');

  const html = layout('Contraseña actualizada', `
    <p>Hola <b>${escapeHtml(name)}</b>,</p>
    <p>${escapeHtml(intro)}</p>
    <p><b>A partir de ahora solo funciona la contraseña más reciente.</b> Las anteriores han dejado de ser válidas.</p>
    <p style="font-size:13px;color:#475569;">${escapeHtml(warning)}</p>
  `);

  return sendMail({ to: user.email, subject: 'Tu contraseña ha cambiado · OSTEOMUR Training', text, html });
}

async function sendNotificationEmail(user, { title, body, kind = 'aviso', link = null } = {}) {
  const name = user.full_name || 'cliente';
  const label = kind === 'alerta' ? 'Alerta' : 'Aviso';
  const text = [
    `Hola ${name},`,
    '',
    `${label}: ${title}`,
    body,
    '',
    ...(link ? ['Puedes verlo en la app:', link, ''] : []),
    'Puedes desactivar estos correos desde Mi perfil → Notificaciones.',
    'Los correos de recuperación de cuenta y seguridad no se pueden desactivar.',
  ].join('\n');

  const html = layout(title, `
    <p>Hola <b>${escapeHtml(name)}</b>,</p>
    <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${kind === 'alerta' ? '#b45309' : '#063DA8'};">${escapeHtml(label)}</p>
    <p style="margin-top:0;">${escapeHtml(body)}</p>
    ${link ? `<p style="margin:22px 0;">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#063DA8;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;">Abrir la app</a>
    </p>` : ''}
    <p style="font-size:12px;color:#64748b;margin-top:22px;">Puedes desactivar estos correos desde <b>Mi perfil → Notificaciones</b>. Los correos de recuperación de cuenta y seguridad no se pueden desactivar.</p>
  `);

  return sendMail({ to: user.email, subject: `${label}: ${title} · OSTEOMUR Training`, text, html });
}

function getOutbox() {
  return outbox.slice();
}

function clearOutbox() {
  outbox.length = 0;
}

module.exports = {
  isConfigured,
  sendMail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendNotificationEmail,
  getOutbox,
  clearOutbox,
};
