// NFR-CRYPTO (ТЗ 12.3-01): шифрование данных в покое — shell-часть. Настоящий openssl (сертификаты — в tmp, в самом тесте),
// поддельные findmnt/lsblk/docker в PATH. Эшелоны: L1 круг CMS AuthEnvelopedData AES-256-GCM (RSA-OAEP и EC), части и
// манифест · L3 пустой ввод, граница части · L4 отказы без сертификата, с закрытым ключом вместо сертификата, чужой ключ,
// повтор архивации WAL, том без LUKS · L6 подменённая часть, выброшенная часть, путь в MANIFEST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const B = join(root, "deploy/gpu/backup");
const ENC = join(B, "at-rest-encrypt.sh");
const DEC = join(B, "at-rest-decrypt.sh");
const CHECK = join(root, "deploy/gpu/at-rest-check.sh");
const UP = join(root, "deploy/gpu/up.sh");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const T = mkdtempSync(join(tmpdir(), "t137-at-rest-"));
process.on("exit", () => rmSync(T, { recursive: true, force: true }));
const ossl = (...args) => {
  const r = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
// получатели: RSA (OAEP) и EC (ECDH); «чужой» — для проверки отказа
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(T, "rsa.key"), "-out", join(T, "rsa.pem"), "-days", "2", "-subj", "/CN=backup-recipient");
ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(T, "ec.key"), "-out", join(T, "ec.pem"), "-days", "2", "-subj", "/CN=backup-recipient-ec");
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(T, "other.key"), "-out", join(T, "other.pem"), "-days", "2", "-subj", "/CN=other");

let n = 0;
const fresh = () => {
  const d = join(T, `case-${++n}`);
  mkdirSync(d);
  return d;
};
const run = (cmd, args, { input, env = {} } = {}) =>
  spawnSync("sh", [cmd, ...args], { input, env: { ...process.env, AT_REST_RECIPIENT_CERT: "", AT_REST_RECIPIENT_KEY: "", AT_REST_CHUNK_KB: "", INSPECTOR_AT_REST_WAIVER: "", ...env }, encoding: "buffer" });
const text = (r) => r.stderr.toString() + r.stdout.toString();
const leftovers = (d) => readdirSync(d).filter((x) => x.startsWith("."));

// ─────────────────────────────── фильтр шифрования и расшифровки

test("круг RSA-OAEP: части по -c KiB, MANIFEST и plain.sha256; CMS — AuthEnvelopedData с AES-256-GCM; открытого текста нет", () => {
  const d = fresh();
  const plain = Buffer.concat([Buffer.from("PGDMP заголовок дампа "), randomBytes(150 * 1024)]);
  const r = run(ENC, ["-r", join(T, "rsa.pem"), "-o", join(d, "copy"), "-c", "64"], { input: plain });
  assert.equal(r.status, 0, text(r));
  const manifest = readFileSync(join(d, "copy/MANIFEST"), "utf8").trim().split("\n");
  assert.equal(manifest.length, 3, "150 KiB частями по 64 KiB (+1 байт) — три части");
  assert.equal(readFileSync(join(d, "copy/plain.sha256"), "utf8").trim(), sha(plain));
  const part = readFileSync(join(d, "copy/part-000000.cms"));
  assert.ok(!part.includes(plain.subarray(0, 64)), "в части нет открытого текста");
  const info = ossl("cms", "-cmsout", "-print", "-inform", "DER", "-in", join(d, "copy/part-000000.cms"));
  assert.match(info, /authEnvelopedData/);
  assert.match(info, /aes-256-gcm|id-aes256-GCM/i);
  assert.match(info, /rsaesOaep/, "RSA — только OAEP");
  const out = join(d, "plain.out");
  const back = run(DEC, ["-r", join(T, "rsa.pem"), "-k", join(T, "rsa.key"), "-o", out, join(d, "copy")]);
  assert.equal(back.status, 0, text(back));
  assert.ok(readFileSync(out).equals(plain));
  assert.deepEqual(leftovers(d), []);
});

test("круг EC (ECDH) и сертификат из окружения; пустой ввод — одна пустая часть, расшифровка даёт 0 байт", () => {
  const d = fresh();
  const env = { AT_REST_RECIPIENT_CERT: join(T, "ec.pem"), AT_REST_RECIPIENT_KEY: join(T, "ec.key") };
  const plain = Buffer.from("\0\x01 первый байт — ноль: переносится без потерь");
  assert.equal(run(ENC, ["-o", join(d, "ec")], { input: plain, env }).status, 0);
  assert.equal(run(DEC, ["-o", join(d, "ec.out"), join(d, "ec")], { env }).status, 0);
  assert.ok(readFileSync(join(d, "ec.out")).equals(plain));
  const e = run(ENC, ["-o", join(d, "empty")], { input: Buffer.alloc(0), env });
  assert.equal(e.status, 0, text(e));
  assert.equal(readFileSync(join(d, "empty/MANIFEST"), "utf8").trim().split("\n").length, 1);
  assert.equal(run(DEC, ["-o", join(d, "empty.out"), join(d, "empty")], { env }).status, 0);
  assert.equal(statSync(join(d, "empty.out")).size, 0);
});

