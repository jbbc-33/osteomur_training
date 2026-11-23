# Resumen de seguridad — OSTEOMUR Training

Este documento recoge los cambios de seguridad implementados en la aplicación.

## 1. Seguridad de cuentas y correo

- **Contraseña única por usuario**: solo se guarda un hash bcrypt en `users.password_hash`. Cambiarla (por el propio cliente, por el entrenador o por recuperación) invalida la anterior al instante, sin historial de contraseñas.
- **Recuperación**: enlace de un solo uso con caducidad de 1 h; en BD solo se guarda el hash SHA-256 del token. La respuesta de `/forgot-password` es siempre genérica para no revelar si el email existe.
- **Emails**: correos de seguridad obligatorios (no se pueden desactivar) y avisos/alertas opcionales con preferencia `email_notifications` en el perfil; mailer Gmail con modo outbox para tests.
- **UI y tests**: pantalla de reset, selector de preferencias y cobertura E2E del flujo completo.

## 2. Endurecimiento de la aplicación

### Sesiones y JWT — `middleware/auth.js`, `middleware/jwt-secret.js`, `db/db.js`

- Firma HS256 con `iss`/`aud` (`JWT_ISSUER`, `JWT_AUDIENCE`) y TTL configurable (`JWT_EXPIRES_IN`, por defecto `7d`); la verificación exige algoritmo, emisor y audiencia correctos.
- Secreto **persistente en fichero** con permisos `0600` (no se lee de entorno); si falta o es débil (<32 bytes) se regenera.
- Nueva columna `users.token_version` (`tv`): cualquier cambio de contraseña, reset, baja de cliente o `POST /api/auth/logout-all` incrementa el contador e invalida **todas** las sesiones previas.
- Ticket SSE de 90 s con `purpose:'events'`; al caducar o reconectar se pide uno nuevo.

### Login y fuerza bruta — `middleware/rate-limit.js`, `routes/auth.js`

- Bloqueo de 15 min tras **8 fallos por IP+email** o **40 por IP**; cabecera `Retry-After`.
- Comparación con un hash bcrypt ficticio para emails inexistentes: mismo tiempo de respuesta, sin enumeración de cuentas.
- Límites por endpoint: login 30/15 min, registro 20/h, recuperación 10/15 min, cambios de contraseña 20/15 min, API general 600/min (health exento). Configurables por entorno.
- Longitud mínima de contraseña **8 caracteres** en registro, cambio, reset y asignación del entrenador. Usuarios inactivos no pueden entrar.

### Red y cabeceras — `middleware/security.js`, `server.js`

- CSP: `script-src 'self'` (sin `unsafe-inline`), `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`, `object-src 'none'`, `frame-src` solo YouTube/Vimeo.
- `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, HSTS en HTTPS, `Cache-Control: no-store` en el API, redirección HTTPS opcional (`FORCE_HTTPS`).
- CORS con lista blanca: mismo host, orígenes Capacitor, `localhost` en desarrollo y `ALLOWED_ORIGINS`; origen externo → **403**.
- Confianza de proxy configurable, límite de body JSON (4 MB), timeouts HTTP y apagado ordenado.
- Errores 500 sin trazas ni detalles internos; `X-Request-Id` en todas las respuestas; rutas API desconocidas devuelven 401 sin autenticar y 404 JSON con `request_id` autenticadas.

### Validación y prevención de XSS — `middleware/validate.js`, rutas, informes y frontend

- Validación en servidor de textos, emails, enteros, URL de vídeo y avatares (`data:image/*;base64` o `http(s)`).
- Escapado de datos de usuario en informes (`services/reports.js`, incluye apóstrofos) y en notificaciones, franjas, temas, ejercicios, carteras, pagos, bonos, etiquetas y valoraciones del frontend.
- `toast`, `confirmDialog` y `avatarHtml` renderizan con `textContent`/URL segura: ya no interpretan HTML.
- Eliminados todos los `<script>` inline y atributos `onclick` de las páginas: lógica extraída a `login.js`, `reset-password.js` y `print.js`.

## 3. Verificación

- `node --check` OK en los 19 ficheros JavaScript modificados.
- Suite E2E con `DATA_DIR` temporal: **164 OK · 4 ERROR**; los 4 son fallos preexistentes de scoring (global 0, ejes del radar, `f0` VBT, asimetría YBT), no relacionados con seguridad.
- Smoke HTTP: **18/18 OK** (CSP, CORS, SSE, rate limit, request IDs, etc.).
- Navegador: sin errores de consola ni violaciones CSP; escaneo de `public/` sin scripts inline ni `javascript:`.
- **Sin dependencias npm nuevas** y `data/training.db` intacto.
