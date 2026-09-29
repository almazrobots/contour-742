#!/usr/bin/env bash
# Private migration rehearsal on a consistent copy; never upgrades the live DB here.
# Run via remote-run --lane verification --as-root.
set -euo pipefail
code=$(git rev-parse HEAD)
root=/opt/w1-gate/eval/verification/review-database
mkdir -p "$root"
chmod 700 "$root"
export ROOT_REVIEW="$root"
pg=${VERIFICATION_REVIEW_PG:?review PG container required}
[ "$pg" = nadzorium-verification-postgres-1 ] || { echo 'refusing a non-review container'; exit 64; }
if [ ! -e "$root/source.dump" ]; then
  docker exec -u postgres nadzorium-gpu-postgres-1 pg_dump -Fc -d inspector > "$root/source.dump.tmp"
  chmod 600 "$root/source.dump.tmp"
  mv "$root/source.dump.tmp" "$root/source.dump"
fi
if ! docker exec -u postgres "$pg" psql -d inspector -Atc "select to_regclass('inspector.schema_migrations') is not null" | grep -q t; then
  docker exec -i -u postgres "$pg" pg_restore --clean --if-exists -d inspector --exit-on-error < "$root/source.dump"
fi
# Compare the pinned source checksums before applying any migration.
docker exec -u postgres "$pg" psql -d inspector -Atc 'select version,checksum from inspector.schema_migrations order by version' > "$root/migrations-before.tsv"
python3 - <<'PY'
from pathlib import Path
import os,hashlib
root=Path(os.environ['ROOT_REVIEW'])
for line in (root/'migrations-before.tsv').read_text().splitlines():
    version,sha=line.split('|');path=next(Path('apps/api/src/db/migrations').glob(f'{int(version):04d}_*.sql'))
    if hashlib.sha256(path.read_bytes()).hexdigest()!=sha:raise RuntimeError(f'migration checksum mismatch {version}')
print('review: source migration checksums match')
PY
# Apply the actual SQL, as the dedicated schema owner; all changes in one transaction.
python3 - <<'PY'
from pathlib import Path
import os,hashlib
root=Path(os.environ['ROOT_REVIEW']);done={int(l.split('|')[0]) for l in (root/'migrations-before.tsv').read_text().splitlines()}
lines=['begin;set local role inspector_owner;set local search_path=inspector;select pg_advisory_xact_lock(hashtext(\'inspector:migrate\'));']
for path in sorted(Path('apps/api/src/db/migrations').glob('*.sql')):
    version=int(path.name.split('_')[0])
    if version in done:continue
    lines.extend([path.read_text(),f"insert into schema_migrations(version,name,checksum) values({version},'{path.name}','{hashlib.sha256(path.read_bytes()).hexdigest()}');"])
lines.append('commit;');(root/'upgrade.sql').write_text('\n'.join(lines));(root/'upgrade.sql').chmod(0o600)
PY
docker exec -i -u postgres "$pg" psql -d inspector -v ON_ERROR_STOP=1 < "$root/upgrade.sql" > "$root/upgrade.log" 2>&1
docker exec -u postgres "$pg" psql -d inspector -Atc 'select max(version) from inspector.schema_migrations; select count(*) from inspector.files;' | tr '\n' ' '
echo 'review: migration rehearsal complete; no live DB upgrade'
