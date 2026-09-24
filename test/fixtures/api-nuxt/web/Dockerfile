FROM node:22-alpine
WORKDIR /web
COPY . .
RUN npm install && npm run build
CMD ["node", ".output/server/index.mjs"]
