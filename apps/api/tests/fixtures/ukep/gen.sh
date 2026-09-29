#!/usr/bin/env bash
# NFR-UKEP: тестовая PKI подписи запросов к «РиН». Только синтетика; создаётся при запуске тестов во временный каталог
# (ukep-signing.test.ts), в git не хранится — закрытый ключ в репозитории запрещён, даже тестовый (как tests/fixtures/mtls).
# Запуск вручную: bash apps/api/tests/fixtures/ukep/gen.sh <каталог>. Нужен openssl ≥ 3.0.
set -euo pipefail
OUT="${1:?каталог для фикстур}"
OPENSSL="${OPENSSL:-openssl}"
mkdir -p "$OUT/trust"
cd "$OUT"
printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > ca.ext
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nsubjectKeyIdentifier=hash\n' > ee.ext
rsa() { "$OPENSSL" genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$1.key" 2>/dev/null; }
ec() { "$OPENSSL" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1.key" 2>/dev/null; }
root() { "$OPENSSL" req -utf8 -x509 -new -key "$1.key" -subj "$2" -days 7300 -sha256 \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -out "$1.crt"; }
issue() { "$OPENSSL" req -utf8 -new -key "$1.key" -subj "$2" -out "$1.csr"
  "$OPENSSL" x509 -req -in "$1.csr" -CA "$3.crt" -CAkey "$3.key" -set_serial "0x$("$OPENSSL" rand -hex 8)" \
    -extfile "$4.ext" -days 3650 -sha256 -out "$1.crt" 2>/dev/null; rm -f "$1.csr"; }

rsa root;        root root "/CN=Тест УЦ подписи запросов/O=Инспектор ИИ тест"
rsa ica;         issue ica "/CN=Тест промежуточный УЦ подписи запросов" root ca
rsa signer-rsa;  issue signer-rsa "/CN=Инспектор ИИ (тест, RSA)" ica ee
ec signer-ec;    issue signer-ec "/CN=Инспектор ИИ (тест, ECDSA P-256)" root ee
rsa foreign-root; root foreign-root "/CN=Чужой УЦ (тест)"
rsa signer-foreign; issue signer-foreign "/CN=Самозванец (тест)" foreign-root ee
cp root.crt trust/root.crt
# ключи УЦ больше не нужны: остаются только сертификаты и ключи подписантов
rm -f root.key ica.key foreign-root.key ca.ext ee.ext
