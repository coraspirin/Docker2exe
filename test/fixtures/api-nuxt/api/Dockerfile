FROM node:22-alpine
WORKDIR /api
COPY . .
RUN npm install --omit=dev
CMD ["node", "server.js"]
