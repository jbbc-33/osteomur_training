# Desplegar el backend (requisito para la app móvil)

La app nativa (iOS/Android) NO lleva el backend dentro: habla con tu servidor por
HTTPS. Para que la app funcione en las tiendas necesitas **alojar el servidor
Express + SQLite** en un sitio con **URL pública y HTTPS**.

> La app móvil se la URL del API desde `mobile/web/js/app-config.js`, que se genera
> con:
>
> ```bash
> OSTEOMUR_API_URL=https://TU-DOMINIO.com/api node scripts/build-mobile-web.mjs
> cd mobile && npx cap sync
> ```
>
> La URL debe incluir el sufijo `/api`.

---

## Opciones de hosting

### 1. Render (más fácil, gratis para empezar)
1. Crea una cuenta en https://render.com.
2. **New → Web Service**, conecta tu repo de GitHub (o "From source").
3. Configuración:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Runtime: **Node 24** (necesita `node:sqlite` integrado, Node ≥ 23.4).
   - **Disk**: añade un disco persistente montado en `/data` (la BD SQLite vive ahí).
4. Variables de entorno: `PORT=3000` (Render lo inyecta), `OSTEOMUR_API_URL`.
5. **HTTPS** te lo da Render automáticamente en `https://tu-app.onrender.com`.

### 2. Railway / Fly.io
- Igual que Render: desplegar el repo, runtime Node 24, **volumen persistente** para
  la carpeta `data/`.
- HTTPS automático.

### 3. VPS (mayor control)
- Ubuntu 22.04/24.04 + Node 24 (mediante `nvm install 24`).
- Copiar el proyecto (sin `node_modules`, `npm install --production`).
- Ejecutar como servicio con **systemd**:

```ini
# /etc/systemd/system/osteomur.service
[Unit]
Description=OSTEOMUR API
After=network.target

[Service]
WorkingDirectory=/opt/osteomur
ExecStart=/usr/bin/env node server.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

- HTTPS con **Caddy** (certificado automático):

```
tu-dominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

---

## Cosas importantes

- **BD persistente**: los cambios en SQLite no duran si el contenedor se recrea sin
  disco persistente. Monta siempre un volumen en `data/`.
- **Backups**: detén el servidor (o usa `sqlite3 .backup`) y copia
  `data/training.db` a un almacenamiento seguro con frecuencia.
- **CORS**: ya está configurado en `server.js` (refleja el `Origin` y acepta
  `Authorization`). No hay cookies: la autenticación es Bearer token.
- **Web Push (web)**: para que funcione en la web de producción, el frontend y el
  backend deben servirse desde el mismo origen HTTPS (ya ocurre si sirves `public/`
  desde el propio Express). No es necesario para la app nativa.

---

## Probar localmente la app nativa contra un backend local

Para desarrollo, puedes apuntar la app a tu PC (mismo Wi-Fi):

```bash
OSTEOMUR_API_URL=http://IP-DE-TU-PC:3000/api node scripts/build-mobile-web.mjs
cd mobile && npx cap sync
```

Si el backend usara HTTP (no HTTPS), en Android tendrías que permitir tráfico claro
(`android:usesCleartextTraffic="true"` en `AndroidManifest.xml`) y en iOS
configurar ATS. **Solo para desarrollo**: nunca lo publiques así en las tiendas, que
exigen HTTPS.