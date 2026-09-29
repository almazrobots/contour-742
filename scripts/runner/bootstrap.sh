#!/usr/bin/env bash
# Раннер гейта на удалённом сервере (T-181, ADR-0009): инструменты ставятся в /opt/w1-gate/tools, система и чужие каталоги
# (/opt/inspector — разбор T-165) не трогаются. Идемпотентен: повторный запуск ставит только недостающее.
#   ssh root@158.255.3.179 'bash -s' < scripts/runner/bootstrap.sh
set -euo pipefail
R=${W1_ROOT:-/opt/w1-gate}
T=$R/tools
mkdir -p "$T/bin" "$R/logs" "$R/wt" "$R/cache/pnpm" "$R/cache/uv" "$R/cache/trivy" "$R/bin"
[ -d "$R/repo.git" ] || git init -q --bare "$R/repo.git"
# пользователь задач раннера (OWASP-0196): не root; пишет только в свои каталоги раннера
id w1run >/dev/null 2>&1 || useradd --system --home-dir "$R/home/w1run" --shell /usr/sbin/nologin w1run
# свои каталоги у w1run (wt/u, cache/u); root-каталоги раннера ему не принадлежат — владельцы не смешиваются
mkdir -p "$R/home/w1run" "$R/wt/u" "$R/cache/u/pnpm" "$R/cache/u/uv" && chown -R w1run:w1run "$R/home/w1run" "$R/wt/u" "$R/cache/u"
runuser -u w1run -- env HOME="$R/home/w1run" git config --global --replace-all safe.directory "$R/repo.git"
[ -f "$R/cpus" ] || echo "16-31" > "$R/cpus"   # ядра раннера; 0–15 — разбору T-165 (правится файлом, без перезапуска)

arch=x64
# Node 24 (engines: >=24 <27; CI — 24): последняя 24.x из официального индекса
if [ ! -x "$T/node/bin/node" ]; then
  v=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -oE "node-v24\.[0-9]+\.[0-9]+-linux-$arch\.tar\.xz" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$v" -o /tmp/$v
  (cd /tmp && curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep " $v\$" | sha256sum -c -)
  mkdir -p "$T/node" && tar -xJf /tmp/$v -C "$T/node" --strip-components=1 && rm -f /tmp/$v
fi
export PATH="$T/bin:$T/node/bin:$PATH"
# pnpm — версия из packageManager (corepack сверяет sha512 сам)
[ -x "$T/node/bin/pnpm" ] || { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable --install-directory "$T/node/bin"; }
# uv — та же версия, что на маке
[ -x "$T/bin/uv" ] || curl -LsSf https://astral.sh/uv/0.10.7/install.sh | env UV_INSTALL_DIR="$T/bin" UV_NO_MODIFY_PATH=1 sh
# gitleaks — версия из ci-gate.yml
# lsof — тест egress-прокси проверяет, что порт слушает только 127.0.0.1 (есть в раннерах GitHub, нет в Ubuntu minimal)
command -v lsof >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq lsof >/dev/null
GL=8.30.1
if ! { [ -x "$T/bin/gitleaks" ] && [ "$("$T/bin/gitleaks" version)" = "$GL" ]; }; then
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v$GL/gitleaks_${GL}_linux_x64.tar.gz" | tar -xz -C "$T/bin" gitleaks
fi
# Docker compose и buildx (T-183, dev-стенд ветки): плагины в своём каталоге, демон и система не трогаются —
# stand.sh зовёт docker с DOCKER_CONFIG=$T/docker. Версии — последние выпуски на 28.09, сверка по checksums.txt.
DC=v5.5.1 BX=v0.37.1 P=$T/docker/cli-plugins
mkdir -p "$P"
if ! { [ -x "$P/docker-compose" ] && DOCKER_CONFIG=$T/docker docker compose version | grep -qF "${DC#v}"; }; then
  u=https://github.com/docker/compose/releases/download/$DC
  curl -fsSL "$u/docker-compose-linux-x86_64" -o /tmp/docker-compose-linux-x86_64
  (cd /tmp && curl -fsSL "$u/checksums.txt" | grep ' \*\?docker-compose-linux-x86_64$' | sed 's/\*//' | sha256sum -c -)
  install -m 755 /tmp/docker-compose-linux-x86_64 "$P/docker-compose" && rm -f /tmp/docker-compose-linux-x86_64
fi
if ! { [ -x "$P/docker-buildx" ] && DOCKER_CONFIG=$T/docker docker buildx version | grep -qF "$BX"; }; then
  u=https://github.com/docker/buildx/releases/download/$BX
  curl -fsSL "$u/buildx-$BX.linux-amd64" -o "/tmp/buildx-$BX.linux-amd64"
  (cd /tmp && curl -fsSL "$u/checksums.txt" | grep " \*\?buildx-$BX.linux-amd64\$" | sed 's/\*//' | sha256sum -c -)
  install -m 755 "/tmp/buildx-$BX.linux-amd64" "$P/docker-buildx" && rm -f "/tmp/buildx-$BX.linux-amd64"
fi
mkdir -p "$R/stand"
echo "node $(node --version) · pnpm $(cd /tmp && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version 2>/dev/null || echo ?) · uv $(uv --version | cut -d' ' -f2) · gitleaks $(gitleaks version) · compose $(DOCKER_CONFIG=$T/docker docker compose version --short) · buildx $(DOCKER_CONFIG=$T/docker docker buildx version | cut -d' ' -f2) · ядра $(cat "$R/cpus")"
