#!/usr/bin/env bash
# Запуск на удалённом раннере (T-181, ADR-0009): код правится на маке, а сборка, тесты, гейт, мутации, e2e и Docker
# идут на сервере. Коммит уходит push'ем по SSH в bare-репо раннера (серверу не нужны ключи GitHub), там — свой
# worktree на ветку, замок flock, ядра из /opt/w1-gate/cpus, nice и ionice. Вывод идёт в терминал и в лог сервера.
#   scripts/remote-run.sh [--get <путь>]… <команда…>
#   scripts/remote-run.sh scripts/local-gate.sh --quick
#   scripts/remote-run.sh --get apps/api/reports/mutation "cd apps/api && env MUTATE=src/domain/class-param.ts npx stryker run --concurrency 12"
#   scripts/remote-run.sh stand up|down|logs|status [ветка] [--wipe|--forget|сервис…]   dev-стенд ветки (T-183)
# --get копирует путь из worktree раннера в тот же путь рабочего каталога мака после прогона (отчёты, логи).
# Без --wip раннер проверяет ровно коммит HEAD (гейт, мутации, цифры для отчёта).
# --wip — отладка: рабочее дерево как есть (с незакоммиченным) уходит rsync'ом в отдельный worktree ветки «<ветка>.wip»;
# для гейта и отчётов не годится. --light — лёгкая команда (тест по одному файлу, tsc, линтер): без очереди замка,
# nice 19 и 2 ядра из выделенных — не ждёт мутаций соседей; тяжёлое с --light не запускать.
# Команда идёт от пользователя w1run (OWASP-0196). --as-root — только Docker полного гейта и замер T-180 (пространство
# монтирования); такой запуск пишется в лог.
# --lane <имя> — своя очередь для другого вида работы (stand — сборка и подъём стенда): не ждёт мутаций и гейта,
# внутри полосы — по одному. Мутации и гейт — полоса по умолчанию (heavy). На маке для W1 не ставятся node_modules и .venv — всё запускается здесь (ADR-0009).
set -euo pipefail
# все подключения к раннеру — с таймаутами: под нагрузкой sshd молча висит, а не отказывает (28.09)
export GIT_SSH_COMMAND="ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
SSHO=(-o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
cd "$(git rev-parse --show-toplevel)"
# передача на раннер под нагрузкой рвётся («Connection closed») — три попытки; провал — явный код 70, а не тихий 0 (находка W3)
retry() { local n; for n in 1 2 3; do "$@" && return 0; echo "remote-run: попытка $n не удалась: $*" >&2; sleep $((n * 5)); done
  echo "remote-run: передача на раннер не удалась — прогон НЕ запускался" >&2; exit 70; }
# Updating the optional gate baseline must not hold an already pinned feature
# deployment indefinitely on GitHub/credential-helper stalls. HEAD is still
# pushed to the runner below; only the previously optional main refresh falls back.
fetch_main() {
  python3 - <<'PY'
import subprocess,sys
try:
    result=subprocess.run(['git','fetch','-q','origin','main'],timeout=20,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    print('remote-run: main refresh timed out; using existing origin/main',file=sys.stderr)
    sys.exit(1)
PY
}
HOST=${W1_RUNNER:-root@158.255.3.179}
R=${W1_ROOT:-/opt/w1-gate}
# A release run may pin its already-reviewed main base. Never silently skip
# refresh against an unknown or different local ref.
refresh_main() {
  if [ -n "${W1_MAIN_REVISION:-}" ]; then
    [[ "$W1_MAIN_REVISION" =~ ^[0-9a-f]{40}$ ]] &&
      [ "$(git rev-parse 'origin/main^{commit}')" = "$W1_MAIN_REVISION" ] || {
        echo 'remote-run: pinned main differs from local origin/main' >&2; exit 64;
      }
  elif [ "$refresh_origin" = 0 ]; then
    git rev-parse --verify 'origin/main^{commit}' >/dev/null || exit 64
  else
    fetch_main || true
  fi
}
# T-254: документация CPU-демо — только загрузка готовых статических артефактов.
# Сборка и браузерные проверки остаются на W1; БД/контейнеры CPU не затрагиваются.
if [ "${1:-}" = --publish-user-guide ]; then
  [ $# = 2 ] || { echo "usage: remote-run.sh --publish-user-guide <built-guide-directory>" >&2; exit 64; }
  [ -f "$2/build.json" ] && [ -f "$2/index.html" ] || { echo "guide build missing" >&2; exit 66; }
  stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
  stage="/opt/nadzorium/var/guide-stage-$stamp"
  cpu_host=${DEMO_HOST:-hk-ru}
  ssh "${SSHO[@]}" "$cpu_host" "install -d -m 755 $stage"
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$2" -cf - . | ssh "${SSHO[@]}" "$cpu_host" "tar --no-same-owner -xmf - -C $stage"
  scp "${SSHO[@]}" -q scripts/runner/publish-user-guide.mjs "$cpu_host:$stage/publish-user-guide.mjs"
  ssh "${SSHO[@]}" "$cpu_host" "flock /opt/nadzorium/var/guide-publish.lock node $stage/publish-user-guide.mjs $stage"
  exit
fi
# Static material release: scoped backup and metadata-preserving publisher.
if [ "${1:-}" = --publish-material-release ]; then
  [ $# = 2 ] && [ -f "$2/release.json" ] || { echo 'material release missing' >&2; exit 66; }
  stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
  stage="/opt/nadzorium/var/material-stage-$stamp"
  cpu_host=${DEMO_HOST:-hk-ru}
  ssh "${SSHO[@]}" "$cpu_host" "install -d -m 755 $stage"
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$2" -cf - . | ssh "${SSHO[@]}" "$cpu_host" "tar --no-same-owner -xmf - -C $stage"
  scp "${SSHO[@]}" -q scripts/runner/publish-material-release.mjs "$cpu_host:$stage/publish-material-release.mjs"
  ssh "${SSHO[@]}" "$cpu_host" "flock /opt/nadzorium/var/guide-publish.lock node $stage/publish-material-release.mjs $stage"
  exit
fi
gets=(); wip=0; refresh_origin=1
while :; do
  case "${1:-}" in
    --no-origin-refresh) refresh_origin=0; shift ;;
    --get) gets+=("$2"); shift 2 ;;
    --wip) wip=1; shift ;;
    --light) export W1_LIGHT=1; shift ;;
    --lane) export W1_LANE=$2; shift 2 ;;
    --wave) export W1_WAVE=$2; shift 2 ;;
    --as-root) export W1_AS_ROOT=1; shift ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { sed -n 2,16p "$0"; exit 64; }
