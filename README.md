# Velofit · Training App

App de entrenamiento personal con **dos vistas diferenciadas**:

- **Vista del Cliente** (web app para móvil iOS/Android) en **4 secciones**: Sesiones disponibles (2 semanas), Nutrición semanal, Ejercicios y Progreso.
- **Panel del Entrenador** (tablet/escritorio) en **4 secciones**: Sesiones (asistencia + plantilla y calendario), Clientes (ficha completa con editores de nutrición semanal y plan de entrenamiento), Ejercicios y Bonos/Créditos.

Stack: **Node.js + Express + SQLite** (sin compilaciones nativas) y **Web App responsive** servida por el propio servidor. Cero dependencias de build.

---

## Arranque rápido

Requisitos: **Node.js ≥ 23.4** (incluye `node:sqlite` integrado).

```bash
npm install        # instalar dependencias (express, bcryptjs, jsonwebtoken, web-push)
npm run seed       # crear la base de datos con datos de demo (opcional en 1er uso)
npm start          # arrancar servidor
```

Abre **http://localhost:3000**.

Para usarla desde tu **móvil/tablet en la misma red**, entra desde el móvil a la IP LAN que se muestra al arrancar (ej. `http://192.168.1.20:3000`). Asegúrate de que el cortafuegos de Windows permite la entrada en el puerto 3000.

### Cuentas de demostración (contraseña: `demo1234`)

| Rol | Email |
|---|---|
| Entrenador | `entrenador@velofit.es` |
| Cliente | `carlos@demo.com`, `marta@demo.com`, `luis@demo.com`, `ana@demo.com`, `pedro@demo.com`, `laura@demo.com` |

Al loguearse, la app redirige automáticamente a la vista correspondiente según el rol.

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
- **Perfil** (modal): foto, datos, notificaciones push y cierre de sesión. Cabecera con chip de créditos.

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
4. **Notificaciones**: un scheduler revisa cada 60 s los recordatorios de clase (24 h antes) y las caducidades; las envía al centro de notificaciones y, si el cliente activó Web Push, a su móvil.
   - Nota: el **Web Push** solo funciona en contexto seguro (HTTPS o `localhost`). Desde el móvil por LAN `http://192.168.x.x` funcionan los avisos dentro de la app, pero no el push del navegador salvo que se sirva con HTTPS.
5. **Nutrición semanal**: modelo `nutrition_plans` (cabecera por cliente) + `nutrition_meals` (comidas por día 1-7 con plato, receta, descripción y macros). El entrenador edita los 7 días desde la ficha del cliente y puede **copiar el plan de otro cliente**.
6. **Plan de entrenamiento**: `training_plans` + `training_plan_exercises` (ejercicios de la biblioteca con día de la semana opcional, series, reps, descanso y nota). Se usa el plan más reciente y el cliente lo ve en Progreso.
7. **Migración automática**: si la base existía con el modelo viejo de nutrición (`nutrition_meals.user_id` / `nutrition_plans.title`), `db.js` la recrea con el nuevo esquema antes de crear índices.

### Configuración (variables de entorno)

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `CANCEL_WINDOW_HOURS` | `2` | Límite de cancelación antes de la clase |

---

## Estructura del proyecto

```
├── server.js                  # Express: API + estáticos + arranque
├── db/
│   ├── db.js                  # SQLite (node:sqlite), esquema y helpers de franjas
│   ├── seed.js                # Datos de demostración
│   └── reset.js               # Borra la base de datos
├── routes/
│   ├── auth.js                # Registro, login, perfil (rechaza cuentas de baja)
│   ├── client.js              # Calendario, reservas, evolución, informes, ejercicios, nutrición, notificaciones, push
│   └── trainer.js             # Lista del día, asistencia, ficha, clases/plantilla, clientes/nutrición/bajas, créditos, valoraciones, biblioteca
├── services/
│   ├── business.js            # Créditos, aforo transaccional, cancelación, cancelar clase, baja de cliente
│   ├── notifications.js       # Scheduler + Web Push (VAPID)
│   └── reports.js             # Generador de informes HTML (imprimibles/PDF)
├── middleware/auth.js         # JWT
├── public/
│   ├── index.html             # Login / registro
│   ├── client.html            # Vista del cliente
│   ├── trainer.html           # Panel del entrenador
│   ├── sw.js                  # Service Worker (Web Push / PWA)
│   └── css/ js/               # Estilos y lógica
└── test-api.js                # Suite E2E de la API (75 tests)
```

## Tests

```bash
npm test
```

Ejecuta 75 comprobaciones end-to-end: autenticación, aforo (5ª persona bloqueada), reserva/cancelación con devolución de crédito, clientes sin créditos, asistencia, ficha de sesión, bonos configurables (CRUD), coste por sesión, valoración + informe automático, panel financiero, plantilla semanal y clases manuales (crear/cancelar/eliminar), ajuste libre de créditos, **nutrición semanal (guardar/ver/copiar)**, **plan de entrenamiento**, baja/reactivación de cuentas y servido de estáticos.

## Roadmap sugerido

- Edición de valoraciones existentes y borrado.
- Migración a PostgreSQL (los modelos ya son relacionales) cuando haya más usuarios.
- Despliegue con HTTPS (Nginx/Caddy + VPS) para activar Web Push fuera de localhost.
- Versión nativa (Expo/React Native) reutilizando la misma API.
