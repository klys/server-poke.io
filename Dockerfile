FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY index.ts ./
COPY Server ./Server
COPY components ./components
COPY emails ./emails
# Maintenance-tab tools run compiled (dist/tools/*.js) in production.
COPY tools ./tools

RUN npm run build

FROM node:22-alpine AS runtime

# The git commit this image was built from. Passed via
# `docker build --build-arg GIT_SHA=<sha>` and surfaced at /version so the
# deploy pipeline can confirm prod is running the pushed commit.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/emails ./emails
# Bundled data for the "Repair Essentials Events" maintenance action.
COPY migration-data/rxdata_json ./migration-data/rxdata_json

EXPOSE 3001

CMD ["node", "dist/index.js"]