test("граница части (ввод из файла, как WAL-сегмент): ровно N×часть — без лишней пустой хвостовой части", () => {
  // из канала dd может прочитать короче — части тогда меньше, но байты не теряются (см. круг выше); из файла — точно
  const d = fresh();
  const plain = randomBytes(2 * (64 * 1024 + 1)); // часть = первый байт + 64 KiB
  writeFileSync(join(d, "in"), plain);
  const r = spawnSync("sh", ["-c", `sh "${ENC}" -r "${join(T, "rsa.pem")}" -o "${join(d, "c")}" -c 64 < "${join(d, "in")}"`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, "c/MANIFEST"), "utf8").trim().split("\n").length, 2);
});

test("отказы шифрования: без сертификата, закрытый ключ вместо сертификата, мусор, OUT уже есть — код ≠ 0 и ничего частичного", () => {
  const d = fresh();
  const input = Buffer.from("данные");
  const none = run(ENC, ["-o", join(d, "a")], { input });
  assert.equal(none.status, 1);
  assert.match(text(none), /сертификат получателя/);
  const bundle = join(d, "bundle.pem");
  writeFileSync(bundle, readFileSync(join(T, "rsa.pem"), "utf8") + readFileSync(join(T, "rsa.key"), "utf8"));
  const withKey = run(ENC, ["-r", bundle, "-o", join(d, "b")], { input });
  assert.equal(withKey.status, 1);
  assert.match(text(withKey), /закрытый ключ/);
  writeFileSync(join(d, "junk.pem"), "не сертификат");
  assert.equal(run(ENC, ["-r", join(d, "junk.pem"), "-o", join(d, "c")], { input }).status, 1);
  mkdirSync(join(d, "exists"));
  writeFileSync(join(d, "exists/keep"), "старое");
  assert.equal(run(ENC, ["-r", join(T, "rsa.pem"), "-o", join(d, "exists")], { input }).status, 3);
  assert.equal(readFileSync(join(d, "exists/keep"), "utf8"), "старое");
  for (const x of ["a", "b", "c"]) assert.ok(!existsSync(join(d, x)), `${x} не создан`);
  assert.deepEqual(leftovers(d), [], "временных каталогов не осталось");
});

test("L6: чужой ключ, подменённая часть, выброшенная часть, путь в MANIFEST — отказ; прежний OUT цел", () => {
  const d = fresh();
  const plain = randomBytes(200 * 1024);
  assert.equal(run(ENC, ["-r", join(T, "rsa.pem"), "-o", join(d, "c"), "-c", "64"], { input: plain }).status, 0);
  const out = join(d, "out");
  writeFileSync(out, "прежний файл");
  const dec = (dir, cert = "rsa") => run(DEC, ["-r", join(T, `${cert}.pem`), "-k", join(T, `${cert}.key`), "-o", out, dir]);
  assert.equal(dec(join(d, "c"), "other").status, 1, "чужой ключ");
  const copy = (name, fn) => {
    const c = join(d, name);
    spawnSync("cp", ["-R", join(d, "c"), c]);
    fn(c);
    return c;
  };
  const tampered = copy("tampered", (c) => {
    const p = readFileSync(join(c, "part-000001.cms"));
    p[p.length - 40] ^= 1;
    writeFileSync(join(c, "part-000001.cms"), p);
  });
  assert.equal(dec(tampered).status, 1, "подменённая часть — тег GCM");
  const dropped = copy("dropped", (c) => {
    const lines = readFileSync(join(c, "MANIFEST"), "utf8").trim().split("\n");
    writeFileSync(join(c, "MANIFEST"), lines.slice(0, -1).join("\n") + "\n");
  });
  const r = dec(dropped);
  assert.equal(r.status, 1);
  assert.match(text(r), /plain\.sha256/);
  const traversal = copy("traversal", (c) => writeFileSync(join(c, "MANIFEST"), `${"0".repeat(64)}  ../c/part-000000.cms\n`));
  assert.match(text(dec(traversal)), /недопустимое имя/);
  assert.equal(readFileSync(out, "utf8"), "прежний файл", "OUT не тронут ни одним отказом");
  assert.deepEqual(leftovers(d), []);
});

