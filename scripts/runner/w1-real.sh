#!/usr/bin/env bash
# Стенд W1 на реальных объектах (T-180, OS-INSP-6.5.50) — обёртка на раннере: своё пространство монтирования, где корпус
# (/opt/corpus) и кэш разбора r4 (/opt/inspector/cache) смонтированы ТОЛЬКО НА ЧТЕНИЕ — запись туда падает EROFS, а не
# портит данные T-165. Кэш ML — overlay: нижний слой r4 (чтение), верхний — $W1_EVAL/ml-cache-upper (права 700).
# Копий и жёстких ссылок корпуса нет; монтирования живут, пока живёт процесс. Всё, что стенд пишет, — в $W1_EVAL.
#   scripts/remote-run.sh "scripts/runner/w1-real.sh run --object ALT-79B --codes M-023"
#   scripts/runner/w1-real.sh table|gold|mentions …   (python -m eval.w1_real из ml/ этого worktree)
set -euo pipefail
CORPUS=${W1_CORPUS:-/opt/corpus}
CACHE=${W1_R4_CACHE:-/opt/inspector/cache}
EVAL=${W1_EVAL:-/opt/w1-gate/eval/w1}
here=$(cd "$(dirname "$0")/../.." && pwd)

if [ "${1:-}" = table ]; then
  # таблица читает только агрегаты рабочего дерева — корпус и монтирования не нужны
  cd "$here/ml" && exec .venv/bin/python -m eval.w1_real "$@"
fi

if [ "${W1_REAL_NS:-}" != 1 ]; then
  [ "$(id -u)" = 0 ] || { echo "w1-real: нужен root раннера (монтирование только на чтение)"; exit 77; }
  W1_REAL_NS=1 exec unshare --mount --propagation private "$0" "$@"
fi

umask 077
mkdir -p "$EVAL" && chmod 700 "$EVAL"
mount --bind "$CORPUS" "$CORPUS" && mount -o remount,bind,ro "$CORPUS"
mount --bind "$CACHE" "$CACHE" && mount -o remount,bind,ro "$CACHE"
up="$EVAL/ml-cache-upper"; work="$EVAL/.ml-cache-work"; merged="$EVAL/.ml-cache-$$"
mkdir -p "$up" "$work" "$merged"
mount -t overlay overlay -o "lowerdir=$CACHE,upperdir=$up,workdir=$work" "$merged"
trap 'umount "$merged" 2>/dev/null; rmdir "$merged" 2>/dev/null' EXIT
# проверка до запуска (без пробной записи): точки монтирования корпуса и кэша r4 обязаны быть ro
for d in "$CORPUS/blobs" "$CACHE"; do
  case ",$(findmnt -no OPTIONS --target "$d")," in *,ro,*) ;; *) echo "w1-real: $d смонтирован не только на чтение — отказ"; exit 78 ;; esac
done
cd "$here/ml"
W1_ML_CACHE="$merged" W1_CORPUS="$CORPUS" W1_R4_CACHE="$CACHE" W1_EVAL="$EVAL" .venv/bin/python -m eval.w1_real "$@"
