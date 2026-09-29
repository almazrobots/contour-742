#!/usr/bin/env bash
# Генератор синтетических фикстур проверки подписи (OS-INSP-1.2.11–1.2.13). Только синтетика: УЦ, подписанты и документ
# выдуманы здесь же; закрытые ключи удаляются в конце — в репозиторий попадают сертификаты, документы и подписи.
# Запуск: bash apps/api/tests/fixtures/signature/gen.sh (нужен OpenSSL ≥ 3.4 с -not_before/-not_after и node + pkijs).
set -euo pipefail
cd "$(dirname "$0")"
OPENSSL="${OPENSSL:-openssl}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
rm -rf trust qualified && mkdir -p trust qualified

ca_ext() { printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > "$W/ca.ext"; }
ee_ext() { printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nsubjectKeyIdentifier=hash\n' > "$W/ee.ext"; }
ca_ext; ee_ext
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=none\n' > "$W/noaki.ext"
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=none\nauthorityKeyIdentifier=none\n' > "$W/noski.ext"
rsa() { "$OPENSSL" genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$W/$1.key" 2>/dev/null; }
ec() { "$OPENSSL" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$W/$1.key" 2>/dev/null; }
# корень: самоподписанный CA
root() { "$OPENSSL" req -utf8 -x509 -new -key "$W/$1.key" -subj "$2" -not_before 20250101000000Z -not_after 20450101000000Z \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -out "$1.crt"; }
# сертификат, выпущенный CA: имя, субъект, издатель, расширения, notBefore, notAfter
issue() { local k="$1"; [ -f "$W/$1.key" ] || k="${1%-cross}"; "$OPENSSL" req -utf8 -new -key "$W/$k.key" -subj "$2" -out "$W/$1.csr"
  "$OPENSSL" x509 -req -in "$W/$1.csr" -CA "$3.crt" -CAkey "$W/$3.key" -set_serial "0x$(openssl rand -hex 8)" \
    -extfile "$W/$4.ext" -not_before "$5" -not_after "$6" -out "$1.crt" 2>/dev/null; }
sign() { "$OPENSSL" cms -sign -binary -md sha256 -outform DER -nosmimecap -in doc.pdf -signer "$2.crt" -inkey "$W/$2.key" "${@:3}" -out "$1"; }

# документ — синтетический PDF
printf '%%PDF-1.4\n%% Синтетический акт для проверки подписи\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > doc.pdf
sed 's/Синтетический/Подменённый/' doc.pdf > doc-tampered.pdf

rsa qualified-root; root qualified-root "/CN=Тест аккредитованный УЦ/O=Инспектор ИИ тест"
rsa qualified-ica;  issue qualified-ica "/CN=Тест промежуточный УЦ" qualified-root ca 20250101000000Z 20440101000000Z
rsa signer-ukep;    issue signer-ukep "/CN=Иванов Иван (тест УКЭП)" qualified-ica ee 20260101000000Z 20400101000000Z
ec plain-root;      root plain-root "/CN=Тест корпоративный УЦ"
ec signer-unep;     issue signer-unep "/CN=Петров Пётр (тест УНЭП)/O=Тест корпорация" plain-root ee 20260101000000Z 20400101000000Z
rsa foreign-root;   root foreign-root "/CN=Чужой УЦ (тест)"
rsa signer-foreign; issue signer-foreign "/CN=Сидоров Сидор (чужой УЦ)" foreign-root ee 20260101000000Z 20400101000000Z
rsa signer-expired; issue signer-expired "/CN=Кузнецов Кузьма (истёк)" qualified-root ee 20200101000000Z 20210101000000Z

sign ukep.sig signer-ukep -certfile qualified-ica.crt   # УКЭП: цепочка через промежуточный УЦ
sign unep.p7s signer-unep                               # УНЭП: ECDSA P-256, корень доверенный, не аккредитованный
sign foreign.sig signer-foreign                         # корень не в доверенных
sign foreign-selfroot.sig signer-foreign -certfile foreign-root.crt # атака: подпись несёт свой корень внутри CMS
sign expired.sig signer-expired                         # signingTime (сейчас) позже notAfter
"$OPENSSL" cms -sign -binary -md sha256 -outform PEM -nosmimecap -in doc.pdf -signer signer-ukep.crt -inkey "$W/signer-ukep.key" -certfile qualified-ica.crt -out ukep-base64.sig # КриптоАРМ «Base64»
# варианты формата CMS: разные хеши, SKI вместо издателя и серийного номера, без атрибутов, без времени, без сертификата
for md in sha1 sha224 sha384 sha512; do
  sign "ukep-$md.sig" signer-ukep -certfile qualified-ica.crt -md "$md"        # rsaEncryption + digest $md
  sign "unep-$md.p7s" signer-unep -md "$md"                                   # ecdsa-with-$md
done
sign ukep-keyid.sig signer-ukep -certfile qualified-ica.crt -keyid           # SignerIdentifier = SubjectKeyIdentifier
sign ukep-noattr.sig signer-ukep -certfile qualified-ica.crt -noattr         # подпись прямо над документом, signedAttrs нет
sign ukep-notime.sig signer-ukep -certfile qualified-ica.crt -no_signing_time # атрибуты есть, signingTime нет
sign ukep-nocerts.sig signer-ukep -nocerts                                   # сертификата подписанта в CMS нет
sign ukep-pss.sig signer-ukep -certfile qualified-ica.crt -keyopt rsa_padding_mode:pss # RSASSA-PSS — не поддерживается
# атака: поддельный УЦ с тем же именем, что аккредитованный корень, но другим ключом
rsa fake-root; root fake-root "/CN=Тест аккредитованный УЦ/O=Инспектор ИИ тест"
rsa signer-fake; issue signer-fake "/CN=Самозванец (тест)" fake-root noaki 20260101000000Z 20400101000000Z # без AKI: издатель узнаётся только по имени
sign fake-root.sig signer-fake
# атака: владелец обычного (CA:FALSE) сертификата от аккредитованного УЦ выпускает себе «подписанта» с чужим именем
printf 'basicConstraints=critical,CA:FALSE\nsubjectKeyIdentifier=hash\n' > "$W/eenoku.ext" # без keyUsage: OpenSSL checkIssued его не отсечёт
rsa leaf-issuer; issue leaf-issuer "/CN=Злоумышленник (конечный сертификат УКЭП)" qualified-ica eenoku 20260101000000Z 20400101000000Z
rsa signer-by-leaf; issue signer-by-leaf "/CN=Иванов Иван (подделка)" leaf-issuer ee 20260101000000Z 20400101000000Z
cat leaf-issuer.crt qualified-ica.crt > "$W/by-leaf-chain.pem"
sign by-leaf.sig signer-by-leaf -certfile "$W/by-leaf-chain.pem"
rm -f leaf-issuer.crt signer-by-leaf.crt
# кросс-сертификат промежуточного УЦ: тот же ключ и имя, но выдан чужим корнем (тупиковая ветка цепочки)
issue qualified-ica-cross "/CN=Тест промежуточный УЦ" foreign-root ca 20250101000000Z 20440101000000Z
# цикл кросс-сертификатов X ↔ Y (ни один не доверенный): построение цепочки обязано завершиться
rsa cyc-x0; root cyc-x0 "/CN=Цикл X (тест)"; cp "$W/cyc-x0.key" "$W/cyc-x.key"
rsa cyc-y0; root cyc-y0 "/CN=Цикл Y (тест)"; cp "$W/cyc-y0.key" "$W/cyc-y.key"
issue cyc-x "/CN=Цикл X (тест)" cyc-y0 ca 20250101000000Z 20440101000000Z   # X выдан Y
issue cyc-y "/CN=Цикл Y (тест)" cyc-x0 ca 20250101000000Z 20440101000000Z   # Y выдан X
rsa cyc-leaf; issue cyc-leaf "/CN=Подписант в цикле (тест)" cyc-x0 ee 20260101000000Z 20400101000000Z
rm -f cyc-x0.crt cyc-y0.crt
# сертификат без SubjectKeyIdentifier — для CMS с -keyid, где он лежит первым
rsa noski; issue noski "/CN=Без SKI (тест)" qualified-ica noski 20260101000000Z 20400101000000Z
# Ed25519: подпись для вариантов с подменённым алгоритмом (gen-variants.mjs)
"$OPENSSL" genpkey -algorithm ED25519 -out "$W/signer-ed.key"; issue signer-ed "/CN=Эд Эдович (тест)" qualified-ica ee 20260101000000Z 20400101000000Z
sign "$W/ed.sig" signer-ed -certfile qualified-ica.crt
sign "$W/keyid-plain.sig" signer-ukep -keyid -certfile qualified-ica.crt
node gen-variants.mjs "$W/ed.sig" "$W/keyid-plain.sig"
rm -f signer-ed.crt

printf 'Это не подпись, а текст с расширением .sig\n' > garbage.sig
node gen-gost.mjs                                       # ГОСТ-OID в CMS (СКЗИ не нужен: подпись фиктивная)

cp qualified-root.crt plain-root.crt trust/
cp qualified-root.crt qualified/
rm -f qualified-root.crt plain-root.crt foreign-root.crt fake-root.crt
echo "фикстуры обновлены в $(pwd)"
