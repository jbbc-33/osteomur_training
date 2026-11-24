# Velofit · Training App

App de entrenamiento personal con **dos vistas diferenciadas**:

- **Vista del Cliente** (web app para móvil iOS/Android) en **4 secciones**: Sesiones disponibles (2 semanas), Nutrición semanal, Ejercicios y Progreso.
- **Panel del Entrenador** (tablet/escritorio) en **4 secciones**: Sesiones (asistencia + plantilla y calendario), Clientes (ficha completa con editores de nutrición semanal y plan de entrenamiento), Ejercicios y Bonos/Créditos.

Stack: **Node.js + Express + SQLite** (sin compilaciones nativas) y **Web App responsive** servida por el propio servidor. Cero dependencias de build.

---

## Arranque rápido

Requisitos: **Node.js ≥ 23.4** (incluye `node:sqlite` integrado).

```bash
npm install        # instalar dependencias (express, bcryptjs, jsonwebtoken, web-push, nodemailer)
npm run seed       # crear la base de datos con datos de demo (opcional en 1er uso)
npm start          # arrancar servidor
```

Abre **http://localhost:3000**.

Para usarla desde tu **móvil/tablet en la misma red**, entra desde el móvil a la IP LAN que se muestra al arrancar (ej. `http://192.168.1.20:3000`). Asegúrate de que el cortafuegos de Windows permite la entrada en el puerto 3000.

### Cuentas de demostración (contraseña: `demo1234`)

| Rol | Email |
|---|---|
| Entrenador | `entrenador@osteomur.es` |
| Cliente | `carlos@demo.com`, `marta@demo.com`, `luis@demo.com`, `ana@demo.com`, `pedro@demo.com`, `laura@demo.com` |

Al loguearse, la app redirige automáticamente a la vista correspondiente según el rol.

### Contraseñas y recuperación de cuentas

- Cada cuenta guarda **un único hash** de contraseña. Cuando el entrenador asigna una contraseña nueva (o el cliente la cambia), la anterior deja de funcionar al instante.
- **El entrenador** puede asignar una contraseña nueva desde la ficha del cliente → botón **“Cambiar contraseña”**.
- **El cliente** puede cambiar la suya desde **Mi perfil → Seguridad**, indicando la contraseña actual.
- **Recuperación**: en el login, “¿Has olvidado tu contraseña?” envía por Gmail un enlace de un solo uso (caduca en 1 hora) a `/reset-password.html`. La respuesta es siempre genérica para no revelar si el email existe.
- Cada cambio envía un correo de confirmación a la cuenta.
- **Avisos y alertas por email**: además del centro de notificaciones de la app, los clientes reciben por Gmail los recordatorios de clase, avisos de créditos/bonos y alertas. El cliente puede desactivar estos correos en **Mi perfil → Notificaciones**.
- Los correos de **recuperación de cuenta y seguridad** (enlace de contraseña y confirmación de cambio) son obligatorios y **no se pueden desactivar**.

El sistema admite dos proveedores, elegidos con `MAIL_PROVIDER`:

- **`gmail` (por defecto)**: SMTP de Gmail. Funciona en local y en servidores que permitan el puerto 465.
- **`brevo`**: API HTTPS de Brevo (puerto 443), pensado para Railway. **Railway bloquea el SMTP en los planes Hobby/Free/Trial** (incluido el de 5 €/mes), así que en producción hay que usar esta opción o subir al plan Pro.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MAIL_PROVIDER` | No | `gmail` (defecto) o `brevo` |
| `GMAIL_USER` | Sí con `gmail` | Cuenta de Gmail desde la que se envían los correos |
| `GMAIL_APP_PASSWORD` | Sí con `gmail` | Contraseña de aplicación de Google (requiere verificación en 2 pasos) |
| `BREVO_API_KEY` | Sí con `brevo` | Clave API de Brevo (`https://app.brevo.com/settings/keys/api`) |
| `MAIL_FROM` | Recomendable | Remitente visible, p. ej. `OSTEOMUR Training <cuenta@gmail.com>`. Con Brevo debe ser un **remitente verificado** en Brevo |
| `PUBLIC_BASE_URL` | No | URL pública de la app (`https://tu-dominio`) para el enlace de recuperación y el botón de los emails de avisos |
| `MAIL_OUTBOX_ONLY` | No | `1` para no enviar correos reales (tests/desarrollo). **No debe estar a `1` en producción** |

Para usar Brevo: crea la cuenta, verifica un remitente en *Senders & Domains* y genera una clave API. En Railway añade `MAIL_PROVIDER=brevo`, `BREVO_API_KEY=...` y `MAIL_FROM=<remitente verificado>` en **Variables** y redespliega. No hay que instalar paquetes nuevos: se usa el `fetch` nativo de Node.