// ─────────────────────────────── стык с T-136: archive_command / restore_command

test("стык WAL: архивация → 0; повтор того же → 0 без перезаписи; другое содержимое → отказ; восстановление — те же байты", () => {
  const d = fresh();
  const arch = join(d, "wal-archive");
  mkdirSync(arch);
  const env = { WAL_ARCHIVE_DIR: arch, AT_REST_RECIPIENT_CERT: join(T, "rsa.pem") };
  const name = "000000010000000000000003";
  const seg = join(d, "pg_wal-" + name);
  const body = randomBytes(1024 * 1024); // сегмент 16 МБ — та же одна часть; 1 МБ держит тест быстрым
  writeFileSync(seg, body);
  const archive = (p) => run(join(B, "wal-archive-encrypted.sh"), [p, name], { env });
  assert.equal(archive(seg).status, 0);
  assert.equal(readFileSync(join(arch, name, "plain.sha256"), "utf8").trim(), sha(body));
  const before = readFileSync(join(arch, name, "part-000000.cms"));
  const again = archive(seg);
  assert.equal(again.status, 0, text(again));
  assert.match(text(again), /совпало/);
  assert.ok(readFileSync(join(arch, name, "part-000000.cms")).equals(before), "повтор не перешифровал");
  const other = join(d, "other");
  writeFileSync(other, randomBytes(1024));
  const clash = archive(other);
  assert.equal(clash.status, 1);
  assert.match(text(clash), /другой/);
  assert.ok(readFileSync(join(arch, name, "part-000000.cms")).equals(before), "отказ без перезаписи");
  // восстановление: ключ приносят на время учения
  const target = join(d, "RECOVERYXLOG");
  const renv = { ...env, AT_REST_RECIPIENT_KEY: join(T, "rsa.key") };
  const restore = run(join(B, "wal-restore-encrypted.sh"), [name, target], { env: renv });
  assert.equal(restore.status, 0, text(restore));
  assert.ok(readFileSync(target).equals(body));
  assert.equal(run(join(B, "wal-restore-encrypted.sh"), ["000000010000000000000099", join(d, "none")], { env: renv }).status, 1, "нет в архиве — 1");
  assert.ok(!existsSync(join(d, "none")));
});

test("стык WAL: без сертификата — отказ и ничего в архиве; имя с путём — отказ", () => {
  const d = fresh();
  const arch = join(d, "wal-archive");
  mkdirSync(arch);
  const seg = join(d, "seg");
  writeFileSync(seg, "x");
  const r = run(join(B, "wal-archive-encrypted.sh"), [seg, "000000010000000000000001"], { env: { WAL_ARCHIVE_DIR: arch } });
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(arch), []);
  assert.equal(run(join(B, "wal-archive-encrypted.sh"), [seg, "../x"], { env: { WAL_ARCHIVE_DIR: arch, AT_REST_RECIPIENT_CERT: join(T, "rsa.pem") } }).status, 1);
});

// ─────────────────────────────── проверка томов: поддельные findmnt, lsblk, docker

/** Каталог подделок: mounts — «путь|устройство|фс» (ближайший префикс), lsblk — «устройство|типы через ;», volumes — «том|путь». */
function fakes({ mounts, lsblk, volumes = [], projects = {} }) {
  const d = fresh();
  writeFileSync(join(d, "mounts"), mounts.join("\n") + "\n");
  writeFileSync(join(d, "lsblk.map"), lsblk.join("\n") + "\n");
  writeFileSync(join(d, "volumes"), volumes.join("\n") + "\n");
  for (const [p, vs] of Object.entries(projects)) writeFileSync(join(d, `project-${p}`), vs.join("\n") + "\n");
  const bin = join(d, "bin");
  mkdirSync(bin);
  const sh = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // findmnt -n -o SOURCE|FSTYPE -T путь
  sh("findmnt", `col=$3; p=$5; best=; bl=0
while IFS='|' read -r mp src fs; do [ -n "$mp" ] || continue
  case "$p/" in "$mp"/*|"$mp/"|"\${mp%/}"/*) l=\${#mp}; if [ "$l" -ge "$bl" ]; then bl=$l; best="$src|$fs"; fi;; esac
done < ${d}/mounts
[ -n "$best" ] || exit 1
[ "$col" = SOURCE ] && echo "\${best%%|*}" || echo "\${best#*|}"`);
  sh("lsblk", `dev=$5; line=$(grep -F "$dev|" ${d}/lsblk.map | head -1); [ -n "$line" ] || exit 32; echo "\${line#*|}" | tr ';' '\\n'`);
  sh("docker", `echo "$*" >> ${d}/docker.log
case "$1 $2" in
  "volume inspect") v=$5; line=$(grep "^$v|" ${d}/volumes); [ -n "$line" ] || exit 1; echo "\${line#*|}";;
  "volume ls") p=\${5#label=com.docker.compose.project=}; cat ${d}/project-$p 2>/dev/null;;
  compose*) :;;
esac`);
  return { d, env: { PATH: `${bin}:${process.env.PATH}` }, log: () => (existsSync(join(d, "docker.log")) ? readFileSync(join(d, "docker.log"), "utf8") : "") };
}

