#!/usr/bin/env bash
# Серверная половина scripts/remote-run.sh (T-181): замок, чекаут коммита в свой worktree, запуск команды с ограничением
# CPU и приоритета. GPU не используется (CUDA_VISIBLE_DEVICES пуст): карта занята разбором T-165.
#   run.sh <ветка> <sha> <команда…>
set -uo pipefail
R=${W1_ROOT:-/opt/w1-gate}
branch=$1; sha=$2; shift 2
slug=$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '_')
export PATH="$R/tools/bin:$R/tools/node/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 \
  npm_config_store_dir="$R/cache/pnpm" UV_CACHE_DIR="$R/cache/uv" TRIVY_CACHE_DIR="$R/cache/trivy" CUDA_VISIBLE_DEVICES="" \
  W1_REMOTE=1 HEAVY_NO_GUARD=1
# волна (W1/W2/W3 разрабатываются параллельно, 28.09): ключ --wave или префикс ветки feat/w2-…, feat/w3-…; иначе w1.
# У волны свои ядра heavy (/opt/w1-gate/cpus.<волна>, «off» — тяжёлое закрыто) и свои замки.
wave=${W1_WAVE:-}
[ -n "$wave" ] || case "$branch" in *w2-*|*/w2/*) wave=w2 ;; *w3-*|*/w3/*) wave=w3 ;; *) wave=w1 ;; esac
cpus=$(cat "$R/cpus.$wave" 2>/dev/null || cat "$R/cpus" 2>/dev/null || echo 24-31)

# фаза задачи (OWASP-0196): после замка скрипт перезапускает сам себя от пользователя w1run — чекаут, зависимости и команда
# идут не от root; замки, ядра и группа памяти выставлены корневой фазой
if [ -n "${W1_JOB:-}" ]; then
  cpus=$W1_JOB_CPUS; nice_lvl=$W1_JOB_NICE
# один тяжёлый прогон на сервер (правило №0): ждём замок, очередь видна в логе
elif [ -n "${W1_LIGHT:-}" ]; then
  # лёгкое — без очереди: общие ядра лёгкого (cpus.light), самый низкий приоритет; замок на ветку, чтобы не драться за worktree
  cpus=$(cat "$R/cpus.light" 2>/dev/null || echo 28-31); nice_lvl=$(cat "$R/nice.light" 2>/dev/null || echo 19)
  exec 9>"$R/lock.$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '_')"; flock 9
else
  nice_lvl=$(cat "$R/nice.$wave" 2>/dev/null || echo 15)
  # полоса: heavy — мутации и гейт; другие (stand) — своя очередь, чтобы сборка стенда не ждала Stryker
  lane=$(printf '%s' "${W1_LANE:-heavy}" | tr -c 'A-Za-z0-9_-' '_')
  if [ "$lane" = heavy ] && [ "$cpus" = off ]; then
    echo "runner: полоса heavy волны $wave закрыта (cpus.$wave = off: ядра заняты разбором T-165) — доступны --light и --lane stand"; exit 75
  fi
  if [ "$lane" = heavy ]; then
    # два слота heavy (решение владельца 28.09): половины выделенных ядер, первый свободный; заняты оба — ждём любой
    lo=${cpus%-*}; hi=${cpus#*-}; mid=$(( (lo + hi + 1) / 2 ))
    slots=("a:$lo-$((mid - 1))" "b:$mid-$hi")
    said=0
    while :; do
      for sl in "${slots[@]}"; do
        lk="$R/lock.$wave.heavy.${sl%%:*}"
        exec 9>"$lk"
        # слот b — приоритет из /opt/w1-gate/nice.b (19, пока идёт разбор T-165 и лёгкое на тех же ядрах; иначе 15)
        if flock -n 9; then cpus=${sl#*:}; [ "${sl%%:*}" = b ] && nice_lvl=$(cat "$R/nice.b" 2>/dev/null || echo "$nice_lvl"); break 2; fi
        exec 9>&-
      done
      [ "$said" = 1 ] || { echo "runner: оба слота heavy заняты ($(cat "$R"/lock.$wave.heavy.*.cmd 2>/dev/null | tr '\n' ';')), жду"; said=1; }
      sleep 5
    done
  else
    lk="$R/lock.$lane"   # stand и прочие полосы — общие на сервер (stand.sh T-183 берёт тот же файл)
    exec 9>"$lk"
    if ! flock -n 9; then echo "runner: жду замок полосы $lane (держит: $(cat "$lk.cmd" 2>/dev/null))"; flock 9; fi
  fi
  echo "$branch@${sha:0:12}: $*" > "$lk.cmd"
  trap 'rm -f "$lk.cmd"' EXIT
fi

if [ -z "${W1_JOB:-}" ]; then
  # память (28.09, OOM на общем сервере): у волны своя группа runner-<волна>.slice (W1 — 16 ГБ, W2/W3 — 12 ГБ, без свопа),
  # у задачи — свой потолок (heavy 7 ГБ, light 3 ГБ) на всё: чекаут, зависимости, команду
  mem=$(cat "$R/memory.$wave.heavy" 2>/dev/null || echo 7G)
  [ -n "${W1_LIGHT:-}" ] && mem=$(cat "$R/memory.$wave.light" 2>/dev/null || echo 3G)
  [[ "$mem" =~ ^[1-9][0-9]*[MG]$ ]] || { echo 'runner: invalid memory limit'; exit 64; }
  [[ "$nice_lvl" =~ ^[0-9]+$ ]] && [ "$nice_lvl" -le 19 ] || { echo 'runner: invalid nice level'; exit 64; }
  io_args=(-c3); [ "$nice_lvl" -gt 5 ] || io_args=(-c2 -n4)
  runas=w1run
  # root — только по явному --as-root (Docker полного гейта, пространство монтирования замера T-180); запуск виден в логе
  [ -n "${W1_AS_ROOT:-}" ] && { runas=root; echo "runner: запуск от root (--as-root)"; }
  t0=$(date +%s)
  job=(env W1_JOB=1 W1_JOB_CPUS="$cpus" W1_JOB_NICE="$nice_lvl" W1_WAVE="$wave" HOME="$R/home/$runas" bash "$0" "$branch" "$sha" "$@")
  if command -v systemd-run >/dev/null && systemctl cat "runner-$wave.slice" >/dev/null 2>&1; then
    systemd-run --quiet --scope --slice="runner-$wave.slice" -p MemoryMax=$mem -p MemorySwapMax=0 --uid="$runas" --gid="$runas" \
      taskset -c "$cpus" nice -n "$nice_lvl" ionice "${io_args[@]}" "${job[@]}"
  else
    taskset -c "$cpus" nice -n "$nice_lvl" ionice "${io_args[@]}" runuser -u "$runas" -- "${job[@]}"
  fi
  rc=$?
  echo "runner: код $rc · $(( $(date +%s) - t0 )) с"
  exit $rc
fi

# лёгкое — в своём worktree «<ветка>.light»: иначе его git clean стирает файлы, которые в том же каталоге сейчас
# создаёт гейт или мутации этой ветки (28.09: гейт main потерял фикстуры mTLS — 16 красных тестов)
[ -n "${W1_LIGHT:-}" ] && [ "$sha" != WIP ] && slug="$slug.light"
# владельцы не смешиваются (ревью безопасности 28.09): задачи w1run — в wt/u и cache/u, root (--as-root и старые run.sh) —
# в wt и cache; root никогда не выполняет git в каталоге, который может изменить w1run (хуки и .git/config)
if [ "$(id -u)" != 0 ]; then wt="$R/wt/u/$slug"; export npm_config_store_dir="$R/cache/u/pnpm" UV_CACHE_DIR="$R/cache/u/uv"; else wt="$R/wt/$slug"; fi
if [ ! -d "$wt/.git" ] && [ ! -f "$wt/.git" ]; then
  git clone -q "file://$R/repo.git" "$wt"   # file:// — штатный протокол: не читает временные каталоги идущего push
fi
cd "$wt"
git fetch -q origin "+refs/heads/*:refs/remotes/origin/*"
if [ "$sha" = WIP ]; then
  echo "runner: WIP — рабочее дерево с мака, не коммит; для гейта и отчётов не годится"
else
# -f: генераторы прошлого прогона (pnpm trace и др.) оставляют изменённые отслеживаемые файлы — они не должны мешать чекауту
git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "runner: нет коммита $sha в репо раннера — сначала push"; exit 2; }
out=$(git checkout -q -f --detach "$sha" 2>&1) || { echo "runner: git checkout $sha не удался: $out"; exit 2; }
# чистое дерево коммита; зависимости и venv остаются между прогонами (кэш)
# отчёты и кэши мутаций переживают прогон: Stryker --incremental и mutmut берут результаты по неизменённому коду
git clean -qfdx -e node_modules -e '**/node_modules' -e ml/.venv -e ml/mutants -e ml/.mutmut-cache -e apps/api/.stryker-tmp -e apps/api/reports
git reset -q --hard "$sha"
fi
pnpm install --frozen-lockfile --prefer-offline >"$HOME/pnpm-$slug.log" 2>&1 || { tail -30 "$HOME/pnpm-$slug.log"; exit 3; }

# ML venv — до команды: pnpm test поднимает сервис ML из ml/.venv (e2e), а гейт синхронизирует venv только после pnpm test
( cd ml && uv sync --locked --inexact --python 3.12 --extra dev --extra semantic -q ) || { echo "runner: uv sync не прошёл"; exit 4; }

# heavy.sh — замок мака; здесь его роль у flock, поэтому префикс снимается
[ "${1:-}" = "scripts/heavy.sh" ] && shift
# потоков на прогон — по ядрам слота: Stryker --concurrency "$W1_THREADS", mutmut --max-children "$W1_THREADS"
export W1_THREADS=$(( ${cpus#*-} - ${cpus%-*} + 1 ))
echo "runner: $(hostname) · волна $wave · ядра $cpus · $(id -un) · ${sha:0:12} · $*"
echo 500 > /proc/self/oom_score_adj 2>/dev/null   # при нехватке памяти ядро убивает наши процессы раньше разбора T-165
exec bash -o pipefail -c "$*"
