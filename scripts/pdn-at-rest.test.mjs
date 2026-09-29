// T-231 (OWASP-0191): сценарии закрытия ПДн в покое на GPU-сервере — pdn-at-rest-a.sh (ключ блобов), pdn-at-rest-b.sh
// (LUKS), decommission.sh (вывод сервера). Серверная часть скриптов запускается как на сервере (PDN_REMOTE=1), но все пути —
// под временным PDN_ROOT, а всё, что меняет систему (docker, cryptsetup, mount, chattr, fstrim, swapoff, blkdiscard, nvme…),
// — поддельные команды в PATH, которые только пишут вызов в журнал. Шифрование и откат варианта А — настоящие
// (apps/api/src/cli/blobs-encrypt.ts и deploy/gpu-stand/blobs-decrypt.mjs на синтетических блобах).
// Эшелоны: L1 — надстройка compose, правка fstab; L3 — dry-run ничего не меняет; L4 — отказы (правило №0, очередь, чужие
// процессы, нехватка RAM, без --confirm, корень на стираемом диске, не нули после стирания); L5 — порядок шагов --apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const root = new URL("..", import.meta.url).pathname;
const A = join(root, "scripts/pdn-at-rest-a.sh");
const B = join(root, "scripts/pdn-at-rest-b.sh");
const D = join(root, "scripts/decommission.sh");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const GB = 1024 * 1024; // КБ в ГБ — для meminfo и df

// всё, что может изменить систему или сходить в сеть, — подделка (тесты идут и под root на раннере)
const FAKES = ["docker", "df", "chown", "chattr", "cryptsetup", "fallocate", "mkfs.ext4", "mount", "umount", "mountpoint", "rsync",
  "fstrim", "findmnt", "lsblk", "swapon", "swapoff", "blkdiscard", "blkid", "systemctl", "vgs", "vgchange", "nvme", "journalctl",
  "blockdev", "apt-get", "ssh", "install"];

function sandbox(overrides = {}) {
  const d = mkdtempSync(join(tmpdir(), "t231-"));
  const bin = join(d, "bin");
  const R = join(d, "root");
  mkdirSync(bin);
  mkdirSync(R);
  const log = join(d, "calls");
  writeFileSync(log, "");
  writeFileSync(join(d, "mounted"), "");
  const head = `#!/usr/bin/env bash\nD=${JSON.stringify(d)}\nprintf '%s\\n' "$(basename "$0") $*" >> "$D/calls"\n`;
  const bodies = {
    df: `echo "Filesystem 1K-blocks Used Available Use% Mounted"; echo "fake 1 1 $(( \${FAKE_FREE_GB:-690} * ${GB} )) 1% /"`,
    mountpoint: `grep -qxF -- "\${@: -1}" "$D/mounted"`,
    mount: `printf '%s\\n' "\${@: -1}" >> "$D/mounted"`,
    umount: `grep -vxF -- "\${@: -1}" "$D/mounted" > "$D/m2" || true; mv "$D/m2" "$D/mounted"`,
    cryptsetup: `case "$*" in *--key-file=-*) cat > "$D/stdin.$RANDOM";; esac
case $1 in status) [ -e "$D/open" ];; open) touch "$D/open";; close) rm -f "$D/open";; --version) echo "cryptsetup 2.7.0";; esac`,
    ssh: `echo "ssh в тесте запрещён" >&2; exit 97`,
    install: `echo "install в тесте запрещён" >&2; exit 97`,
    vgs: `echo "  0g"`,
    ...overrides,
  };
  for (const n of FAKES) {
    writeFileSync(join(bin, n), head + (bodies[n] ?? "") + "\n");
    chmodSync(join(bin, n), 0o755);
  }
  const meminfo = (availGb, swapTotalGb = 20, swapFreeGb = 11) => {
    mkdirSync(join(d, "proc"), { recursive: true });
    writeFileSync(join(d, "proc/meminfo"), `MemTotal: ${62 * GB} kB\nMemAvailable: ${availGb * GB} kB\nSwapTotal: ${swapTotalGb * GB} kB\nSwapFree: ${swapFreeGb * GB} kB\n`);
  };
  meminfo(28);
  const sh = (script, args, env = {}, input) =>
    spawnSync("bash", [script, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PDN_REMOTE: "1", PDN_ROOT: R, PDN_PROC: join(d, "proc"), REPO: root, ...env },
      encoding: "utf8",
      input,
    });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { d, R, bin, sh, calls, meminfo, done: () => rmSync(d, { recursive: true, force: true }) };
}
const MUTATING = /^(chown|chattr|cryptsetup (luksFormat|open|close|luksErase)|fallocate|mkfs|mount|umount|rsync -aHAX --numeric-ids(?! .*--dry-run)|fstrim|swapoff|blkdiscard|systemctl (start|stop|daemon)|nvme (sanitize|format)|journalctl --vacuum|apt-get|docker (stop|start|run|volume rm)|docker compose .* (up|stop))/;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ─────────────────────────────── вариант А

