# PRÉ-REQUIS : image de base de données buildée avant (voir Dockerfile.db) —
# le build échoue si elle n'existe pas :
#   docker build -f Dockerfile.db -t myflashcardapp/db .
FROM myflashcardapp/db:latest AS dbseed

# --- Étape 1 : build du client (tsc + Vite + génération du service worker PWA) ---
FROM node:22-alpine AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Étape 2 : image d'exécution (API + client statique en un seul processus) ---
FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=dbseed /seed/app.db /seed/app.db
COPY --from=web-build /build/web/dist ./web/dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data
VOLUME /app/data
ENV DB_PATH=/app/data/app.db
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