Si no hay credenciales, la app sigue funcionando: no se envían correos (el contenido queda en el log del servidor) y el enlace de recuperación aparece también en el log. Los avisos y alertas siguen llegando al centro de notificaciones de la app y, si está activado, por Web Push.

Si en producción ves `[mailer] No se pudo enviar el correo ... Brevo 401`, la clave API es incorrecta; si ves `Brevo 403`, el remitente de `MAIL_FROM` no está verificado en Brevo.

---

## Flujo de funcionamiento (el del briefing)

```
[Cliente paga (ej. 130 €)]  → Panel Entrenador → "Bonos" → asignar bono configurable
        │
[Se le asignan los créditos del bono (válidos X días)]  ← caducidad automática + recordatorio push
        │
[Cliente abre la app → Sesiones → elige día/hora "Quedan X/4 plazas"]
        │
[RESERVAR → se resta 1 crédito]  ← control de aforo estricto (transacción atómica)
        │
[Llega el día → Panel Entrenador → "Sesiones" → marcar Presente/Ausente]
        │
[Clic en el cliente → ficha: notas + registro + valoración + editores de nutrición/plan]
```

---

## Funcionalidades implementadas

### Vista del Cliente (4 secciones)
- **Sesiones disponibles**: muestra solo la **semana actual y la siguiente**. Cada sesión cuesta el **coste global configurable** (1 crédito por defecto). Incluye tarjeta de "próxima clase reservada", aforo en tiempo real ("Quedan 2/4 plazas"), temática y ejercicios de la clase, y botones [Reservar Plaza] / [Cancelar Reserva] con devolución de crédito si se cancela con **≥2 horas** de antelación.
- **Nutrición**: plan semanal del entrenador con las comidas de los 7 días (tipo de comida, plato, descripción, receta desplegable y macros: kcal, proteínas, hidratos y grasas), con totales diarios.
- **Ejercicios**: biblioteca con filtro por categoría, claves de técnica y vídeos de YouTube.
- **Progreso**: plan de entrenamiento personalizado por días + gráficas (peso, % grasa, músculo) e **informes descargables** (Imprimir / Guardar como PDF).
- **Perfil** (modal): foto, datos, notificaciones push, preferencia de avisos por email y cierre de sesión. Cabecera con chip de créditos.

### Panel del Entrenador (4 secciones)
- **Sesiones**: dos pestañas — *Asistencia del día* (franjas con reservas, aviso de lesiones, [Presente]/[Ausente], refresco cada 15 s) y *Plantilla y calendario* (plantilla semanal con temática/coste/ejercicios, aplicar a N semanas, crear/editar/cancelar/eliminar clases puntuales; cancelar reembolsa y avisa a los reservados).
- **Clientes**: buscador por nombre/email y ficha completa por cliente con notas médicas, **registro rápido Ejercicio/Serie/Peso/Reps/RPE/VBT**, valoración corporal con informe automático, informes, y dos editores: **nutrición semanal** (comidas por día, copiar plan de otro cliente) y **plan de entrenamiento** (ejercicios de la biblioteca por día con series/reps/descanso). Incluye asignar bono, ajustar créditos y dar de baja/reactivar.
- **Ejercicios**: alta y edición de la biblioteca (nombre, categoría, vídeo, descripción, técnica).
- **Bonos y créditos**: **bonos configurables** (nombre, precio €, créditos y días de validez, activar/desactivar), **coste global por sesión**, asignación de bono al cliente, ajuste libre del saldo, ingresos del mes, créditos activos, bonos que caducan en ≤2 días y últimas asignaciones.

---

## Detalles técnicos clave

1. **Control de aforo estricto**: la reserva se hace dentro de una **transacción SQLite `BEGIN IMMEDIATE`** que cuenta las reservas activas de la franja, comprueba el saldo de créditos y descuenta el crédito; cualquier sobre-aforo se rechaza con HTTP 409 ("Aforo completo"). No es posible que una 5ª persona se apunte a una franja con 4 plazas.
2. **Base de datos ligera**: SQLite en un único fichero `data/training.db` con WAL. Rápido, sin servicios externos y sin configuración.
3. **Créditos**: los **bonos son configurables** (nombre, precio, créditos y días de validez). Cada asignación crea un `expires_at = ahora + N días`; el saldo caduca de forma automática (lazy al consultar + recordatorio 2 días antes). El entrenador puede **ajustar el saldo libremente** (añadir/quitar créditos, con motivo registrado en el histórico) y **cancelar una clase completa** devolviendo el crédito a todos los reservados. El **coste por sesión** es global (`app_settings.session_cost_credits`, 1 por defecto) y se aplica a las clases nuevas.
4. **Notificaciones**: un scheduler revisa cada 60 s los recordatorios de clase (24 h antes) y las caducidades; las envía al centro de notificaciones, por email (salvo que el cliente lo desactive) y, si el cliente activó Web Push, a su móvil.
   - Nota: el **Web Push** solo funciona en contexto seguro (HTTPS o `localhost`). Desde el móvil por LAN `http://192.168.x.x` funcionan los avisos dentro de la app, pero no el push del navegador salvo que se sirva con HTTPS.
