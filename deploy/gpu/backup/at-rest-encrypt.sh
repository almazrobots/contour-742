#!/bin/sh
# NFR-CRYPTO (ТЗ 12.3-01): фильтр шифрования резервных копий и WAL «в покое» — stdin → каталог OUT.
# CMS AuthEnvelopedData, AES-256-GCM (RFC 5083/5084) на СЕРТИФИКАТ получателя: на сервере только открытый ключ,
# закрытый хранится вне сервера — утечка сервера не раскрывает уже сделанные копии.
#
#   at-rest-encrypt.sh -r получатель.pem -o OUT [-c KiB] < открытый_текст
#   (или AT_REST_RECIPIENT_CERT, AT_REST_CHUNK_KB в окружении)
#
# Результат — каталог OUT, появляется атомарно (временный каталог рядом и mv), при любой ошибке не остаётся ничего:
#   part-000000.cms …  — части по ≤ 64 МиБ открытого текста, каждая — отдельное сообщение CMS со своим ключом CEK;
#   MANIFEST           — «<sha256 открытой части>  <имя части>» по порядку;
#   plain.sha256       — SHA-256 всего открытого текста: повторная архивация WAL сравнивается по нему (у GCM со
#                        случайным CEK шифротекст каждый раз другой, байты сравнивать бессмысленно).
# Почему части: openssl cms -encrypt -stream идёт потоком (память постоянна, ~6 МБ), а -decrypt читает сообщение
# целиком — ~5,5 × размера в памяти (замер на OpenSSL 3.6: 100 МБ → 560 МБ). Части по 64 МиБ держат восстановление
# в ~360 МБ при любом размере копии. WAL-сегмент (16 МБ) — одна часть.
# Открытый текст на диск не пишется: части режутся dd из потока, хеши считаются через именованные каналы.
# Коды: 0 — готово; 1 — ошибка (сертификат, openssl, ввод-вывод); 2 — неверный вызов; 3 — OUT уже существует.
set -eu
# pipefail не используется: в dash (/bin/sh Debian-образов) его нет. Сбой любого звена конвейера пишется в файл
# $tmp/.failed и проверяется после — тихого обрыва потока (и «успешной» усечённой копии) не бывает.

me=at-rest-encrypt
die() { code=$1; shift; printf '%s: %s\n' "$me" "$*" >&2; exit "$code"; }

cert=${AT_REST_RECIPIENT_CERT:-}
out=
chunk_kb=${AT_REST_CHUNK_KB:-65536}
# GNU dd (Linux, сервер) из канала засчитывает короткое чтение как целый блок: без iflag=fullblock часть выходит
# короче заданной, и частей больше (T-181: раннер 158.255.3.179 — 4 части вместо 3). BSD dd (мак) флага не знает.
FULL=""; dd --version >/dev/null 2>&1 && FULL="iflag=fullblock"
while getopts r:o:c: opt; do
  case $opt in
    r) cert=$OPTARG ;;
    o) out=$OPTARG ;;
    c) chunk_kb=$OPTARG ;;
    *) die 2 "вызов: $me -r получатель.pem -o OUT [-c KiB] < данные" ;;
  esac
done
[ -n "$out" ] || die 2 "не задан -o OUT"
[ -n "$cert" ] || die 1 "не задан сертификат получателя (-r или AT_REST_RECIPIENT_CERT) — шифровать не на что"
[ -r "$cert" ] || die 1 "сертификат получателя $cert не читается"
case $chunk_kb in '' | *[!0-9]*) die 2 "-c $chunk_kb: ждём целое число KiB" ;; esac
[ "$chunk_kb" -ge 1 ] || die 2 "-c: ждём ≥ 1 KiB"
# закрытого ключа на сервере быть не должно: файл с ним вместо сертификата — ошибка развёртывания, а не удобство
if grep -q 'PRIVATE KEY' "$cert"; then die 1 "$cert содержит закрытый ключ — на сервере нужен только сертификат получателя"; fi
openssl x509 -in "$cert" -noout 2>/dev/null || die 1 "$cert — не сертификат X.509 (PEM)"
# RSA — только OAEP (PKCS#1 v1.5 уязвим к атаке Блейхенбахера); EC — ECDH по умолчанию
keyopt=
if openssl x509 -in "$cert" -noout -text 2>/dev/null | grep -q 'Public Key Algorithm: rsaEncryption'; then keyopt='-keyopt rsa_padding_mode:oaep'; fi

