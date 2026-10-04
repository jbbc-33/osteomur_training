'use strict';

/*
  Realtime central: Server-Sent Events (SSE) en memoria.

  - addClient()/removeClient(): registro de conexiones SSE activas.
  - broadcast(): envía un evento a todas las conexiones.
  - broadcastToUser(): envía un evento solo a una sesión concreta de un usuario.

  Es un bus en memoria válido para un único proceso Node (el caso actual).
  Si algún día el backend escala a varios procesos, este módulo habría que
  sustituirlo por algo compartido (p. ej. Redis pub/sub).
*/

const clients = new Map(); // id -> { res, userId, role }
let nextId = 1;

function addClient(res, userId, role) {
  const id = nextId++;
  clients.set(id, { res, userId, role });
  return id;
}

function removeClient(id) {
  clients.delete(id);
}

function clientCount() {
  return clients.size;
}

function _write(res, body) {
  try {
    res.write(body);
  } catch {
    // La conexión se cerrará por su cuenta (req 'close')
  }
}

function broadcast(type, payload = {}) {
  const body = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const c of clients.values()) _write(c.res, body);
}

function broadcastToUser(userId, type, payload = {}) {
  const body = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const c of clients.values()) {
    if (c.userId === userId) _write(c.res, body);
  }
}

module.exports = { addClient, removeClient, clientCount, broadcast, broadcastToUser };