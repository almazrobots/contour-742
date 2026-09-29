# syntax=docker/dockerfile:1.7
# Образ API, профиль gpu (T-060). Собирается в CI из корня репозитория: docker build -f apps/api/Dockerfile .
# Стандарт «прод-образы»: база по digest, многостадийная сборка, в рантайме нет npm/corepack/pnpm/tsx,
# код принадлежит root и не пишется, писать можно только в /app/var/blobs (том api-blobs).
# Node 24 — ветка LTS; unit-набор API на 24.21 зелёный (415/415). Node 25 (на маке) — нечётная ветка, в прод не идёт.

ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @inspector/api...

FROM deps AS build
COPY apps/api apps/api
# Один ESM-файл: TypeScript снимается здесь, в рантайм едет только JS; зависимости — внешние (node_modules).
# esbuild — объявленная зависимость API (T-087): версия бандлера прода — из lock, а не из порядка обхода .pnpm
# Две точки входа: server.mjs — API, migrate.mjs — служба миграций api-migrate (HIGH-1, тот же образ, другая команда);
# cli/blobs-encrypt.mjs — перешифрование наследия на томе блобов (NFR-CRYPTO): docker compose run --rm api node …
RUN apps/api/node_modules/.bin/esbuild apps/api/src/server.ts apps/api/src/verification-server.ts apps/api/src/migrate.ts apps/api/src/cli/blobs-encrypt.ts apps/api/src/cli/history-preserve.ts apps/api/src/cli/blobs-mirror.ts \
      --outbase=apps/api/src --bundle --platform=node --format=esm --packages=external --target=node24 \
      --outdir=apps/api/dist --out-extension:.js=.mjs

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod --filter @inspector/api...

FROM ${NODE_IMAGE} AS runtime
# T-238: kernel advisory lock shared by source pins and tmpfs eviction.
RUN apk add --no-cache flock=2.42.3-r1
# hadolint ignore=DL3017
RUN apk --no-cache upgrade \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=prod-deps /src/node_modules node_modules
COPY --from=prod-deps /src/apps/api/node_modules apps/api/node_modules
COPY --from=build /src/apps/api/dist apps/api/dist
COPY apps/api/package.json apps/api/
COPY data/seed data/seed
# ADR-0003 (T-107): SQL-миграции читают служба миграций (применяет) и API (сверяет план) — в бандл не входят, копируются как есть
COPY apps/api/src/db/migrations apps/api/src/db/migrations
# OS-INSP-6.1.4 (OWASP T-137 E3-H1): печати скрытого теста — API дописывает их в базу при старте, в gpu без них не стартует
COPY ml/eval/seals ml/eval/seals
# /app/var/blobs — точка монтирования тома api-blobs: пустой том при первом монтировании берёт владельца из образа (node)
# /app/var/blob-work — точка монтирования tmpfs blob-work (NFR-CRYPTO): открытый текст для ML, владельца задаёт tmpfs
RUN chown -R root:root /app && chmod -R a-w /app \
 && mkdir -p /app/var/blobs && chown node:node /app/var /app/var/blobs \
 && mkdir -p /app/var/blob-work && chown node:node /app/var/blob-work
ENV NODE_ENV=production INSPECTOR_ROOT=/app PORT=8810
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=${REVISION} org.opencontainers.image.title="inspector-api"
ENV INSPECTOR_REVISION=${REVISION}
# uid:gid пользователя node базового образа — числом (hadolint DL3066: имя может не разрешиться на хосте)
USER 1000:1000
EXPOSE 8810
# NFR-STAND: проверка живости без пакетов в рантайме — только node. Схема — по INSPECTOR_TLS_CERT (как у сервера).
# Корень доверия — INSPECTOR_HEALTH_CA_FILE (цепочка по CA стенда); не задан — проверка сертификата выключена, но
# ТОЛЬКО для этого запроса на 127.0.0.1 внутри контейнера: секретов он не несёт, подменить петлю снаружи нельзя.
# У одноразовой api-migrate (тот же образ) проверка выключена в compose (healthcheck: disable).
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "-e", "const e=process.env,t=!!e.INSPECTOR_TLS_CERT,ca=e.INSPECTOR_HEALTH_CA_FILE,o={host:'127.0.0.1',port:e.PORT||8810,path:'/health',timeout:4000};if(t){if(ca){o.ca=require('node:fs').readFileSync(ca);o.checkServerIdentity=()=>undefined}else o.rejectUnauthorized=false}require(t?'node:https':'node:http').get(o,r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>process.exit(r.statusCode===200&&/.status.:.ok./.test(b)?0:1))}).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"]
CMD ["node", "apps/api/dist/server.mjs"]