# T-183: dev-стенд ветки — scripts/runner/stand.sh; ветка по умолчанию — текущая, иначе её коммит из origin
if [ "${1:-}" = stand ]; then
  action=${2:?stand up|down|logs|status [ветка]}; shift 2
  if [ -n "${1:-}" ] && [ "${1#-}" = "$1" ] && git rev-parse -q --verify "origin/$1^{commit}" >/dev/null; then
    branch=$1; shift; git fetch -q origin "$branch"; sha=$(git rev-parse "origin/$branch")
  else
    branch=$(git rev-parse --abbrev-ref HEAD); sha=$(git rev-parse HEAD)
  fi
  refresh_main
  refs=("$sha:refs/heads/$branch"); [ "$branch" = main ] || refs+=("origin/main:refs/heads/main")
  [ "$action" != up ] || retry git push -q -f "$HOST:$R/repo.git" "${refs[@]}"
  retry scp "${SSHO[@]}" -q scripts/runner/stand.sh "$HOST:$R/bin/stand-${sha:0:12}.sh"
  exec ssh -o ServerAliveInterval=30 "$HOST" "W1_RUNNER_HOST=$HOST bash $R/bin/stand-${sha:0:12}.sh $action $(printf '%q' "$branch") $sha $(printf '%q ' "$@")"
fi
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" != HEAD ] || branch="detached-$(git rev-parse --short HEAD)"
sha=$(git rev-parse HEAD)
[ "$wip" = 1 ] || git diff --quiet HEAD -- . ':!.claude' || echo "remote-run: есть незакоммиченное — раннер проверит коммит ${sha:0:12} без него (для отладки — --wip)" >&2
# ветка и main (гейту нужен origin/main для стража настроек)
refresh_main
refs=("$sha:refs/heads/$branch"); [ "$branch" = main ] || refs+=("origin/main:refs/heads/main")
retry git push -q -f "$HOST:$R/repo.git" "${refs[@]}"
# серверная половина всегда из этого коммита: правка run.sh едет вместе с веткой
runner="$R/bin/run-${sha:0:12}.sh"
retry scp "${SSHO[@]}" -q scripts/runner/run.sh "$HOST:$runner"
if [ "$wip" = 1 ]; then
  # дерево как есть: отслеживаемые и новые файлы без игнорируемых (node_modules, .venv, var); удалённые локально удаляются и там
  branch="$branch.wip"
  wt="$R/wt/u/$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '_')"   # --wip — всегда задача w1run (wt/u)
  ssh "${SSHO[@]}" "$HOST" "[ -d $wt/.git ] || runuser -u w1run -- git clone -q file://$R/repo.git $wt"
  # tar поверх ssh (openrsync мака не знает --files-from0); манифест — чтобы удалённое на маке удалилось и на раннере
  git ls-files -co --exclude-standard > .wip-files
  { cat .wip-files; echo .wip-files; } | tr '\n' '\0' | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -cf - | ssh "${SSHO[@]}" "$HOST" "cd $wt && runuser -u w1run -- tar -xmf - && \
    runuser -u w1run -- git ls-files -co --exclude-standard | grep -vxF -f .wip-files | grep -vx .wip-files | tr '\\n' '\\0' | xargs -0 -r rm -f --"
  rm -f .wip-files
  sha=WIP
