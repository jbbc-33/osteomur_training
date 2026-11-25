'use strict';

/*
  Envío de correo transaccional. Dos proveedores, elegidos con MAIL_PROVIDER:

    gmail (por defecto)  Gmail SMTP. Útil en local y en servidores que permitan
                         el puerto 465. Railway bloquea SMTP en los planes
                         Hobby/Free/Trial, ahí hay que usar brevo.
    brevo                API HTTPS de Brevo (puerto 443), sin dependencias:
                         usa el fetch nativo de Node.

  Variables de entorno:
    MAIL_PROVIDER       "gmail" (defecto) o "brevo"
    GMAIL_USER          cuenta de Gmail desde la que se envía (gmail)
    GMAIL_APP_PASSWORD  contraseña de aplicación de Google, requiere 2FA (gmail)
    BREVO_API_KEY       clave API de Brevo (brevo)
    MAIL_FROM           remitente, p. ej. "OSTEOMUR Training <cuenta@gmail.com>".
                        Con brevo debe ser un remitente verificado en Brevo.
    PUBLIC_BASE_URL     URL pública para los enlaces de recuperación/avisos
    MAIL_OUTBOX_ONLY    si vale "1", nunca se envía de verdad (tests/desarrollo)

  Si no hay credenciales, el mensaje se guarda en un "outbox" en memoria y se
  escribe el contenido en el log. Así la recuperación sigue siendo probable en
  local y en los tests sin necesidad de configurar ningún proveedor.
*/

const nodemailer = require('nodemailer');

const OUTBOX_LIMIT = 100;
const outbox = [];

let transporter = null;

function provider() {
  return String(process.env.MAIL_PROVIDER || '').trim().toLowerCase() === 'brevo' ? 'brevo' : 'gmail';
}

// Brevo espera { sender: { email, name } }, no el string "Nombre <email>".
function validEmail(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(String(value || '').trim());
}

