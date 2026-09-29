# syntax=docker/dockerfile:1.7
# Образ веба, профиль gpu (T-060). Собирается в CI из корня репозитория: docker build -f apps/web/Dockerfile .
# Сборка Vite в node-стадии; в рантайм едет только статика и конфиг nginx.
# nginx — только nginxinc/nginx-unprivileged: мастер не под root, порт 8443, cap_add не нужен.

ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine@sha256:4714e0b1b2577eaa1a6131d07c958b67f0eb68e6d0521e90c6e5287db8cf0bc5

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @inspector/web...
COPY apps/web apps/web
COPY docs/user-guide docs/user-guide
COPY scripts/user-guide.mjs scripts/demo-docs.mjs scripts/doc-nav.mjs scripts/docs-material-shell.mjs scripts/
ARG REVISION=unknown
ARG VERIFICATION_ONLY=false
ENV VITE_VERIFICATION_ONLY=${VERIFICATION_ONLY}
RUN pnpm --filter @inspector/web build
RUN INSPECTOR_BUILD_REVISION="$REVISION" node scripts/user-guide.mjs apps/web/dist/docs/guide --standalone

FROM ${NGINX_IMAGE} AS runtime
# uid числом (hadolint DL3066); root нужен только на время apk upgrade и раскладки файлов
USER 0
# hadolint ignore=DL3017
RUN apk --no-cache upgrade && rm -f /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/inspector.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
RUN chown -R root:root /usr/share/nginx/html /etc/nginx/conf.d && chmod -R a-w /usr/share/nginx/html /etc/nginx/conf.d
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION} org.opencontainers.image.title="inspector-web"
USER 101
EXPOSE 8443
# NFR-STAND: живость самого nginx — статика «/» по TLS на петле. curl уже есть в базовом nginx-unprivileged:alpine
# (пакет не добавляется). -k — только для 127.0.0.1 внутри контейнера: сертификат выпущен на внешнее имя стенда,
# секретов запрос не несёт. /health не берём: он проксируется в API, и падение API уронило бы и web (каскад).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "-fsSk", "--max-time", "4", "-o", "/dev/null", "https://127.0.0.1:8443/"]
