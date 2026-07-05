FROM --platform=linux/arm64 node:22-slim AS build

WORKDIR /app
COPY app/tmms_ui/package.json app/tmms_ui/package-lock.json ./
RUN npm ci
COPY app/tmms_ui/ ./
RUN npm run build

FROM --platform=linux/arm64 node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY app/tmms_ui/package.json app/tmms_ui/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY app/tmms_ui/ui_backend.js ./

EXPOSE 3001
CMD ["node", "ui_backend.js"]
