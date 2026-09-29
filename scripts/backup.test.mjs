// NFR-BACKUP, NFR-RECOVERY (T-072, ТЗ 11, 12.8): лёгкие проверки бэкапа без Docker — конфиг gpu, архив WAL без
// перезаписи, чистка ровно старше 30 дней. Живое учение — scripts/restore-drill.sh (тяжёлое, через heavy.sh).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "deploy/gpu");
const pgDir = join(dir, "postgres");
const compose = parse(readFileSync(join(dir, "compose.yml"), "utf8"), { merge: true });
const conf = Object.fromEntries(readFileSync(join(pgDir, "backup.conf"), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
  .map((l) => { const m = /^([a-z_]+)\s*=\s*(.+)$/.exec(l); assert.ok(m, `backup.conf: строка «${l}» не «имя = значение»`); return [m[1], m[2]]; }));
const pgFlags = (cmd) => cmd.flatMap((a, i) => (cmd[i - 1] === "-c" ? [a] : []));
const sh = (script, args, env = {}) => spawnSync("bash", [join(pgDir, script), ...args], { env: { ...process.env, ...env }, encoding: "utf8" });

test("backup.conf: archive_mode=on, archive_timeout ≤ 900 (RPO ТЗ 11), archive_command — wal-archive.sh", () => {
  assert.equal(conf.archive_mode, "on");
  assert.equal(conf.wal_level, "replica");
  assert.ok(Number(conf.archive_timeout) > 0 && Number(conf.archive_timeout) <= 900, `archive_timeout=${conf.archive_timeout}`);
  assert.equal(conf.archive_command, "sh /etc/postgresql/wal-archive.sh %p %f");
  assert.doesNotMatch(Object.values(conf).join(" "), /['"]/, "значения без кавычек: флаг -c берёт их как есть");
});

test("gpu: postgres запущен с каждой строкой backup.conf, архив WAL и скрипт смонтированы", () => {
  const pg = compose.services.postgres;
  const flags = pgFlags(pg.command);
  for (const [k, v] of Object.entries(conf)) assert.ok(flags.includes(`${k}=${v}`), `postgres: нет -c ${k}=${v}`);
  assert.ok(pg.volumes.includes("pg-wal-archive:/wal-archive"));
  assert.ok(pg.volumes.includes("./postgres/wal-archive.sh:/etc/postgresql/wal-archive.sh:ro"));
  assert.ok(pg.volumes.includes("pg-run:/var/run/postgresql"), "сокет — в общем с pg-backup томе");
});

test("gpu: служба pg-backup — образ postgres по digest, uid 70, hardened, без сети и без паролей; RETENTION_DAYS=30", () => {
  const b = compose.services["pg-backup"];
  assert.ok(b, "нет службы pg-backup");
  assert.equal(b.image, compose.services.postgres.image);
  assert.equal(b.user, "70:70");
  assert.deepEqual(b.cap_drop, ["ALL"]);
  assert.ok(b.security_opt.includes("no-new-privileges:true") && b.read_only === true && b.pids_limit > 0);
  assert.equal(b.network_mode, "none");
  assert.equal(b.secrets, undefined, "вход по peer через сокет — секреты не нужны");
  assert.equal(b.environment.RETENTION_DAYS, "30");
  assert.deepEqual(b.command, ["sh", "/etc/postgresql/pg-backup.sh", "loop"]);
  for (const v of ["pg-run:/var/run/postgresql", "pg-backups:/backups", "pg-wal-archive:/wal-archive", "./postgres/pg-backup.sh:/etc/postgresql/pg-backup.sh:ro"]) assert.ok(b.volumes.includes(v), `pg-backup: нет тома ${v}`);
  assert.equal(b.depends_on.postgres.condition, "service_healthy");
  assert.ok(b.healthcheck.test.includes("check"), "healthcheck: свежесть бэкапа");
  for (const v of ["pg-backups", "pg-wal-archive"]) assert.match(compose.volumes[v].driver_opts.device, /^\$\{PG_[A-Z_]+_DIR:\?/, `${v}: каталог хоста обязателен`);
  const hba = readFileSync(join(pgDir, "pg_hba.conf"), "utf8");
  assert.match(hba, /^local\s+replication\s+postgres\s+peer$/m, "pg_basebackup сокетом по peer");
  assert.match(readFileSync(join(pgDir, "pg-backup.sh"), "utf8"), /RETENTION_DAYS=\$\{RETENTION_DAYS:-30\}/);
});

test("надстройка compose.backup-s3.yml: rclone по digest, ключи — файлами-секретами, префикс backups/, только чтение томов", () => {
  const s3 = parse(readFileSync(join(dir, "compose.backup-s3.yml"), "utf8"), { merge: true });
  const s = s3.services["pg-backup-s3"];
  assert.match(s.image, /^\$\{RCLONE_IMAGE:\?/);
  assert.match(readFileSync(join(dir, ".env.example"), "utf8"), /^RCLONE_IMAGE=rclone\/rclone:[\w.-]+@sha256:[0-9a-f]{64}/m);
  assert.deepEqual(s.cap_drop, ["ALL"]);
  assert.equal(s.environment.PREFIX, "backups/");
  assert.deepEqual(s.secrets.sort(), ["backup_s3_access_key_id", "backup_s3_secret_access_key"]);
  assert.ok(!Object.keys(s.environment).some((k) => /SECRET|ACCESS_KEY/.test(k)), "ключи не в окружении контейнера");
  assert.deepEqual(s.volumes.sort(), ["pg-backups:/backups:ro", "pg-wal-archive:/wal-archive:ro"]);
  assert.match(s.command[0], /rclone copy --immutable/, "только добавление, без sync-удаления в бакете");
});

test("wal-archive.sh: первый раз копирует, повтор того же — 0, другое содержимое — отказ и файл не перезаписан", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wal-archive-"));
  try {
    const archive = join(tmp, "archive");
    mkdirSync(archive);
    const seg = join(tmp, "000000010000000000000001");
    writeFileSync(seg, "сегмент-A");
    const env = { WAL_ARCHIVE_DIR: archive };
    const first = sh("wal-archive.sh", [seg, "000000010000000000000001"], env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(archive, "000000010000000000000001"), "utf8"), "сегмент-A");
    const again = sh("wal-archive.sh", [seg, "000000010000000000000001"], env);
    assert.equal(again.status, 0, again.stderr);
    writeFileSync(seg, "сегмент-B");
    const other = sh("wal-archive.sh", [seg, "000000010000000000000001"], env);
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /другим содержимым/);
    assert.equal(readFileSync(join(archive, "000000010000000000000001"), "utf8"), "сегмент-A", "архив не перезаписан");
    assert.deepEqual(readdirSync(archive), ["000000010000000000000001"], "временных файлов не осталось");
    assert.notEqual(sh("wal-archive.sh", [seg], env).status, 0, "без %f — отказ");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pg-backup.sh prune: удаляет ровно каталоги старше 30 дней; 30-дневный и чужие имена остаются", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pg-backup-"));
  try {
    const base = join(tmp, "base");
    const names = ["2026-08-01", "2026-08-27", "2026-08-28", "2026-09-01", "2026-09-27", "2025-12-31", "lost+found", "2026-09-27.partial"];
    for (const n of names) mkdirSync(join(base, n), { recursive: true });
    const NOW = String(Date.UTC(2026, 8, 27, 12, 0, 0) / 1000); // 2026-09-27 12:00 UTC
    const r = sh("pg-backup.sh", ["prune", tmp, "30"], { NOW, WAL_ARCHIVE_DIR: join(tmp, "no-wal") });
    assert.equal(r.status, 0, r.stderr);
    // 2026-08-27 — 31 день → удалён; 2026-08-28 — ровно 30 → остаётся
    assert.deepEqual(readdirSync(base).sort(), ["2026-08-28", "2026-09-01", "2026-09-27", "2026-09-27.partial", "lost+found"]);
    // через границу года: 2027-01-30 минус 30 дней = 2026-12-31
    for (const n of ["2026-12-30", "2026-12-31"]) mkdirSync(join(base, n));
    const y = sh("pg-backup.sh", ["prune", tmp, "30"], { NOW: String(Date.UTC(2027, 0, 30) / 1000), WAL_ARCHIVE_DIR: join(tmp, "no-wal") });
    assert.equal(y.status, 0, y.stderr);
    assert.deepEqual(readdirSync(base).filter((n) => n.startsWith("2026-12")), ["2026-12-31"]);
    assert.notEqual(sh("pg-backup.sh", ["prune", tmp, "тридцать"]).status, 0, "срок — только число");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pg-backup.sh prune: WAL старше самого старого оставшегося бэкапа удаляется, новее и *.history — остаются", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pg-backup-wal-"));
  try {
    const wal = join(tmp, "wal");
    mkdirSync(wal);
    mkdirSync(join(tmp, "base/2026-09-20"), { recursive: true });
    const at = (f, sec) => utimesSync(f, sec, sec);
    const started = Date.UTC(2026, 8, 20, 1, 0, 0) / 1000;
    writeFileSync(join(tmp, "base/2026-09-20/.started"), "");
    at(join(tmp, "base/2026-09-20/.started"), started);
    for (const [n, dt] of [["000000010000000000000001", -3600], ["000000010000000000000002", 3600], ["00000002.history", -7200]]) {
      writeFileSync(join(wal, n), n);
      at(join(wal, n), started + dt);
    }
    const r = sh("pg-backup.sh", ["prune", tmp, "30"], { NOW: String(Date.UTC(2026, 8, 27) / 1000), WAL_ARCHIVE_DIR: wal });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(wal).sort(), ["000000010000000000000002", "00000002.history"]);
    assert.ok(existsSync(join(tmp, "base/2026-09-20")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("restore-drill.sh: тот же backup.conf и скрипты gpu, вердикт по RTO ≤ 3600 и RPO ≤ 900, всё гасится в trap", () => {
  const s = readFileSync(join(root, "scripts/restore-drill.sh"), "utf8");
  assert.match(s, /deploy\/gpu\/postgres\/backup\.conf/);
  assert.match(s, /pg-backup\.sh once/);
  assert.match(s, /restore_command = 'cp \/wal-archive\/%f %p'/);
  assert.match(s, /recovery\.signal/);
  assert.match(s, /r <= 3600 && p <= 900/);
  assert.match(s, /PAUSE_S=\$\{PAUSE_S:-420\}/);
  assert.match(s, /trap cleanup EXIT/);
  assert.equal(spawnSync("bash", ["-n", join(root, "scripts/restore-drill.sh")]).status, 0, "синтаксис bash");
});