5. **Nutrición semanal**: modelo `nutrition_plans` (cabecera por cliente) + `nutrition_meals` (comidas por día 1-7 con plato, receta, descripción y macros). El entrenador edita los 7 días desde la ficha del cliente y puede **copiar el plan de otro cliente**.
6. **Plan de entrenamiento**: `training_plans` + `training_plan_exercises` (ejercicios de la biblioteca con día de la semana opcional, series, reps, descanso y nota). Se usa el plan más reciente y el cliente lo ve en Progreso.
7. **Migración automática**: si la base existía con el modelo viejo de nutrición (`nutrition_meals.user_id` / `nutrition_plans.title`), `db.js` la recrea con el nuevo esquema antes de crear índices.

### Configuración (variables de entorno)

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `CANCEL_WINDOW_HOURS` | `2` | Límite de cancelación antes de la clase |
| `MAIL_PROVIDER` | `gmail` | `gmail` (SMTP) o `brevo` (API HTTPS; necesario en Railway Hobby) |
| `GMAIL_USER` | — | Cuenta Gmail para correos de recuperación, seguridad y avisos/alertas |
| `GMAIL_APP_PASSWORD` | — | Contraseña de aplicación de Gmail |
| `BREVO_API_KEY` | — | Clave API de Brevo cuando `MAIL_PROVIDER=brevo` |
| `MAIL_FROM` | `OSTEOMUR Training <GMAIL_USER>` | Remitente de los correos (verificado en Brevo si se usa Brevo) |
| `PUBLIC_BASE_URL` | — | URL pública usada en los enlaces de recuperación y de los avisos |
| `MAIL_OUTBOX_ONLY` | — | `1` desactiva el envío real (tests) |
| `ALLOWED_ORIGINS` | — | Orígenes adicionales permitidos por CORS, separados por comas (la app nativa y `localhost` ya están permitidos) |
| `TRUST_PROXY` | `1` en producción, `loopback` en local | Confianza en `X-Forwarded-*` (`true`, `false` o número de proxies) para obtener la IP real tras Railway/nginx |
| `JWT_EXPIRES_IN` | `7d` | Duración de la sesión JWT |
| `JWT_ISSUER` | `osteomur-training` | Emisor (`iss`) obligatorio en los tokens |
| `JWT_AUDIENCE` | `osteomur-app` | Audiencia (`aud`) obligatoria en los tokens |
| `FORCE_HTTPS` | — | `1` redirige a HTTPS todo lo que no sea `/api/health` |
| `LOGIN_MAX_FAILURES` | `8` | Fallos de login por IP+email antes de bloquear |
| `LOGIN_FAIL_WINDOW_MS` | `900000` | Ventana (15 min) en la que se cuentan los fallos |
| `LOGIN_BLOCK_MS` | `900000` | Duración del bloqueo (15 min) |
| `LOGIN_MAX_IP_FAILURES` | `40` | Fallos totales por IP antes de bloquear |
| `LOGIN_RATE_MAX` | `30` | Peticiones de login por IP cada 15 min |
| `REGISTER_RATE_MAX` | `20` | Registros por IP cada hora |
| `RECOVER_RATE_MAX` | `10` | Solicitudes de recuperación por IP cada 15 min |
| `SENSITIVE_RATE_MAX` | `20` | Cambios de contraseña/reset por IP cada 15 min |
| `API_RATE_MAX` | `600` | Peticiones generales al API por IP y minuto (`/api/health` exento) |
| `JSON_BODY_LIMIT` | `4mb` | Tamaño máximo del cuerpo JSON |
| `KEEP_ALIVE_TIMEOUT_MS` | `65000` | `keepAliveTimeout` del servidor HTTP |
| `HEADERS_TIMEOUT_MS` | `70000` | Tiempo máximo para recibir cabeceras |
| `REQUEST_TIMEOUT_MS` | `60000` | Tiempo máximo de una petición completa |

### Seguridad