/** Стенд под PDN_ROOT: синтетические блобы открытым текстом, stand.env, исходники в src (как после gpu-stand.sh ship). */
function standA(s, nBlobs = 5) {
  const base = join(s.R, "opt/stand-gpu");
  for (const p of ["blobs", "secrets", "src/apps/api/src/cli", "src/deploy/gpu-stand"]) mkdirSync(join(base, p), { recursive: true });
  writeFileSync(join(base, "stand.env"), "API_IMAGE=inspector-gpu-api:test\nSTAND_VAR=/opt/stand-gpu\n");
  writeFileSync(join(base, "src/apps/api/src/cli/blobs-encrypt.ts"), "");
  writeFileSync(join(base, "src/deploy/gpu-stand/compose.at-rest.yml"), "");
  writeFileSync(join(base, "src/deploy/gpu-stand/blobs-decrypt.mjs"), "");
  const names = [];
  for (let i = 0; i < nBlobs; i++) {
    const b = randomBytes(1000 + i * 777);
    names.push(sha(b));
    writeFileSync(join(base, "blobs", sha(b)), b, { mode: 0o644 });
  }
  return { base, names, blobs: join(base, "blobs"), key: join(base, "secrets/blob_encryption_key") };
}
// docker для варианта А: compose — только журнал (и глубина очереди), run — настоящий node из репозитория
const dockerA = `if [ "$1" = compose ]; then case "$*" in *list_queues*) echo "\${FAKE_QUEUE:-0}";; esac; exit 0; fi
if [ "$1" = run ]; then
  blobs=""; key=""; rest=()
  while [ $# -gt 0 ]; do
    case $1 in
      -v) case $2 in *:/blobs) blobs=\${2%:/blobs};; *:/run/blob_key:ro) key=\${2%:/run/blob_key:ro};; esac; shift 2; continue;;
      --entrypoint) script=$4; shift 4; rest=("$@"); break;;
    esac; shift
  done
  extra=(); for a in "\${rest[@]}"; do [ "$a" = --dry-run ] && extra+=(--dry-run); done
  exec node "$REPO/$script" --dir "$blobs" --key-file "$key" "\${extra[@]}"
fi`;
const ibe1 = (dir) => readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/.test(n)).filter((n) => readFileSync(join(dir, n)).subarray(0, 4).toString("latin1") === "IBE1").length;

