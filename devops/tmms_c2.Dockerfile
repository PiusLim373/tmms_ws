FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node node_modules ./node_modules
COPY --chown=node:node package.json c2_backend.js ./

USER node

EXPOSE 3002
CMD ["node", "c2_backend.js"]