const LUKS = ["/dev/mapper/data|crypt;└─part;  └─disk", "/dev/mapper/vg-lv|lvm;└─crypt;  └─part", "/dev/sdb1|part;└─disk"];
const MOUNTS = ["/|/dev/mapper/data|ext4", "/srv/plain|/dev/sdb1|ext4", "/srv/lvm|/dev/mapper/vg-lv|xfs", "/run/work|tmpfs|tmpfs", "/srv/bind|/dev/mapper/data[/srv]|ext4"];

test("at-rest-check: LUKS (в том числе lvm поверх crypt и bind) и tmpfs — 0; устройство без crypt — 1 с именем пути", () => {
  const f = fakes({ mounts: MOUNTS, lsblk: LUKS });
  const ok = run(CHECK, ["/var/lib/x", "/srv/lvm/pg", "/run/work", "/srv/bind/a"], { env: f.env });
  assert.equal(ok.status, 0, text(ok));
  assert.match(text(ok), /crypt/);
  const bad = run(CHECK, ["/var/lib/x", "/srv/plain/backups"], { env: f.env });
  assert.equal(bad.status, 1);
  assert.match(text(bad), /НЕ ЗАШИФРОВАН: \/srv\/plain\/backups/);
  assert.match(text(bad), /стенд не стартует/);
});

test("at-rest-check: тома docker — по Mountpoint; все тома проекта compose; неизвестный том — 1; без аргументов — 2", () => {
  const f = fakes({
    mounts: MOUNTS, lsblk: LUKS,
    volumes: ["inspector-gpu_postgres-data|/var/lib/docker/volumes/inspector-gpu_postgres-data/_data", "inspector-gpu_api-blobs|/srv/plain/docker/api-blobs"],
    projects: { "inspector-gpu": ["inspector-gpu_postgres-data", "inspector-gpu_api-blobs"] },
  });
  assert.equal(run(CHECK, ["--docker-volume", "inspector-gpu_postgres-data"], { env: f.env }).status, 0);
  assert.match(f.log(), /volume inspect -f \{\{\.Mountpoint\}\} inspector-gpu_postgres-data/);
  const proj = run(CHECK, ["--compose-project", "inspector-gpu"], { env: f.env });
  assert.equal(proj.status, 1);
  assert.match(text(proj), /НЕ ЗАШИФРОВАН: том inspector-gpu_api-blobs/);
  assert.doesNotMatch(text(proj), /НЕ ЗАШИФРОВАН: том inspector-gpu_postgres-data/);
  assert.equal(run(CHECK, ["--docker-volume", "нет-такого"], { env: f.env }).status, 1);
  assert.equal(run(CHECK, [], { env: f.env }).status, 2);
});

test("at-rest-check: явный обход INSPECTOR_AT_REST_WAIVER — 0 и предупреждение с причиной", () => {
  const f = fakes({ mounts: MOUNTS, lsblk: LUKS });
  const r = run(CHECK, ["/srv/plain/x"], { env: { ...f.env, INSPECTOR_AT_REST_WAIVER: "стенд жюри без LUKS, решение владельца 27.09" } });
  assert.equal(r.status, 0);
  assert.match(text(r), /ПРЕДУПРЕЖДЕНИЕ.*стенд жюри без LUKS, решение владельца 27\.09/);
});

