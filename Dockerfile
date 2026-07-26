FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 4173
CMD ["node", "server.mjs"]
