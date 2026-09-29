#!/bin/sh
# NFR-UKEP (T-137): тестовая пара для коннектора подписи запросов к ИАИС «РиН», пока нет сертифицированного СКЗИ.
# Это НЕ УКЭП: самоподписанный ECDSA P-256, в имени — пометка. Использование: scripts/ukep-test-key.sh <каталог>
# Кладёт <каталог>/ukep.crt (0444) и <каталог>/ukep.key (0400); существующие файлы не перезаписывает.
set -eu
dir=${1:?каталог для ukep.crt и ukep.key}
[ -e "$dir/ukep.key" ] && { echo "ukep-test-key: $dir/ukep.key уже есть — не перезаписываю" >&2; exit 1; }
mkdir -p "$dir"
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 \
  -subj "/CN=Inspector AI - test signing key (NOT UKEP)/O=Inspector AI" \
  -keyout "$dir/ukep.key" -out "$dir/ukep.crt" >/dev/null 2>&1
chmod 0400 "$dir/ukep.key"
chmod 0444 "$dir/ukep.crt"
echo "ukep-test-key: $dir/ukep.crt, $dir/ukep.key — неквалифицированная подпись (UKEP_MODE=pem, UKEP_NONQUALIFIED=1)"