fi
log="$R/logs/$(date +%Y%m%d-%H%M%S)-$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '_')-$$.log"
# задача на сервере — отдельный сервис systemd (w1job-…): обрыв SSH её не убивает (28.09: три прогона умерли вместе с
# сессией при давлении памяти на сервере). Лог — файлом, мак забирает его короткими подключениями и переподключается сам.
jid="$(date +%H%M%S)-$$"
# ветка и команда — в base64: кавычки и маски в команде не ломают вложенный bash -c на сервере
b64b=$(printf '%s' "$branch" | base64 | tr -d '\n'); b64c=$(printf '%s' "$*" | base64 | tr -d '\n')
set +e
retry ssh -o ConnectTimeout=20 "$HOST" "systemd-run --quiet --collect --unit=w1job-$jid \
  --setenv=W1_LIGHT=${W1_LIGHT:-} --setenv=W1_LANE=${W1_LANE:-} --setenv=W1_WAVE=${W1_WAVE:-} --setenv=W1_AS_ROOT=${W1_AS_ROOT:-} \
  bash -c 'bash $runner \"\$(echo $b64b | base64 -d)\" $sha \"\$(echo $b64c | base64 -d)\" > $log 2>&1; echo RC=\$? >> $log'"
echo "remote-run: задача w1job-$jid (снять: ssh $HOST systemctl stop w1job-$jid)"
seen=0; rc=""; lost=0; polls=0
while [ -z "$rc" ]; do
  if out=$(ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 "$HOST" "tail -n +$((seen + 1)) $log 2>/dev/null; systemctl is-active --quiet w1job-$jid && echo __ALIVE__; true"); then
    lost=0
    alive=0; case "$out" in *__ALIVE__) alive=1; out=${out%__ALIVE__}; out=${out%$'\n'} ;; esac
    if [ -n "$out" ]; then printf '%s\n' "$out"; seen=$((seen + $(printf '%s\n' "$out" | wc -l))); fi
    rc=$(printf '%s\n' "$out" | sed -n 's/^RC=//p' | tail -1)
    if [ -z "$rc" ] && [ "$alive" = 0 ]; then
      sleep 3; rc=$(ssh -o ConnectTimeout=20 "$HOST" "sed -n 's/^RC=//p' $log | tail -1")
      [ -n "$rc" ] || { echo "remote-run: задача w1job-$jid завершилась без кода — считать красным" >&2; rc=99; }
    fi
  else
    lost=$((lost + 1)); echo "remote-run: связь с раннером потеряна ($lost), задача продолжается, переподключаюсь" >&2
    [ "$lost" -lt 60 ] || { echo "remote-run: раннер недоступен 10 минут — результат неизвестен" >&2; rc=255; }
  fi
  # Short checks used to wait up to ten seconds just to deliver their result.
  # Keep feedback quick initially, then reduce polling for long-running gates.
  polls=$((polls + 1))
  if [ -z "$rc" ]; then
    if [ "$polls" -le 30 ]; then sleep 2; else sleep 5; fi
  fi
done
set -e
slug=$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '_')
# лёгкий прогон (не --wip) шёл в worktree «<ветка>.light» — отчёты забираются оттуда (так же, как в run.sh)
[ -n "${W1_LIGHT:-}" ] && [ "$wip" != 1 ] && slug="$slug.light"
for g in ${gets[@]+"${gets[@]}"}; do
  mkdir -p "$(dirname "$g")"
  base="$R/wt/u"; [ -n "${W1_AS_ROOT:-}" ] && base="$R/wt"
  rsync -a -e "ssh -o ConnectTimeout=20 -o ServerAliveInterval=15" "$HOST:$base/$slug/$g" "$(dirname "$g")/" && echo "remote-run: забрал $g" || echo "remote-run: нет $g на раннере" >&2
done
echo "remote-run: код $rc · лог $HOST:$log"
exit $rc
