"""Restore a pinned CMS backup from S3 without storing a full archive on Mac.

Private key stays on the caller. Each authenticated/decrypted part is hashed
before streaming to an isolated destination; success requires the whole hash.
No restored services are started and no existing directory is overwritten.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--plain-sha256", type=Path, required=True)
    parser.add_argument("--certificate", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--openssl", default="openssl")
    parser.add_argument("--host", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--prefetch", type=int, default=4, choices=range(1, 9))
    args = parser.parse_args()
    if not re.fullmatch(r"/opt/resource-ocr/platform-restore-[A-Za-z0-9_-]+", args.destination):
        raise ValueError("destination must be an isolated platform-restore directory")
    parts = [line.split() for line in args.manifest.read_text().splitlines()]
    if not parts:
        raise ValueError("empty manifest")
    for index, row in enumerate(parts):
        if len(row) != 2 or not re.fullmatch(r"[0-9a-f]{64}", row[0]) or row[1] != f"part-{index:06d}.cms":
            raise ValueError("invalid or unordered manifest")
    expected = args.plain_sha256.read_text().split()[0]
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("invalid whole-archive digest")
    if args.report.exists():
        raise FileExistsError("verification report already exists")
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="platform-restore-") as directory:
        root = Path(directory)
        def download(name):
            path = root / name
            subprocess.run(["rclone", "copyto", args.source.rstrip("/")+"/"+name,
                            str(path), "--immutable", "--quiet"], check=True, timeout=300)
            if not path.is_file() or path.stat().st_size == 0:
                raise RuntimeError('encrypted backup part was not downloaded')
            return path
        destination = shlex.quote(args.destination)
        receiver_log = args.report.with_suffix('.receiver.log').open('x')
        args.report.with_suffix('.receiver.log').chmod(0o600)
        receiver = subprocess.Popen(["ssh", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15",
                                     "-o", "ServerAliveCountMax=4", args.host,
                                     f"umask 077; mkdir {destination} && tar -xf - -C {destination}"],
                                    stdin=subprocess.PIPE, stderr=receiver_log)
        digest = hashlib.sha256()
        total = 0
        verified_parts = 0
        try:
            with ThreadPoolExecutor(max_workers=args.prefetch) as pool:
                futures = {i: pool.submit(download, parts[i][1]) for i in range(min(args.prefetch, len(parts)))}
                for index, (want, name) in enumerate(parts):
                    encrypted = futures.pop(index).result()
                    plain = root / "plain"
                    subprocess.run([args.openssl, "cms", "-decrypt", "-binary", "-inform", "DER",
                                    "-in", str(encrypted), "-recip", str(args.certificate),
                                    "-inkey", str(args.key), "-out", str(plain)], check=True)
                    with plain.open("rb") as stream:
                        part_digest = hashlib.sha256()
                        while block := stream.read(1024*1024):
                            part_digest.update(block)
                        if part_digest.hexdigest() != want:
                            raise RuntimeError(f"plaintext checksum mismatch: {name}")
                        stream.seek(0)
                        while block := stream.read(1024*1024):
                            digest.update(block)
                            total += len(block)
                            receiver.stdin.write(block)
                    encrypted.unlink()
                    plain.unlink()
                    verified_parts = index + 1
                    following = index + args.prefetch
                    if following < len(parts):
                        futures[following] = pool.submit(download, parts[following][1])
                    if (index+1) % 20 == 0 or index+1 == len(parts):
                        print(json.dumps({"verified_parts": index+1, "total_parts": len(parts),
                                          "seconds": round(time.monotonic()-started)}), flush=True)
            receiver.stdin.close()
            if receiver.wait(timeout=60) != 0 or digest.hexdigest() != expected:
                raise RuntimeError("restored stream or whole-archive checksum failed")
        except Exception as exc:
            failure = {'schema': 'platform-backup-restore-failure/1', 'restored': False,
                       'destination': args.destination, 'verified_parts': verified_parts,
                       'streamed_bytes': total, 'receiver_exit_code': receiver.poll(),
                       'error': type(exc).__name__, 'seconds': time.monotonic()-started}
            failure_path = args.report.with_suffix('.failure.json')
            with failure_path.open('x') as output:
                json.dump(failure, output, indent=2)
            failure_path.chmod(0o600)
            raise
        finally:
            if receiver.poll() is None:
                receiver.terminate()
                receiver.wait(timeout=30)
            receiver_log.close()
    report = {"schema": "platform-backup-restore/1", "source": args.source,
              "destination": args.destination, "parts": len(parts), "bytes": total,
              "plain_sha256": expected, "authenticated_parts": True,
              "whole_sha256_verified": True, "seconds": time.monotonic()-started}
    with args.report.open("x") as output:
        json.dump(report, output, indent=2)
    args.report.chmod(0o600)
    print(json.dumps({"restored": True, "bytes": total, "parts": len(parts)}))


if __name__ == "__main__":
    main()
