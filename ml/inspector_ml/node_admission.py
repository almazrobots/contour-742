"""T-239: sole local admission owner with a fail-closed, pinned durable ledger.

No process launch, telemetry collection, network endpoint or automatic stop proof.
The trusted supervisor must reserve before allocating and provide StopProof only
after worker/device termination. Never replace this directory while an owner lives.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
from threading import RLock
from uuid import UUID, uuid4

from .resource_admission import AdmissionLedger, JobRef, Resources, StopProof, Telemetry


class NodeAdmissionError(RuntimeError):
    """No admission decision can be trusted until journal ownership is re-established."""


class NodeAdmissionBusy(NodeAdmissionError):
    """Another process owns this node journal."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _read(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError("non-finite JSON constant")

    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        raw = stream.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("admission snapshot too large")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def _atomic(path, value):
    temporary = path.with_name(f".{path.name}.{uuid4()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_encoded(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


class NodeAdmission:
    def __init__(self, root: Path, *, journal_identity: str, node_id: str, policy_id: str,
                 capacity: Resources, resident: Resources, queue_limit=64, telemetry_ttl=5.0,
                 heartbeat_ttl=30.0, initialize=False):
        if str(UUID(journal_identity)) != journal_identity:
            raise ValueError("pinned canonical journal UUID required")
        self.root, self.identity = Path(root), journal_identity
        self.node_id, self.policy_id = node_id, policy_id
        self._fd = None
        self._closed, self._poisoned = False, False
        self._pid, self._mutex = os.getpid(), RLock()
        self._last_checksum = None
        options = dict(capacity=capacity, resident=resident, queue_limit=queue_limit,
                       telemetry_ttl=telemetry_ttl, heartbeat_ttl=heartbeat_ttl)
        try:
            if initialize:
                # Validate policy before leaving any provisioning files behind.
                ledger = AdmissionLedger(**options)
                ledger.export_state(node_id=node_id, policy_id=policy_id)
                self.root.mkdir(mode=0o700, parents=True, exist_ok=False)
                self._fd = os.open(self.root / "owner.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
            else:
                self._identity_record = self._read_identity()
                self._fd = os.open(self.root / "owner.lock", os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise NodeAdmissionBusy("node admission already has an owner") from error
            stat = os.fstat(self._fd)
            if initialize:
                os.fsync(self._fd)
                self._identity_record = {"schema": "node-admission.v1", "journal_identity": self.identity,
                    "owner_lock": [stat.st_dev, stat.st_ino]}
                _atomic(self.root / "identity.json", self._identity_record)
                self._ledger = ledger
            else:
                self._verify_identity()
                envelope = self._read_state()
                self._ledger = AdmissionLedger.restore_state(envelope["state"], node_id=node_id, policy_id=policy_id, **options)
            # Restarted reservations are UNKNOWN and remain charged to capacity.
            # Persist that conservative state before exposing the new owner.
            self._write_state()
        except BaseException as error:
            if self._fd is not None:
                os.close(self._fd)
                self._fd = None
            self._closed = True
            if isinstance(error, (NodeAdmissionError, FileExistsError, KeyboardInterrupt, SystemExit)):
                raise
            raise NodeAdmissionError("node admission journal could not be opened") from error

    def _read_identity(self):
        value = _read(self.root / "identity.json")
        if (not isinstance(value, dict) or set(value) != {"schema", "journal_identity", "owner_lock"} or
                value["schema"] != "node-admission.v1" or value["journal_identity"] != self.identity):
            raise NodeAdmissionError("node admission identity mismatch")
        return value

    def _verify_identity(self):
        value = self._read_identity()
        stat, path_stat = os.fstat(self._fd), (self.root / "owner.lock").lstat()
        expected = [stat.st_dev, stat.st_ino]
        if (value != self._identity_record or value["owner_lock"] != expected or
                [path_stat.st_dev, path_stat.st_ino] != expected):
            raise NodeAdmissionError("node admission owner lock lost or replaced")

    def _read_state(self):
        value = _read(self.root / "state.json")
        if (not isinstance(value, dict) or set(value) != {"schema", "journal_identity", "state", "checksum"} or
                value["schema"] != "node-admission.v1" or value["journal_identity"] != self.identity or
                value["checksum"] != hashlib.sha256(_encoded(value["state"])).hexdigest()):
            raise NodeAdmissionError("node admission snapshot corrupt or foreign")
        return value

    def _write_state(self):
        self._verify_identity()
        state = self._ledger.export_state(node_id=self.node_id, policy_id=self.policy_id)
        checksum = hashlib.sha256(_encoded(state)).hexdigest()
        _atomic(self.root / "state.json", {"schema": "node-admission.v1", "journal_identity": self.identity,
            "state": state, "checksum": checksum})
        self._last_checksum = checksum

    def _usable(self):
        if self._closed or self._poisoned or os.getpid() != self._pid:
            raise NodeAdmissionError("node admission is closed or requires recovery")
        try:
            self._verify_identity()
            if self._read_state()["checksum"] != self._last_checksum:
                raise NodeAdmissionError("node admission snapshot changed outside its owner")
        except Exception as error:
            self._poisoned = True
            raise NodeAdmissionError("node admission storage is unavailable or changed") from error

    def _mutate(self, operation, *args, **kwargs):
        with self._mutex:
            self._usable()
            try:
                result = getattr(self._ledger, operation)(*args, **kwargs)
                self._write_state()
            except Exception as error:
                # Never return an in-memory grant/cleanup as durable success.
                # Retain ownership until explicit close; all further admission fails.
                self._poisoned = True
                raise NodeAdmissionError("admission mutation was not durably committed") from error
            return result

    def enqueue(self, job: JobRef):
        return self._mutate("enqueue", job)

    def reserve_next(self, telemetry: Telemetry, *, now: float):
        return self._mutate("reserve_next", telemetry, now=now)

    def heartbeat(self, job_id: str, token: str, *, now: float):
        return self._mutate("heartbeat", job_id, token, now=now)

    def expire(self, *, now: float):
        return self._mutate("expire", now=now)

    def release(self, job_id: str, proof: StopProof, *, oom=False):
        """Trusted supervisor only; booleans from untrusted HTTP are not StopProof."""
        return self._mutate("release", job_id, proof, oom=oom)

    def cancel_queued(self, job_id: str):
        return self._mutate("cancel_queued", job_id)

    def block_configuration(self, config_id: str):
        return self._mutate("block_configuration", config_id)

    def configuration_blocked(self, config_id: str):
        with self._mutex:
            self._usable()
            return self._ledger.configuration_blocked(config_id)

    def snapshot(self):
        with self._mutex:
            self._usable()
            return self._ledger.snapshot()

    def queued(self):
        with self._mutex:
            self._usable()
            return self._ledger.queued()

    def close(self):
        with self._mutex:
            if self._fd is not None:
                os.close(self._fd)  # No LOCK_UN: an inherited descriptor must not unlock another owner.
                self._fd = None
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