[ ! -e "$out" ] || die 3 "$out уже существует — не перезаписываю"
parent=$(dirname -- "$out")
[ -d "$parent" ] || die 1 "каталога $parent нет"
tmp="$parent/.$(basename -- "$out").tmp-$$"
mkdir -m 700 "$tmp" || die 1 "не создать временный каталог в $parent"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM

# размер чтения dd: 64 KiB (ёмкость канала) — части близки к заданному размеру и из файла, и из канала
if [ $((chunk_kb % 64)) -eq 0 ]; then bs=65536; count=$((chunk_kb / 64)); else bs=1024; count=$chunk_kb; fi
EMPTY=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
hash_of() { cut -d' ' -f1 <"$1"; } # openssl dgst -r: «<hex> *stdin»

mkfifo "$tmp/.all"
openssl dgst -sha256 -r <"$tmp/.all" >"$tmp/.all.sha" &
all_pid=$!
exec 3>"$tmp/.all" # держим писателя открытым между частями: иначе хеш всего потока закончится на первой части

i=0
: >"$tmp/MANIFEST"
# shellcheck disable=SC2086 # keyopt — два слова намеренно; -keyopt действует на предшествующий -recip
while :; do
  part=$(printf 'part-%06d.cms' "$i")
  # первый байт части — заранее: пусто — конец потока. openssl cms -encrypt -stream на пустом вводе не пишет
  # сообщение («Error writing CMS output»), поэтому пустую часть не отдаём ему вовсе. Байт — в переменной (восьмерично),
  # не в файле: открытый текст на диск не попадает
  first=$({ dd bs=1 count=1 2>/dev/null || echo "чтение ввода" >>"$tmp/.failed"; } | od -An -to1 | tr -d ' \n')
  [ ! -s "$tmp/.failed" ] || die 1 "сбой: $(cat "$tmp/.failed")"
  if [ -z "$first" ]; then
    [ "$i" -eq 0 ] || break
    # пустой ввод — одна пустая часть; без -stream пустое сообщение openssl собирает
    openssl cms -encrypt -binary -aes-256-gcm -outform DER -recip "$cert" $keyopt -out "$tmp/$part" </dev/null ||
      die 1 "openssl cms -encrypt не удался (пустой ввод)"
    printf '%s  %s\n' "$EMPTY" "$part" >>"$tmp/MANIFEST"
    break
  fi
  mkfifo "$tmp/.part"
  openssl dgst -sha256 -r <"$tmp/.part" >"$tmp/.part.sha" &
  part_pid=$!
  { { printf '%b' "\\0$first" && dd bs="$bs" count="$count" $FULL 2>/dev/null; } || echo "чтение ввода" >>"$tmp/.failed"; } |
    { tee "$tmp/.part" /dev/fd/3 || echo "tee" >>"$tmp/.failed"; } |
    openssl cms -encrypt -binary -stream -aes-256-gcm -outform DER -recip "$cert" $keyopt -out "$tmp/$part" ||
    die 1 "openssl cms -encrypt не удался (часть $part)"
  [ ! -s "$tmp/.failed" ] || die 1 "сбой конвейера части $part: $(cat "$tmp/.failed")"
  wait "$part_pid" || die 1 "хеш части $part не посчитан"
  rm -f "$tmp/.part"
  printf '%s  %s\n' "$(hash_of "$tmp/.part.sha")" "$part" >>"$tmp/MANIFEST"
  i=$((i + 1))
done
exec 3>&-
wait "$all_pid" || die 1 "хеш открытого текста не посчитан"
rm -f "$tmp/.all" "$tmp/.part.sha"
hash_of "$tmp/.all.sha" >"$tmp/plain.sha256"
rm -f "$tmp/.all.sha"

# на диск до переименования: успех archive_command разрешает PostgreSQL удалить сегмент
sync "$tmp"/* 2>/dev/null || sync
[ ! -e "$out" ] || die 3 "$out появился во время шифрования — не перезаписываю"
mv "$tmp" "$out" || die 1 "не переименовать $tmp в $out"
trap - EXIT
