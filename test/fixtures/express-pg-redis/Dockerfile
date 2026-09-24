FROM node:22-alpine AS client
WORKDIR /client
COPY client/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
COPY --from=client /client/dist ./public
EXPOSE 3000
CMD ["node", "server.js"]