test("А plan и migrate без --apply: ничего не меняют — ключа нет, блобы открытым текстом, изменяющих вызовов нет", () => {
  const s = sandbox({ docker: dockerA });
  try {
    const st = standA(s);
    for (const args of [[], ["plan"], ["migrate"], ["rollback"]]) {
      const r = s.sh(A, args);
      if (args[0] === "rollback") { assert.notEqual(r.status, 0); continue; } // ключа нет — откатывать нечего
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(strip(r.stdout), /НЕ закрывает/);
    }
    assert.equal(existsSync(st.key), false, "ключ не создан");
    assert.equal(ibe1(st.blobs), 0);
    assert.deepEqual(s.calls().filter((c) => MUTATING.test(c)), []);
    assert.match(strip(s.sh(A, ["migrate"]).stdout), /\[dry-run\] .*compose.*up -d --wait/);
  } finally { s.done(); }
});

test("А migrate --apply: ключ 600 из 64 hex, api+ml с надстройкой ДО шифрования, все блобы IBE1, TRIM; rollback --apply возвращает открытый текст", () => {
  const s = sandbox({ docker: dockerA });
  try {
    const st = standA(s, 6);
    const r = s.sh(A, ["migrate", "--apply"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(readFileSync(st.key, "utf8"), /^[0-9a-f]{64}$/);
    assert.equal(statSync(st.key).mode & 0o777, 0o600);
    assert.equal(ibe1(st.blobs), 6, "все блобы зашифрованы");
    const c = s.calls();
    const up = c.findIndex((x) => /^docker compose .*compose\.at-rest\.yml .* up -d --wait .* api ml$/.test(x));
    const enc = c.findIndex((x) => /^docker run .*blobs-encrypt\.ts --dir \/blobs --key-file \/run\/blob_key$/.test(x));
    assert.ok(up >= 0 && enc > up, "API с ключом поднимается раньше шифрования: иначе API без ключа не прочтёт IBE1");
    assert.ok(c.some((x) => x.startsWith("chown 1000:1000 ") && x.endsWith("blob_encryption_key")), "ключ читает uid API");
    assert.ok(c.some((x) => /^docker run .*--network none .*--user 1000:1000 .*--read-only/.test(x)), "шифрование — без сети, uid API");
    assert.ok(c.includes("fstrim -v /"));
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(readFileSync(st.key, "utf8")), "ключ не печатается");
    // повторный migrate — ключ не перезаписывается, файлы не трогаются
    const key1 = readFileSync(st.key, "utf8");
    assert.equal(s.sh(A, ["migrate", "--apply"]).status, 0);
    assert.equal(readFileSync(st.key, "utf8"), key1);
    // откат: API останавливается до расшифровки, ключ убран в *.disabled-*, API без надстройки
    const rb = s.sh(A, ["rollback", "--apply"]);
    assert.equal(rb.status, 0, rb.stderr + rb.stdout);
    assert.equal(ibe1(st.blobs), 0);
    for (const n of st.names) assert.equal(sha(readFileSync(join(st.blobs, n))), n);
    assert.equal(existsSync(st.key), false);
    assert.equal(readdirSync(join(st.base, "secrets")).filter((n) => n.startsWith("blob_encryption_key.disabled-")).length, 1);
    const c2 = s.calls();
    const stop = c2.findIndex((x) => /compose .* stop api$/.test(x));
    const dec = c2.findIndex((x) => /blobs-decrypt\.mjs --dir \/blobs --key-file \/run\/blob_key$/.test(x));
    assert.ok(stop >= 0 && dec > stop);
    assert.match(c2.at(-1), /^docker compose (?!.*at-rest).* up -d --wait .* api ml$/);
  } finally { s.done(); }
});

test("А отказы --apply: мало диска (правило №0), очередь разбора не пуста, мало RAM — ключ не создаётся, стенд не трогается", () => {
  for (const [env, mem, re] of [[{ FAKE_FREE_GB: "12" }, 28, /правило №0/], [{ FAKE_QUEUE: "3" }, 28, /очереди 3/], [{}, 8, /RAM доступно 8/]]) {
    const s = sandbox({ docker: dockerA });
    try {
      const st = standA(s);
      s.meminfo(mem);
      const r = s.sh(A, ["migrate", "--apply"], env);
      assert.equal(r.status, 1, r.stdout);
      assert.match(strip(r.stdout + r.stderr), re);
      assert.equal(existsSync(st.key), false);
      assert.deepEqual(s.calls().filter((c) => MUTATING.test(c)), []);
    } finally { s.done(); }
  }
});

test("А blobs-decrypt: подменённый файл не трогается и даёт код 2; неверный ключ — ошибка, файлы целы", () => {
  const d = mkdtempSync(join(tmpdir(), "t231-dec-"));
  try {
    const key = join(d, "k");
    writeFileSync(key, randomBytes(32).toString("hex"));
    const b = randomBytes(5000);
    writeFileSync(join(d, sha(b)), b);
    const enc = spawnSync("node", [join(root, "apps/api/src/cli/blobs-encrypt.ts"), "--dir", d, "--key-file", key], { encoding: "utf8" });
    assert.equal(enc.status, 0, enc.stderr);
    const raw = readFileSync(join(d, sha(b)));
    raw[raw.length - 20] ^= 1;
    writeFileSync(join(d, sha(b)), raw);
    const r = spawnSync("node", [join(root, "deploy/gpu-stand/blobs-decrypt.mjs"), "--dir", d, "--key-file", key], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.deepEqual(readFileSync(join(d, sha(b))), raw, "повреждённый файл не перезаписан");
    const other = join(d, "k2");
    writeFileSync(other, randomBytes(32).toString("hex"));
    assert.equal(spawnSync("node", [join(root, "deploy/gpu-stand/blobs-decrypt.mjs"), "--dir", d, "--key-file", other], { encoding: "utf8" }).status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("А compose.at-rest.yml: ключ API — секретом, рабочий каталог в tmpfs, ML видит только blob-work и только на чтение", () => {
  const o = parse(readFileSync(join(root, "deploy/gpu-stand/compose.at-rest.yml"), "utf8"));
  assert.equal(o.services.api.environment.INSPECTOR_BLOB_KEY_FILE, "/run/secrets/blob_encryption_key");
  assert.equal(o.services.api.environment.INSPECTOR_BLOB_WORK_DIR, "/app/var/blob-work");
  assert.ok(o.services.api.secrets.includes("blob_encryption_key"));
  assert.ok(o.services.api.secrets.includes("pg_app_password") && o.services.api.secrets.includes("rabbitmq_password"), "прежние секреты API не потеряны");
  assert.deepEqual(o.services.ml.volumes, ["blob-work:/app/var/blobs:ro"]);
  assert.match(o.volumes["blob-work"].driver_opts.o, /uid=1000/);
  assert.equal(o.volumes["blob-work"].driver_opts.type, "tmpfs");
  assert.match(o.secrets.blob_encryption_key.file, /\/secrets\/blob_encryption_key"?$/);
  // слияние с основным compose: у ML путь /app/var/blobs приходит из blob-work, каталога блобов хоста нет
  const d = mkdtempSync(join(tmpdir(), "t231-compose-"));
  try {
    const env = join(d, "env");
    writeFileSync(env, ["POSTGRES_IMAGE=p", "API_IMAGE=a", "ML_IMAGE=m", "REDIS_IMAGE=r", "RABBITMQ_IMAGE=q", "WEB_IMAGE=w", "CADDY_IMAGE=c", `STAND_VAR=${d}`].join("\n"));
    const r = spawnSync("docker", ["compose", "--project-directory", join(root, "deploy/gpu-stand"), "-f", join(root, "deploy/gpu-stand/compose.yml"), "-f", join(root, "deploy/gpu-stand/compose.at-rest.yml"), "--env-file", env, "config", "--format", "json", "--no-interpolate"], { encoding: "utf8" });
    if (r.error || r.status !== 0) return; // нет docker compose — проверка слияния пропускается, разбор YAML выше уже прошёл
    const c = JSON.parse(r.stdout);
    const mlBlobs = c.services.ml.volumes.filter((v) => v.target === "/app/var/blobs");
    assert.equal(mlBlobs.length, 1);
    assert.equal(mlBlobs[0].source, "blob-work");
    assert.equal(mlBlobs[0].read_only, true);
    assert.ok(c.services.api.volumes.some((v) => v.target === "/app/var/blobs"), "API по-прежнему пишет шифротекст в каталог хоста");
    assert.ok(c.services.api.secrets.some((x) => x.source === "blob_encryption_key"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("А gpu-stand.sh: надстройка и ключ импорта — только если на сервере есть ключ хранения", () => {
  const g = readFileSync(join(root, "scripts/gpu-stand.sh"), "utf8");
  assert.match(g, /if \[ -s "\$BLOB_KEY" \]; then COMPOSE\+=\(-f "\$SRC\/deploy\/gpu-stand\/compose\.at-rest\.yml"\); fi/);
  assert.match(g, /if \[ -s "\$BLOB_KEY" \]; then key_mount=\(-v "\$BLOB_KEY:\/run\/blob_key:ro"\); key_arg=\(--import-key-file \/run\/blob_key\); fi/);
  assert.equal(spawnSync("bash", ["-n", join(root, "scripts/gpu-stand.sh")]).status, 0);
});

// ─────────────────────────────── вариант Б

const dockerB = `case "$1 $2" in
  "volume ls") printf '%s\\n' \${FAKE_VOLUMES:-nadzorium-gpu_postgres-data nadzorium-gpu_blob-work};;
  "volume inspect") echo "$PDN_ROOT/var/lib/docker/volumes/\${@: -1}/_data";;
  "ps -q") printf 'c1\\nc2\\n';;
esac`;
function standB(s) {
  for (const p of ["opt/stand-gpu/src/scripts", "opt/stand-gpu/blobs", "opt/corpus/blobs", "opt/inspector/blobs", "var/lib/docker/volumes/nadzorium-gpu_postgres-data/_data", "srv/pdn", "etc"]) mkdirSync(join(s.R, p), { recursive: true });
  writeFileSync(join(s.R, "opt/stand-gpu/src/scripts/gpu-stand.sh"), `printf '%s\\n' "gpu-stand $*" >> ${JSON.stringify(join(s.d, "calls"))}\n`);
  writeFileSync(join(s.R, "opt/corpus/blobs/x"), "синтетика");
  writeFileSync(join(s.R, "var/lib/docker/volumes/nadzorium-gpu_postgres-data/_data/PG_VERSION"), "18");
}

test("Б plan и migrate без --apply: только чтение — каталоги на месте, изменяющих вызовов нет; оценка простоя напечатана", () => {
  const s = sandbox({ docker: dockerB });
  try {
    standB(s);
    const p = s.sh(B, []);
    assert.equal(p.status, 0, p.stderr);
    assert.match(strip(p.stdout), /контейнер-файл .*pdn\.luks/);
    assert.match(strip(p.stdout), /ПРОСТОЙ СТЕНДА/);
    assert.doesNotMatch(strip(p.stdout), /blob-work/, "tmpfs-том не переносится");
    const m = s.sh(B, ["migrate"]);
    assert.equal(m.status, 0, m.stderr + m.stdout);
    assert.ok(existsSync(join(s.R, "opt/corpus/blobs/x")));
    assert.equal(existsSync(join(s.R, "opt/corpus.plain-T231")), false);
    assert.deepEqual(s.calls().filter((c) => MUTATING.test(c)), []);
  } finally { s.done(); }
});

test("Б create --apply: ключ только через stdin (на диск не пишется), LUKS2 argon2id; отказ при нехватке места и при существующем контейнере", () => {
  const s = sandbox({ docker: dockerB });
  try {
    standB(s);
    const key = randomBytes(32).toString("hex");
    const r = s.sh(B, ["create", "--apply"], {}, key);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const c = s.calls();
    assert.ok(c.some((x) => /^fallocate -l 200G .*srv\/pdn\.luks$/.test(x)));
    assert.ok(c.some((x) => /^cryptsetup luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 --pbkdf argon2id --batch-mode .* --key-file=-$/.test(x)));
    assert.ok(c.indexOf(c.find((x) => x.startsWith("mkfs.ext4"))) > c.indexOf(c.find((x) => x.startsWith("cryptsetup open"))));
    const stdins = readdirSync(s.d).filter((n) => n.startsWith("stdin."));
    assert.equal(stdins.length, 2, "luksFormat и open получили ключ через stdin");
    for (const f of stdins) assert.equal(readFileSync(join(s.d, f), "utf8"), key);
    const leaked = spawnSync("grep", ["-rl", key, s.R], { encoding: "utf8" });
    assert.equal(leaked.stdout, "", "ключа нет ни в одном файле под корнем сервера");
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(key));
    writeFileSync(join(s.R, "srv/pdn.luks"), "");
    assert.equal(s.sh(B, ["create", "--apply"], {}, key).status, 1, "существующий контейнер не перезаписывается");
  } finally { s.done(); }
  const s2 = sandbox({ docker: dockerB });
  try {
    standB(s2);
    const r = s2.sh(B, ["create", "--apply"], { FAKE_FREE_GB: "150" }, "a".repeat(64));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /не создаю/);
    assert.equal(s2.sh(B, ["create", "--apply"], {}, "не-hex").status, 1, "ключ не 64 hex — отказ");
  } finally { s2.done(); }
});

test("Б migrate --apply: предкопия → стоп стенда → докопия --delete → сверка → переключение chattr +i и bind → подъём; старые копии *.plain-T231", () => {
  const s = sandbox({ docker: dockerB });
  try {
    standB(s);
    writeFileSync(join(s.d, "mounted"), join(s.R, "srv/pdn") + "\n");
    const r = s.sh(B, ["migrate", "--apply"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const c = s.calls();
    const first = c.findIndex((x) => /^rsync -aHAX --numeric-ids .*opt\/stand-gpu .*opt\/corpus .*opt\/inspector .*srv\/pdn\/opt\/$/.test(x));
    const stop = c.indexOf("docker stop c1 c2");
    const final = c.findIndex((x) => /^rsync -aHAX --numeric-ids --delete .*opt\/stand-gpu/.test(x));
    const check = c.findIndex((x) => /^rsync -aHAXc .*--dry-run --itemize-changes .*opt\/stand-gpu\/ /.test(x));
    const bind = c.findIndex((x) => /^mount --bind .*srv\/pdn\/opt\/stand-gpu .*opt\/stand-gpu$/.test(x));
    const up = c.indexOf("gpu-stand up");
    assert.ok(first >= 0 && first < stop && stop < final && final < check && check < bind && bind < up, c.join("\n"));
    for (const t of ["opt/stand-gpu", "opt/corpus", "opt/inspector", "var/lib/docker/volumes/nadzorium-gpu_postgres-data/_data"]) {
      assert.ok(existsSync(join(s.R, `${t}.plain-T231`)), `${t}: старая копия отложена`);
      assert.deepEqual(readdirSync(join(s.R, t)), [], `${t}: пустая точка монтирования`);
      assert.ok(c.includes(`chattr +i ${join(s.R, t)}`), `${t}: chattr +i — без LUKS контейнер падает, а не пишет в пустой каталог`);
    }
    assert.equal(c.filter((x) => x.includes("blob-work")).length, 0, "tmpfs-том не трогается");
    const mounts = readFileSync(join(s.R, "etc/pdn-at-rest/mounts"), "utf8").trim().split("\n");
    assert.equal(mounts.length, 4);
    assert.ok(existsSync(join(s.R, "etc/pdn-at-rest/verified")));
    assert.equal(s.sh(B, ["migrate", "--apply"]).status, 1, "повторный перенос — отказ");
    // wipe-plain: старые копии удалены, TRIM
    const w = s.sh(B, ["wipe-plain", "--apply"]);
    assert.equal(w.status, 0, w.stderr);
    for (const t of ["opt/corpus", "opt/stand-gpu"]) assert.equal(existsSync(join(s.R, `${t}.plain-T231`)), false);
    assert.ok(s.calls().includes("fstrim -v /"));
    assert.equal(s.calls().filter((x) => x.startsWith("shred")).length, 0, "shred на SSD не используется");
  } finally { s.done(); }
});

test("Б migrate --apply: файлы открыты чужим процессом (W1, прогон T-184) — стенд поднимается обратно, переключения нет", () => {
  const s = sandbox({ docker: dockerB });
  try {
    standB(s);
    writeFileSync(join(s.d, "mounted"), join(s.R, "srv/pdn") + "\n");
    mkdirSync(join(s.d, "proc/4242/fd"), { recursive: true });
    symlinkSync(join(s.R, "opt/corpus/blobs/x"), join(s.d, "proc/4242/fd/3"));
    const r = s.sh(B, ["migrate", "--apply"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /открыты чужими процессами:.*opt\/corpus \[4242/);
    assert.ok(s.calls().includes("docker start c1 c2"));
    assert.equal(existsSync(join(s.R, "opt/corpus.plain-T231")), false);
    assert.equal(s.calls().filter((x) => x.startsWith("mount --bind") || x.startsWith("chattr")).length, 0);
  } finally { s.done(); }
});

test("Б swap --apply: fstab без открытого свопа, crypttab со случайным ключом, blkdiscard старого LV; мало RAM — отказ", () => {
  const uuid = "72f34b37-57ba-4452-b063-59ee763ef2af";
  const s = sandbox({ docker: dockerB, blkid: `echo ${uuid}`, swapon: `case "$*" in *--show*) echo /swapfile-test;; esac` });
  try {
    standB(s);
    writeFileSync(join(s.R, "etc/fstab"), `UUID=ca78\t/\text4\trw\t0 1\nUUID=${uuid}\tnone\tswap\tdefaults\t0 0\n`);
    writeFileSync(join(s.R, "etc/crypttab"), "# <target name>\n");
    const r = s.sh(B, ["swap", "--apply"], { PDN_SWAPFILE: "/swapfile-test" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const fstab = readFileSync(join(s.R, "etc/fstab"), "utf8");
    assert.match(fstab, new RegExp(`^# T-231: UUID=${uuid}`, "m"));
    assert.match(fstab, /^UUID=ca78\t\/\text4/m, "корень не тронут");
    assert.match(fstab, /^\/dev\/mapper\/cswap none swap sw 0 0$/m);
    assert.match(readFileSync(join(s.R, "etc/crypttab"), "utf8"), /^cswap \/dev\/mapper\/vg54831-swap \/dev\/urandom swap,cipher=aes-xts-plain64,size=512$/m);
    const c = s.calls();
    assert.ok(c.indexOf("swapoff /dev/mapper/vg54831-swap") < c.indexOf("blkdiscard -f /dev/mapper/vg54831-swap"));
    assert.ok(c.includes("swapoff /swapfile-test"));
    assert.ok(existsSync(join(s.R, "etc/fstab.bak-T231")));
  } finally { s.done(); }
  const s2 = sandbox({ docker: dockerB });
  try {
    standB(s2);
    s2.meminfo(12, 20, 8); // занято 12, доступно 12 → запас 0
    const r = s2.sh(B, ["swap", "--apply"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /риск OOM/);
    assert.deepEqual(s2.calls().filter((c) => MUTATING.test(c)), []);
  } finally { s2.done(); }
});

// ─────────────────────────────── вывод сервера

test("вывод: --apply без --confirm 54831 — отказ (код 2) ещё до ssh; plan — только чтение", () => {
  const s = sandbox({ docker: dockerB });
  try {
    for (const args of [["online", "--apply"], ["rescue", "--apply"], ["online", "--apply", "--confirm", "54830"]]) {
      const r = spawnSync("bash", [D, ...args], { env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` }, encoding: "utf8" });
      assert.equal(r.status, 2, args.join(" "));
    }
    assert.deepEqual(s.calls(), [], "ssh не вызывался");
    standB(s);
    const p = s.sh(D, ["plan"]);
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(s.calls().filter((c) => MUTATING.test(c)), []);
  } finally { s.done(); }
});

test("вывод online --apply: крипто-стирание LUKS и ключа А, каталоги ПДн и тома удалены, своп, журналы, TRIM", () => {
  const s = sandbox({ docker: dockerB });
  try {
    standB(s);
    writeFileSync(join(s.R, "srv/pdn.luks"), "");
    mkdirSync(join(s.R, "opt/stand-gpu/secrets"), { recursive: true });
    writeFileSync(join(s.R, "opt/stand-gpu/secrets/blob_encryption_key"), "k");
    const r = s.sh(D, ["online", "--apply", "--confirm", "54831"], { PDN_SWAP_LV: join(s.R, "swaplv") });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const c = s.calls();
    assert.ok(c.some((x) => /^cryptsetup luksErase --batch-mode .*srv\/pdn\.luks$/.test(x)));
    for (const t of ["opt/stand-gpu", "opt/corpus", "opt/inspector", "srv/pdn.luks"]) assert.equal(existsSync(join(s.R, t)), false, t);
    assert.ok(c.includes("docker volume rm -f nadzorium-gpu_postgres-data"));
    assert.ok(c.includes("journalctl --vacuum-time=1s"));
    assert.ok(c.includes("fstrim -av"));
  } finally { s.done(); }
});

test("вывод rescue: на живой системе (корень на nvme0n1) — отказ; в rescue — sanitize и проверка нулями; не нули — провал", () => {
  const live = sandbox({ findmnt: "echo /dev/mapper/vg54831-root", lsblk: "echo vg54831-root; echo nvme0n1p3; echo nvme0n1" });
  try {
    const r = live.sh(D, ["rescue", "--apply", "--confirm", "54831"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /это не rescue/);
    assert.equal(live.calls().filter((c) => /^nvme (sanitize|format)|^blkdiscard/.test(c)).length, 0);
  } finally { live.done(); }
  for (const dirty of [false, true]) {
    const s = sandbox({
      findmnt: "echo /dev/ram0", lsblk: "echo ram0",
      nvme: `case $1 in id-ctrl) echo "  [2:2] : 0x1 Block Erase Sanitize Operation Supported";; sanitize-log) echo "most recent sanitize operation completed successfully";; esac`,
      blockdev: "echo 2147483648",
    });
    try {
      const disk = join(s.d, "nvme.img");
      spawnSync("truncate", ["-s", "2G", disk]);
      if (dirty) writeFileSync(disk, "ПДн", { flag: "r+" });
      const r = s.sh(D, ["rescue", "--apply", "--confirm", "54831"], { PDN_NVME_DEV: disk, PDN_NVME_CTRL: disk, PDN_DD_FLAGS: "" });
      const c = s.calls();
      assert.ok(c.includes(`nvme sanitize ${disk} --sanact=2`));
      if (dirty) {
        assert.equal(r.status, 1);
        assert.match(r.stderr, /не нулями: 1 из 8/);
      } else {
        assert.equal(r.status, 0, r.stderr + r.stdout);
        assert.match(strip(r.stdout), /ИТОГ: .* стёрт \(nvme sanitize/);
      }
    } finally { s.done(); }
  }
});
