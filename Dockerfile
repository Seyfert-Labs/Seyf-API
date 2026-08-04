# syntax=docker/dockerfile:1

# ─── Compilación ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

# Capa de dependencias separada: no se reinstala si solo cambia el código.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Solo dependencias de producción para copiar al runtime.
RUN npm ci --omit=dev

# ─── Ejecución ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# La imagen de Node ya trae el usuario `node` sin privilegios.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080

# El liveness check es público y no toca dependencias externas.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