test("up.sh: тома без шифрования — стенд не стартует (up -d не вызывается); зашифрованы — up --no-start, проверка, up -d --wait", () => {
  const vols = ["inspector-gpu_postgres-data|/var/lib/docker/volumes/pg/_data", "inspector-gpu_api-blobs|/var/lib/docker/volumes/blobs/_data"];
  const good = fakes({ mounts: MOUNTS, lsblk: LUKS, volumes: vols, projects: { "inspector-gpu": vols.map((v) => v.split("|")[0]) } });
  const ok = run(UP, [], { env: { ...good.env, INSPECTOR_GPU_ENV: "/dev/null", COMPOSE_PROJECT_NAME: "" } });
  assert.equal(ok.status, 0, text(ok));
  const calls = good.log().trim().split("\n");
  const i = calls.findIndex((c) => /compose .* up --no-start/.test(c));
  const j = calls.findIndex((c) => /volume ls/.test(c));
  const k = calls.findIndex((c) => /compose .* up -d --wait/.test(c));
  assert.ok(i >= 0 && i < j && j < k, calls.join("\n"));

  const plainVols = ["inspector-gpu_postgres-data|/srv/plain/pg"];
  const bad = fakes({ mounts: MOUNTS, lsblk: LUKS, volumes: plainVols, projects: { "inspector-gpu": ["inspector-gpu_postgres-data"] } });
  const r = run(UP, ["--s3"], { env: { ...bad.env, INSPECTOR_GPU_ENV: "/dev/null", COMPOSE_PROJECT_NAME: "" } });
  assert.equal(r.status, 1);
  assert.match(bad.log(), /compose\.s3\.yml .* up --no-start/);
  assert.doesNotMatch(bad.log(), /up -d/);
});

test("POSIX: круг под dash — /bin/sh Debian-образов, без pipefail", { skip: spawnSync("sh", ["-c", "command -v dash"]).status !== 0 && "dash не установлен" }, () => {
  const d = fresh();
  const plain = randomBytes(300 * 1024);
  writeFileSync(join(d, "in"), plain);
  const enc = spawnSync("dash", [ENC, "-r", join(T, "ec.pem"), "-o", join(d, "c"), "-c", "128"], { input: plain });
  assert.equal(enc.status, 0, enc.stderr.toString());
  const dec = spawnSync("dash", [DEC, "-r", join(T, "ec.pem"), "-k", join(T, "ec.key"), "-o", join(d, "out"), join(d, "c")]);
  assert.equal(dec.status, 0, dec.stderr.toString());
  assert.ok(readFileSync(join(d, "out")).equals(plain));
});

test("up.sh: каталоги бэкапов и архива WAL из строки AT_REST_EXTRA_PATHS= в .env тоже проверяются", () => {
  const vols = ["inspector-gpu_postgres-data|/var/lib/docker/volumes/pg/_data"];
  const f = fakes({ mounts: MOUNTS, lsblk: LUKS, volumes: vols, projects: { "inspector-gpu": ["inspector-gpu_postgres-data"] } });
  const envFile = join(f.d, ".env");
  writeFileSync(envFile, "API_IMAGE=x\nAT_REST_EXTRA_PATHS=/var/backups /srv/plain/wal-archive\n");
  const env = { ...f.env, INSPECTOR_GPU_ENV: envFile, COMPOSE_PROJECT_NAME: "" };
  delete env.AT_REST_EXTRA_PATHS;
  const r = spawnSync("sh", [UP], { env: Object.fromEntries(Object.entries({ ...process.env, ...env, INSPECTOR_AT_REST_WAIVER: "" }).filter(([k]) => k !== "AT_REST_EXTRA_PATHS")), encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /НЕ ЗАШИФРОВАН: \/srv\/plain\/wal-archive/);
  assert.doesNotMatch(f.log(), /up -d/);
});

test("up.sh: каталоги службы pg-backup (PG_BACKUP_DIR, PG_WAL_ARCHIVE_DIR) проверяются, даже если их нет в AT_REST_EXTRA_PATHS (T136-M2)", () => {
  const vols = ["inspector-gpu_postgres-data|/var/lib/docker/volumes/pg/_data"];
  const f = fakes({ mounts: MOUNTS, lsblk: LUKS, volumes: vols, projects: { "inspector-gpu": ["inspector-gpu_postgres-data"] } });
  const envFile = join(f.d, ".env");
  writeFileSync(envFile, "API_IMAGE=x\nAT_REST_EXTRA_PATHS=\nPG_BACKUP_DIR=/srv/plain/pg-backups\nPG_WAL_ARCHIVE_DIR=/var/backups/wal\n");
  const env = { ...f.env, INSPECTOR_GPU_ENV: envFile, COMPOSE_PROJECT_NAME: "" };
  const r = spawnSync("sh", [UP], { env: Object.fromEntries(Object.entries({ ...process.env, ...env, INSPECTOR_AT_REST_WAIVER: "" }).filter(([k]) => !["AT_REST_EXTRA_PATHS", "PG_BACKUP_DIR", "PG_WAL_ARCHIVE_DIR"].includes(k))), encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /НЕ ЗАШИФРОВАН: \/srv\/plain\/pg-backups/);
  assert.doesNotMatch(f.log(), /up -d/);
});
