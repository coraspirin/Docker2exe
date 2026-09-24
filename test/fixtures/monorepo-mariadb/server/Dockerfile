FROM node:22-slim
WORKDIR /srv
COPY . .
RUN npm install --omit=dev
EXPOSE 4000
CMD ["node", "index.js"]
