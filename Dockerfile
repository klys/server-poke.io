FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY index.ts ./
COPY Server ./Server
COPY components ./components
COPY emails ./emails

RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/emails ./emails

EXPOSE 3001

CMD ["node", "dist/index.js"]
