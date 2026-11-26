FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV APP_ENV=production
ENV PORT=3000
ENV DATA_FILE=/app/data/items.json

EXPOSE 3000

CMD ["node", "src/server.js"]