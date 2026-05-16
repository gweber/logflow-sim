FROM node:20-alpine AS build
WORKDIR /app
# `VITE_BASE` lets the same Dockerfile produce a build that runs at `/`
# (default — docker compose, local dev) or under a sub-path like `/logflow/`
# for a reverse-proxied multi-tenant deploy. Must start and end with `/`.
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# Run as the `node` user (uid 1000) rather than root. The `node:alpine`
# image ships this user pre-created. Defence in depth against any
# code-execution surprises in dependencies — a compromise that escalates
# inside the container still won't be root inside it.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