- **Contraseñas**: mínimo 8 caracteres; se guardan solo como hash bcrypt. Cada cambio (propio, asignado por el entrenador o por recuperación) incrementa `users.token_version` e invalida todas las sesiones anteriores.
- **Sesiones JWT**: algoritmo HS256, emisor y audiencia verificados, caducidad configurable y comprobación de `token_version` en cada petición. Existe `POST /api/auth/logout-all` para cerrar todas las sesiones.
- **Tiempo real**: el JWT nunca viaja en la URL. El cliente pide un ticket efímero de 90 s (`GET /api/auth/events-ticket`) y lo usa en `/api/events`; al reconectar pide uno nuevo.
- **Fuerza bruta**: bloqueo temporal tras 8 fallos por IP+email (40 por IP) y límites de peticiones en login, registro, recuperación y cambios de contraseña.
- **Cabeceras**: CSP sin scripts inline (`script-src 'self'`), `frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` restrictiva y HSTS cuando se sirve por HTTPS. El API se envía con `Cache-Control: no-store`.
- **CORS**: lista blanca (mismo host, orígenes Capacitor, `localhost` en desarrollo y `ALLOWED_ORIGINS`); un origen externo recibe `403`.
- **Entradas y salidas**: validación y normalización en el servidor; los datos de usuario se escapan antes de insertarse en HTML, tanto en la API de informes como en el frontend.
- **Secretos**: el secreto JWT se guarda en un fichero persistente con permisos restringidos (no se lee de una variable de entorno); si el fichero no existe o es débil, se regenera automáticamente.
- **Errores**: las respuestas 500 no muestran trazas ni detalles internos y llevan `X-Request-Id` para correlacionar con los logs.

---

## Estructura del proyecto

```
├── server.js                  # Express: API + estáticos + arranque
├── db/
│   ├── db.js                  # SQLite (node:sqlite), esquema y helpers de franjas
│   ├── seed.js                # Datos de demostración
│   └── reset.js               # Borra la base de datos
├── routes/
│   ├── auth.js                # Registro, login, perfil y contraseñas (cambio/recuperación)
│   ├── client.js              # Calendario, reservas, evolución, informes, ejercicios, nutrición, notificaciones, push
│   └── trainer.js             # Lista del día, asistencia, ficha, clases/plantilla, clientes/nutrición/bajas, créditos, valoraciones, biblioteca
├── services/
│   ├── business.js            # Créditos, aforo transaccional, cancelación, cancelar clase, baja de cliente
│   ├── passwords.js           # Hash de contraseñas y tokens de recuperación de un solo uso
│   ├── mailer.js              # Envío por Gmail SMTP (nodemailer) con outbox de respaldo
│   ├── notifications.js       # Scheduler + Web Push (VAPID)
│   └── reports.js             # Generador de informes HTML (imprimibles/PDF)
├── middleware/
│   ├── auth.js                # JWT, tickets SSE y token_version
│   ├── jwt-secret.js          # Secreto persistente, emisor/audiencia/TTL
│   ├── rate-limit.js          # Límites por IP y bloqueo de fuerza bruta
│   ├── security.js            # Cabeceras, CSP, CORS y X-Request-Id
│   └── validate.js            # Validación/limpieza de entradas
├── public/
│   ├── index.html             # Login / registro / recuperación
│   ├── reset-password.html    # Formulario de nueva contraseña (enlace de Gmail)
│   ├── client.html            # Vista del cliente
│   ├── trainer.html           # Panel del entrenador
│   ├── sw.js                  # Service Worker (Web Push / PWA)
│   └── css/ js/               # Estilos y lógica (sin scripts inline)
└── test-api.js                # Suite E2E de la API
```

## Tests

```bash
npm test
```

Ejecuta más de 160 comprobaciones end-to-end: autenticación, aforo (5ª persona bloqueada), reserva/cancelación con devolución de crédito, clientes sin créditos, asistencia, ficha de sesión, bonos configurables (CRUD), coste por sesión, valoración + informe automático, panel financiero, plantilla semanal y clases manuales (crear/cancelar/eliminar), ajuste libre de créditos, **nutrición semanal (guardar/ver/copiar)**, **plan de entrenamiento**, baja/reactivación de cuentas, **seguridad de cuentas (cambio/recuperación de contraseña, invalidación de sesiones, preferencias de email)** y servido de estáticos.

> Los tests crean datos y modifican la base de datos. Para ejecutarlos sin tocar la base de desarrollo: define un `DATA_DIR` temporal, ejecuta `node db/seed.js` y después `npm test`. `npm run seed` y `npm run reset` borran y recrean la base.

## Roadmap sugerido

- Edición de valoraciones existentes y borrado.
- Migración a PostgreSQL (los modelos ya son relacionales) cuando haya más usuarios.
- Despliegue con HTTPS (Nginx/Caddy + VPS) para activar Web Push fuera de localhost.
- Versión nativa (Expo/React Native) reutilizando la misma API.
