#!/usr/bin/env bash
# NFR-UKEP: поддельный cryptcp КриптоПро для тестов провайдера cryptopro. Пишет аргументы и права каталога входного
# файла в $FAKE_CRYPTCP_LOG, подпись делает openssl ключом $FAKE_CRYPTCP_KEY тестовой PKI, чтобы круг «подписал → проверил» замкнулся.
# FAKE_CRYPTCP_FAIL=1 — отказ, как у cryptcp без лицензии или с неверным отпечатком.
set -euo pipefail
in="${*: -2:1}"; out="${*: -1}"
{ printf '%s\n' "$@"; stat -c '%a' "$(dirname "$in")" 2>/dev/null || stat -f '%Lp' "$(dirname "$in")"; } > "$FAKE_CRYPTCP_LOG"
if [ "${FAKE_CRYPTCP_FAIL:-0}" = 1 ]; then echo "Error: Certificate not found: $in" >&2; exit 2; fi
openssl cms -sign -binary -outform DER -md sha256 -nosmimecap -in "$in" -signer "$FAKE_CRYPTCP_CERT" -inkey "$FAKE_CRYPTCP_KEY" -out "$out"
