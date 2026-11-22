FROM node:24-bookworm-slim
WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1 \
    FOLIO_CONTENT=/content \
    FOLIO_CACHE=/cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY astro.config.ts tsconfig.json ./
COPY src ./src
COPY docker/build.sh ./docker/build.sh
CMD ["sh", "docker/build.sh"]