// Acepta las tres formas habituales de MAIL_FROM:
//   "Nombre <email>", "Nombre email" y "email" (con o sin comillas en el valor).
function parseAddress(value) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(raw);
  if (m && validEmail(m[2])) {
    return { email: m[2].trim(), name: m[1].replace(/^['"]|['"]$/g, '').trim() };
  }
  const found = /([^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,})/.exec(raw);
  if (found && validEmail(found[1])) {
    const name = raw.replace(found[1], '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return { email: found[1], name };
  }
  return { email: raw, name: '' };
}

// Solo datos no sensibles: sirve para comprobar la configuración en producción.
function describeConfig() {
  const from = parseAddress(fromAddress());
  return {
    provider: provider(),
    configured: isConfigured(),
    outboxOnly: process.env.MAIL_OUTBOX_ONLY === '1',
    hasCredentials: provider() === 'brevo'
      ? !!String(process.env.BREVO_API_KEY || '').trim()
      : !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    from: from.email,
    fromName: from.name,
  };
}

function isConfigured() {
  if (process.env.MAIL_OUTBOX_ONLY === '1') return false;
  if (provider() === 'brevo') {
    return !!(String(process.env.BREVO_API_KEY || '').trim() && validEmail(parseAddress(fromAddress()).email));
  }
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

// HTTP en vez de SMTP: funciona en Railway Hobby, donde el puerto 465 está
// bloqueado. No se añade ninguna dependencia: Node 24 trae fetch y timeout.
async function sendBrevo(message) {
  const from = parseAddress(message.from);
  const payload = {
    sender: { email: from.email, ...(from.name ? { name: from.name } : {}) },
    to: [{ email: message.to }],
    subject: message.subject,
    // Brevo exige htmlContent (no "html") y permite enviar también el texto plano.
    ...(message.html ? { htmlContent: message.html } : {}),
    textContent: message.text || '',
  };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': String(process.env.BREVO_API_KEY || '').trim(),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data.message || JSON.stringify(data);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`Brevo ${res.status}: ${detail || res.statusText}`);
  }
  const info = await res.json().catch(() => ({}));
  return info.messageId || '';
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
    record.error = 'Correo no configurado';
    console.log(`[mailer] ${provider()} no configurado. Correo para ${to} no enviado. Asunto: ${subject}`);
    if (text) console.log(`[mailer] Contenido:\n${text}`);
    return { delivered: false, outbox: record };
  }

  try {
    const messageId = provider() === 'brevo'
      ? await sendBrevo(message)
      : (await getTransporter().sendMail(message)).messageId;
    record.delivered = true;
    record.message_id = messageId;
    console.log(`[mailer] Enviado a ${to} · ${subject} · id=${messageId || 'sin-id'}`);
    return { delivered: true, messageId, outbox: record };
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

// Aviso operativo al equipo cuando un cliente confirma una reserva.
// A diferencia de los avisos de cliente, aquí no se comprueba la preferencia
// email_notifications: el helper de notificaciones decide a quién enviarlo.
async function sendAdminBookingEmail(admin, booking, link = null) {
  const adminName = admin.full_name || 'equipo';
  const clientName = booking.clientName || 'Cliente';
  const clientEmail = booking.clientEmail || 'sin email';
  const when = `${booking.date || 'fecha desconocida'} a las ${booking.time || 'hora desconocida'}${booking.endTime ? ` - ${booking.endTime}` : ''}`;
  const theme = booking.theme || 'Sin temática';
  const kind = booking.kind === 'dirigida' ? 'Sesión dirigida' : 'Sesión normal';
  const bookingRef = booking.bookingId ? ` (reserva #${booking.bookingId})` : '';

  const text = [
    `Hola ${adminName},`,
    '',
    `El cliente ${clientName} (${clientEmail}) ha reservado una plaza en OSTEOMUR Training${bookingRef}.`,
    '',
    `Sesión: ${when}`,
    `Tipo: ${kind}`,
    `Temática: ${theme}`,
    '',
    ...(link ? ['Puedes ver el detalle en el panel del entrenador:', link, ''] : []),
    'Este aviso se genera automáticamente al confirmarse la reserva.',
  ].join('\n');

  const html = layout('Nueva reserva de cliente', `
    <p>Hola <b>${escapeHtml(adminName)}</b>,</p>
    <p>El cliente <b>${escapeHtml(clientName)}</b> (${escapeHtml(clientEmail)}) ha reservado una plaza en OSTEOMUR Training${escapeHtml(bookingRef)}.</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px;">
      <tr><td style="padding:8px 0;color:#64748b;">Sesión</td><td style="padding:8px 0;font-weight:700;">${escapeHtml(when)}</td></tr>
      <tr><td style="padding:8px 0;color:#64748b;">Tipo</td><td style="padding:8px 0;">${escapeHtml(kind)}</td></tr>
      <tr><td style="padding:8px 0;color:#64748b;">Temática</td><td style="padding:8px 0;">${escapeHtml(theme)}</td></tr>
    </table>
    ${link ? `<p style="margin:22px 0;">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#063DA8;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;">Abrir panel del entrenador</a>
    </p>` : ''}
    <p style="font-size:12px;color:#64748b;">Este aviso se genera automáticamente al confirmarse la reserva.</p>
  `);

  return sendMail({
    to: admin.email,
    subject: `Nueva reserva de ${clientName} · OSTEOMUR Training`,
    text,
    html,
  });
}

function clientLink() {
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL;
  return base ? `${String(base).replace(/\/+$/, '')}/client.html` : null;
}

// Confirmación inmediata al cliente que acaba de reservar. Es un correo
// transaccional (como el de seguridad): no depende de email_notifications.
async function sendBookingConfirmationEmail(client, booking, link = clientLink()) {
  const name = client.full_name || 'cliente';
  const when = `${booking.date || 'fecha desconocida'} a las ${booking.time || 'hora desconocida'}${booking.endTime ? ` - ${booking.endTime}` : ''}`;
  const theme = booking.theme || 'Sin temática';
  const kind = booking.kind === 'dirigida' ? 'Sesión dirigida' : 'Sesión normal';
  const credits = Number(booking.creditsUsed) > 0
    ? ` Se ha descontado ${Number(booking.creditsUsed)} ${Number(booking.creditsUsed) === 1 ? 'crédito' : 'créditos'} de tu saldo.`
    : '';

  const text = [
    `Hola ${name},`,
    '',
    'Tu reserva en OSTEOMUR Training está confirmada.',
    'Tu plaza ya está reservada: no tienes que confirmar nada por correo.',
    '',
    `Sesión: ${when}`,
    `Tipo: ${kind}`,
    `Temática: ${theme}${credits}`,
    '',
    ...(link ? ['Puedes verla en la app:', link, ''] : []),
    'Si no puedes asistir, cancela la reserva desde la app con al menos 2 horas de antelación para recuperar el crédito.',
  ].join('\n');

  const html = layout('Reserva confirmada', `
    <p>Hola <b>${escapeHtml(name)}</b>,</p>
    <p>Tu reserva en OSTEOMUR Training está confirmada.</p>
    <p style="font-size:13px;color:#475569;">Tu plaza ya está reservada: <b>no tienes que confirmar nada por correo</b>.</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px;">
      <tr><td style="padding:8px 0;color:#64748b;">Sesión</td><td style="padding:8px 0;font-weight:700;">${escapeHtml(when)}</td></tr>
      <tr><td style="padding:8px 0;color:#64748b;">Tipo</td><td style="padding:8px 0;">${escapeHtml(kind)}</td></tr>
      <tr><td style="padding:8px 0;color:#64748b;">Temática</td><td style="padding:8px 0;">${escapeHtml(theme)}</td></tr>
    </table>
    <p style="font-size:13px;color:#475569;">${escapeHtml(credits.trim())}</p>
    ${link ? `<p style="margin:22px 0;">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#063DA8;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;">Ver mis reservas</a>
    </p>` : ''}
    <p style="font-size:12px;color:#64748b;">Si no puedes asistir, cancela desde la app con al menos 2 horas de antelación para recuperar el crédito.</p>
  `);

  return sendMail({ to: client.email, subject: `Reserva confirmada: ${when} · OSTEOMUR Training`, text, html });
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
  sendAdminBookingEmail,
  sendBookingConfirmationEmail,
  getOutbox,
  clearOutbox,
  describeConfig,
};
