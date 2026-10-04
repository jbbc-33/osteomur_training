'use strict';

/*
  Rutas del "disco persistente": todo lo que debe sobrevivir a un reinicio.

  Por defecto usa `<raíz del proyecto>/data`, que es lo correcto en local. Pero
  en un host con volumen (Railway, Render, Fly...) la carpeta del proyecto suele
  ser efímera: si no, la base de datos, el secreto JWT y las claves VAPID se
  regeneran en cada despliegue (y con ello se borran los datos, se cierra la
  sesión de todos los usuarios y se rompe el push).

  Por eso `DATA_DIR` se puede mover con la variable de entorno DATA_DIR, de
  forma que el punto de montaje del volumen deje de importar:

    DATA_DIR=/data node server.js

  Este módulo es la única fuente de verdad: db/db.js, db/seed.js, db/reset.js,
  middleware/jwt-secret.js y services/notifications.js lo usan a todos.
*/

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DB_PATH = path.join(DATA_DIR, 'training.db');
const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt-secret');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

module.exports = { DATA_DIR, DB_PATH, JWT_SECRET_FILE, VAPID_FILE, ensureDataDir };
