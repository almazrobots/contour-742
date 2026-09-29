#!/bin/sh
# NFR-CRYPTO (ТЗ 12.3-01): расшифровка копии, сделанной at-rest-encrypt.sh, — для восстановления и учений.
# Закрытый ключ получателя на сервере не хранится: его приносят на время восстановления.
#
#   at-rest-decrypt.sh -r получатель.pem -k закрытый.key -o OUT IN
#   (или AT_REST_RECIPIENT_CERT, AT_REST_RECIPIENT_KEY в окружении)
#
# Части расшифровываются по MANIFEST по порядку, каждая сверяется с SHA-256 открытой части, всё вместе — с plain.sha256.
# OUT появляется только целиком и проверенным (временный файл рядом и mv); при ошибке прежний OUT не тронут.
# Память — ~5,5 × размера части (openssl cms -decrypt читает сообщение целиком): часть 64 МиБ → ~360 МБ.
# Коды: 0 — готово; 1 — ошибка (ключ, тег GCM, хеш, ввод-вывод); 2 — неверный вызов.
set -eu

me=at-rest-decrypt
die() { code=$1; shift; printf '%s: %s\n' "$me" "$*" >&2; exit "$code"; }

cert=${AT_REST_RECIPIENT_CERT:-}
key=${AT_REST_RECIPIENT_KEY:-}
out=
while getopts r:k:o: opt; do
  case $opt in
    r) cert=$OPTARG ;;
    k) key=$OPTARG ;;
    o) out=$OPTARG ;;
    *) die 2 "вызов: $me -r получатель.pem -k закрытый.key -o OUT IN" ;;
  esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || die 2 "ждём один каталог копии IN"
in=$1
[ -n "$out" ] || die 2 "не задан -o OUT"
[ -n "$cert" ] && [ -r "$cert" ] || die 1 "сертификат получателя не задан или не читается (-r или AT_REST_RECIPIENT_CERT)"
[ -n "$key" ] && [ -r "$key" ] || die 1 "закрытый ключ получателя не задан или не читается (-k или AT_REST_RECIPIENT_KEY)"
[ -f "$in/MANIFEST" ] && [ -f "$in/plain.sha256" ] || die 1 "$in — не копия at-rest-encrypt (нет MANIFEST или plain.sha256)"

parent=$(dirname -- "$out")
tmp="$parent/.$(basename -- "$out").tmp-$$"
work="$tmp.d"
trap 'rm -rf "$tmp" "$work"' EXIT
trap 'exit 1' HUP INT TERM
(umask 077 && : >"$tmp" && mkdir "$work") || die 1 "не создать временный файл в $parent"

# сбой openssl dgst даёт пустой хеш — он не совпадёт ни с одним ожидаемым, отказ неизбежен
hash_file() { openssl dgst -sha256 -r <"$1" | cut -d' ' -f1; }
n=0
while read -r want part; do
  # имя части — только part-NNNNNN.cms: MANIFEST не должен вывести чтение за пределы IN
  case $part in part-[0-9][0-9][0-9][0-9][0-9][0-9].cms) ;; *) die 1 "MANIFEST: недопустимое имя части «${part}»" ;; esac
  [ -f "$in/$part" ] || die 1 "нет части $part"
  # в отдельный файл: при несошедшемся теге GCM openssl может успеть вывести байты — в OUT они не попадут
  openssl cms -decrypt -binary -inform DER -in "$in/$part" -recip "$cert" -inkey "$key" -out "$work/p" 2>"$work/err" ||
    die 1 "часть $part не расшифрована: $(head -c 300 "$work/err" | tr '\n' ' ')"
  [ "$(hash_file "$work/p")" = "$want" ] || die 1 "SHA-256 части $part не совпал с MANIFEST"
  cat "$work/p" >>"$tmp"
  n=$((n + 1))
done <"$in/MANIFEST"
[ "$n" -ge 1 ] || die 1 "MANIFEST пуст"
[ "$(hash_file "$tmp")" = "$(cut -d' ' -f1 <"$in/plain.sha256")" ] || die 1 "SHA-256 открытого текста не совпал с plain.sha256 — части потеряны, лишние или переставлены"
mv -f "$tmp" "$out" || die 1 "не переименовать в $out"
