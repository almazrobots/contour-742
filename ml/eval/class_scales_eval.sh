#!/usr/bin/env bash
# Строка качества CMP-04 (T-172): генерация набора и оценка настоящим evaluateClassParam, из корня репозитория.
#   ml/eval/class_scales_eval.sh <clean|dev|holdout|h2> <seed> <имя> [n=100] [main]
# main — тот же набор путём main (без паспортов W1, лексический evaluate): правило включения паспорта
# Выход: var/class-scales/<имя>.jsonl, var/class-scales/<имя>-q.json и таблица в stdout.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
set_=$1 seed=$2 name=$3 n=${4:-100} path=${5:-passport}
out=var/class-scales/$name.jsonl
mkdir -p var/class-scales
case $set_ in
  clean) (cd ml && .venv/bin/python -m eval.class_scales_bench --n "$n" --seed "$seed" --out "../$out") ;;
  h2) (cd ml && .venv/bin/python -m eval.class_scales_holdout2 --n "$n" --seed "$seed" --out "../$out") ;;
  dev | holdout) (cd ml && .venv/bin/python -m eval.class_scales_adversarial --set "$set_" --n "$n" --seed "$seed" --out "../$out") ;;
  *) echo "набор: clean | dev | holdout | h2" >&2; exit 64 ;;
esac
if [ "$path" = main ]; then
  (cd ml && .venv/bin/python -m eval.class_scales_main "../$out" "../var/class-scales/$name-main.jsonl")
  cd apps/api && npx tsx scripts/class-scales-eval.ts "../../var/class-scales/$name-main.jsonl" --json "../../var/class-scales/$name-main-q.json" --path main
else
  cd apps/api && npx tsx scripts/class-scales-eval.ts "../../$out" --json "../../var/class-scales/$name-q.json"
fi
