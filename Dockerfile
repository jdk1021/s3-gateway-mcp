FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8000 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8000/health || exit 1
ENTRYPOINT ["node", "src/index.mjs"]
