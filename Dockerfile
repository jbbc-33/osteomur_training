# Node 24 explicito en la etiqueta de la imagen. Se fija aqui, y no via
# engines.node o .nvmrc, porque Nixpacks ignora ambos: en los despliegues
# anteriores arranco con Node 18 y `node:sqlite` no existe a partir de 23.4,
# lo que provocaba ERR_UNKNOWN_BUILTIN_MODULE en bucle de reinicios.
FROM node:24-slim

WORKDIR /app

# Primero solo los manifiestos, para que la capa de dependencias se reutilice
# mientras no cambien. Sin el montaje de cache de Nixpacks, asi que `npm ci`
# puede borrar node_modules sin problemas de EBUSY.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

# Railway monta aqui el volumen persistente. El proceso va como root a
# proposito: los volumenes suelen ser propiedad de root y con un usuario sin
# privileges el arranque falla con EACCES al crear training.db.
RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
