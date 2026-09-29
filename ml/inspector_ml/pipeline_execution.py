"""T-238: execution identity, fencing of late requests, and process-death evidence.

Only metadata is durable on disk. Replies stay in the existing protected Redis
cache. INTERRUPTED/FAILED do not prove a remote Reader has stopped: a coordinator
must establish quiescence before authorizing another epoch. Missing identity is
not cancellation; cancel_unstarted seals it against a delayed POST.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Callable, Iterator
from uuid import UUID, uuid4

from .cache import Cache, FileCache
from .pipeline_contract import digest as canonical_digest

STATES = {"RUNNING", "DONE", "FAILED", "INTERRUPTED", "CANCELLED"}


class ExecutionConflict(ValueError):
    """One execution identity cannot be rebound to different input."""


class ExecutionJournalError(RuntimeError):
    """Journal unavailable/corrupt: no permission to execute or infer success."""


def _json(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def request_digest(envelope: dict) -> str:
    """Caller includes both route/stage and body, not only the HTTP body."""
    if not isinstance(envelope, dict):
        raise ValueError("execution request must be an object")
    return canonical_digest(envelope)


def _digest(value: str) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("invalid execution digest")
    return value


def _key(job_id: str, epoch: int) -> str:
    if not isinstance(job_id, str) or str(UUID(job_id)) != job_id:
        raise ValueError("job_id must be a canonical UUID")
    if type(epoch) is not int or not 1 <= epoch <= 2_147_483_647:
        raise ValueError("invalid execution epoch")
    return f"{job_id}.{epoch}"


@dataclass(frozen=True)
class ExecutionSnapshot:
    job_id: str
    epoch: int
    status: str  # ABSENT is an observation, never a terminal/cancellation proof.
    request_digest: str | None
    reply: dict | None = None
    reason: str | None = None

    def to_dict(self) -> dict:
        return {"job_id": self.job_id, "epoch": self.epoch, "status": self.status,
                "request_digest": self.request_digest, "reply": self.reply, "reason": self.reason,
                "requires_remote_quiescence": self.requires_remote_quiescence}

    @property
    def requires_remote_quiescence(self) -> bool:
        return self.status in {"RUNNING", "FAILED", "INTERRUPTED"}


class ExecutionJournal:
    """root must be a persistent, shared mount for every worker serving these identities.

    Never clear/remount the directory while a worker may still run: a new lock inode
    cannot fence an owner on a discarded volume. No automatic journal/tombstone GC.
    Coordination of different epochs belongs to PostgreSQL, not this journal.
    """
    def __init__(self, root: Path, cache: Cache, *, journal_identity: str | None = None, initialize: bool = False):
        if isinstance(cache, FileCache):
            raise ValueError("execution replies require protected Redis, not FileCache")
        self.root, self.cache, self.identity = Path(root), cache, journal_identity
        if journal_identity is None:
            if initialize:
                raise ValueError("explicit provisioning requires a pinned journal identity")
            # Compatibility for isolated, unconfigured fixtures; production pins identity.
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        else:
            if str(UUID(journal_identity)) != journal_identity:
                raise ValueError("journal identity must be a canonical UUID")
            if initialize:
                self.root.mkdir(parents=True, exist_ok=False, mode=0o700)
                fd = os.open(self.root / "registry.lock", os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
                try:
                    stat = os.fstat(fd)
                    os.fsync(fd)
                    self._atomic("registry.json", {"schema": "execution-registry.v1", "scopes": {}})
                    self._atomic("identity.json", {"identity": self.identity, "schema": "execution-journal.v2",
                        "registry_lock": [stat.st_dev, stat.st_ino]})
                finally:
                    os.close(fd)
            self._ready()

    def _ready(self):
        try:
            value = json.loads((self.root / "identity.json").read_text())
            stat = (self.root / "registry.lock").lstat()
            if (not isinstance(value, dict) or set(value) != {"identity", "schema", "registry_lock"} or
                    value["identity"] != self.identity or value["schema"] != "execution-journal.v2" or
                    value["registry_lock"] != [stat.st_dev, stat.st_ino] or
                    not (self.root / "registry.json").is_file()):
                raise ValueError("identity or registry mismatch")
            return value
        except (OSError, ValueError, TypeError) as error:
            raise ExecutionJournalError("execution journal identity/registry unavailable") from error

    def _strict_scope_fd(self, key):
        identity = self._ready()
        registry_fd = os.open(self.root / "registry.lock", os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            fcntl.flock(registry_fd, fcntl.LOCK_EX)
            stat = os.fstat(registry_fd)
            if identity["registry_lock"] != [stat.st_dev, stat.st_ino]:
                raise ExecutionJournalError("execution registry lock changed")
            self._ready()
            try:
                registry = json.loads((self.root / "registry.json").read_text())
                if (not isinstance(registry, dict) or set(registry) != {"schema", "scopes"} or
                        registry["schema"] != "execution-registry.v1" or not isinstance(registry["scopes"], dict)):
                    raise ValueError("invalid registry")
            except (OSError, ValueError, TypeError) as error:
                raise ExecutionJournalError("execution scope registry corrupt") from error
            path = self.root / f"{key}.lock"
            known = registry["scopes"].get(key)
            if known is None:
                # A crash during provisioning may strand files, but cannot turn them
                # into a fresh permission to execute or cancel a previously seen scope.
                if path.exists() or (self.root / f"{key}.json").exists():
                    raise ExecutionJournalError("unregistered execution scope files")
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
                try:
                    stat = os.fstat(fd)
                    os.fsync(fd)
                    self._atomic(f"{key}.json", {"unstarted": True})
                    registry["scopes"][key] = [stat.st_dev, stat.st_ino]
                    self._atomic("registry.json", registry)
                    return fd
                except BaseException:
                    os.close(fd)
                    raise
            try:
                fd = os.open(path, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
            except OSError as error:
                raise ExecutionJournalError("known execution scope lock lost") from error
            stat = os.fstat(fd)
            if known != [stat.st_dev, stat.st_ino] or not (self.root / f"{key}.json").is_file():
                os.close(fd)
                raise ExecutionJournalError("known execution scope state/lock lost or replaced")
            return fd
        finally:
            os.close(registry_fd)

    @contextmanager
    def _lock(self, key: str) -> Iterator[bool]:
        # Never unlink lock files: replacing their inode would split coordination.
        fd = self._strict_scope_fd(key) if self.identity is not None else os.open(
            self.root / f"{key}.lock", os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            yield True
        finally:
            os.close(fd)

    def _read(self, key: str) -> dict | None:
        try:
            with (self.root / f"{key}.json").open("r", encoding="utf8") as source:
                raw = source.read(16_385)
        except FileNotFoundError:
            if self.identity is not None:
                raise ExecutionJournalError("known execution scope state lost")
            return None
        try:
            value = json.loads(raw)
            if self.identity is not None and value == {"unstarted": True}:
                return None
            if (len(raw) > 16_384 or not isinstance(value, dict) or
                    set(value) != {"key", "request_digest", "state", "reply_ref", "reply_digest", "reason", "updated_at"} or
                    value["key"] != key or value["state"] not in STATES):
                raise ValueError("invalid journal")
            _digest(value["request_digest"])
            if value["state"] == "DONE":
                _digest(value["reply_digest"])
                if value["reply_ref"] != f"pipeline-execution-v1-{key}-{value['request_digest']}":
                    raise ValueError("invalid reply reference")
            elif value["reply_ref"] is not None or value["reply_digest"] is not None:
                raise ValueError("unexpected reply reference")
            if value["reason"] is not None and value["reason"] not in {
                "call_failed", "result_unavailable", "result_missing", "result_corrupt", "owner_disappeared", "sealed_unstarted"}:
                raise ValueError("invalid reason")
            return value
        except (ValueError, TypeError, KeyError) as error:
            raise ExecutionJournalError("execution metadata corrupt") from error

    def _write(self, key: str, digest: str, state: str, *, reason: str | None = None,
               reply_ref: str | None = None, reply_digest: str | None = None) -> dict:
        value = {"key": key, "request_digest": digest, "state": state,
                 "reply_ref": reply_ref, "reply_digest": reply_digest,
                 "reason": reason, "updated_at": time.time()}
        if self.identity is not None:
            self._ready()
        self._atomic(f"{key}.json", value)
        return value

    def _atomic(self, name, value):
        temporary = self.root / f".{name}.{uuid4()}.tmp"
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf8") as target:
                target.write(_json(value))
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.root / name)
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _check(value: dict | None, expected: str | None) -> None:
        if value is not None and expected is not None and value["request_digest"] != expected:
            raise ExecutionConflict("execution identity has different request digest")

    def _snapshot(self, job_id: str, epoch: int, value: dict | None, *, busy: bool = False) -> ExecutionSnapshot:
        if busy:
            return ExecutionSnapshot(job_id, epoch, "RUNNING", value["request_digest"] if value else None)
        if value is None:
            return ExecutionSnapshot(job_id, epoch, "ABSENT", None)
        key, digest = _key(job_id, epoch), value["request_digest"]
        if value["state"] == "RUNNING":
            value = self._write(key, digest, "INTERRUPTED", reason="owner_disappeared")
        reply = None
        if value["state"] == "DONE":
            reason = None
            try:
                raw = self.cache.get(value["reply_ref"])
                if raw is None:
                    reason = "result_missing"
                elif hashlib.sha256(raw.encode()).hexdigest() != value["reply_digest"]:
                    reason = "result_corrupt"
                else:
                    reply = json.loads(raw)
                    if not isinstance(reply, dict):
                        reason = "result_corrupt"
            except (ValueError, TypeError):
                reason = "result_corrupt"
            except Exception:
                reason = "result_unavailable"
            if reason == "result_unavailable":
                # A transient Redis outage is an observation, not evidence that a
                # completed reply was lost. Preserve its durable reference for recovery.
                return ExecutionSnapshot(job_id, epoch, "FAILED", digest, reason=reason)
            if reason:
                value = self._write(key, digest, "FAILED", reason=reason)
                reply = None
        return ExecutionSnapshot(job_id, epoch, value["state"], digest, reply, value["reason"])

    def probe(self, job_id: str, epoch: int, expected_digest: str | None = None) -> ExecutionSnapshot:
        key = _key(job_id, epoch)
        if expected_digest is not None:
            _digest(expected_digest)
        with self._lock(key) as acquired:
            value = self._read(key)
            self._check(value, expected_digest)
            return self._snapshot(job_id, epoch, value, busy=not acquired)

    def cancel_unstarted(self, job_id: str, epoch: int, digest: str) -> ExecutionSnapshot:
        key, digest = _key(job_id, epoch), _digest(digest)
        with self._lock(key) as acquired:
            value = self._read(key)
            self._check(value, digest)
            if acquired and value is None:
                value = self._write(key, digest, "CANCELLED", reason="sealed_unstarted")
            return self._snapshot(job_id, epoch, value, busy=not acquired)

    def execute(self, job_id: str, epoch: int, envelope: dict, call: Callable[[], dict]) -> ExecutionSnapshot:
        key, digest = _key(job_id, epoch), request_digest(envelope)
        with self._lock(key) as acquired:
            value = self._read(key)
            self._check(value, digest)
            if not acquired or value is not None:
                return self._snapshot(job_id, epoch, value, busy=not acquired)
            # Persist the fence BEFORE invoking any work. Cache/journal failures never authorize replay.
            self._write(key, digest, "RUNNING")
            try:
                reply = call()  # Must join ALL local worker threads before returning/raising.
                if not isinstance(reply, dict):
                    raise ValueError("execution reply must be a JSON object")
                raw = _json(reply)
            except Exception:
                value = self._write(key, digest, "FAILED", reason="call_failed")
                return self._snapshot(job_id, epoch, value)
            ref = f"pipeline-execution-v1-{key}-{digest}"
            try:
                self.cache.set(ref, raw)
                if self.cache.get(ref) != raw:
                    raise ExecutionJournalError("reply cache did not retain bytes")
            except Exception:
                value = self._write(key, digest, "FAILED", reason="result_unavailable")
                return self._snapshot(job_id, epoch, value)
            value = self._write(key, digest, "DONE", reply_ref=ref, reply_digest=hashlib.sha256(raw.encode()).hexdigest())
            return ExecutionSnapshot(job_id, epoch, "DONE", digest, reply)


def main():
    """Explicit offline provisioning; normal ML startup never uses this operation."""
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--initialize", action="store_true", required=True)
    parser.parse_args()

    class BootstrapCache:
        def get(self, key):
            raise RuntimeError("bootstrap must not access payloads")

        def set(self, key, value):
            raise RuntimeError("bootstrap must not access payloads")

    ExecutionJournal(Path(os.environ["INSPECTOR_PIPELINE_EXECUTIONS_DIR"]), BootstrapCache(),
                     journal_identity=os.environ["INSPECTOR_PIPELINE_JOURNAL_IDENTITY"], initialize=True)


if __name__ == "__main__":
    main()
