"""T-239 resource policy; no rendering, process launch or device IO.

A single future node-agent owns this ledger. It is thread safe, not a distributed
lock. Reconstruct live/unknown reservations before opening admission after agent
restart. Telemetry.external excludes this ledger's resident and job allocations.
StopProof is a trusted supervisor input, never evidence inferred from TTL.
"""
from dataclasses import asdict, dataclass, fields
import math
from threading import RLock
from uuid import UUID, uuid4


def _reference(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or not value.isascii() or not all(c.isalnum() or c in "-_.:" for c in value):
        raise ValueError("bounded opaque reference required")
    return value


def _mapping(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError("invalid snapshot fields")
    return value


def _resources(value):
    return Resources(**_mapping(value, (f.name for f in fields(Resources))))


def _job(value, *, legacy=False):
    keys = ("job_id", "config_id", "resources", "gpu_group")
    value = _mapping(value, keys if legacy else (*keys, "priority"))
    return JobRef(value["job_id"], value["config_id"], _resources(value["resources"]),
                  value["gpu_group"], "batch" if legacy else value["priority"])


def _number(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("finite numeric snapshot value required")
    return value


@dataclass(frozen=True)
class Resources:
    cpu: int = 0  # millicores
    ram: int = 0  # bytes, including render/copies/tmpfs
    vram: int = 0
    pixels: int = 0
    spool: int = 0
    tokens: int = 0

    def __post_init__(self):
        if any(type(v) is not int or v < 0 for v in self.values()):
            raise ValueError("resources must be nonnegative integers")

    def values(self):
        return tuple(getattr(self, f.name) for f in fields(self))

    def __add__(self, other):
        return Resources(*(a + b for a, b in zip(self.values(), other.values())))

    def exceeds(self, capacity):
        return tuple(f.name for f, a, b in zip(fields(self), self.values(), capacity.values()) if a > b)


@dataclass(frozen=True)
class JobRef:
    job_id: str
    config_id: str
    resources: Resources
    gpu_group: bool = True  # reserves PP + its dependent Reader together
    priority: str = "batch"

    def __post_init__(self):
        for value in (self.job_id, self.config_id):
            _reference(value)
        if not isinstance(self.resources, Resources) or type(self.gpu_group) is not bool:
            raise ValueError("invalid job demand")
        if self.resources.vram and not self.gpu_group:
            raise ValueError("VRAM demand requires GPU group")
        if self.priority not in ("batch", "interactive"):
            raise ValueError("invalid job priority")


@dataclass(frozen=True)
class Telemetry:
    observed_at: float
    external: Resources
    gpu_safe: bool = True


@dataclass(frozen=True)
class Reservation:
    job: JobRef
    token: str
    heartbeat_at: float
    state: str = "RESERVED"  # capacity held before allocation/render


@dataclass(frozen=True)
class Decision:
    action: str  # admit / wait / reject
    reason: str
    reservation: Reservation | None = None


@dataclass(frozen=True)
class StopProof:
    token: str
    worker_stopped: bool
    device_safe: bool


class AdmissionLedger:
    def __init__(self, capacity: Resources, resident: Resources, *, queue_limit=64, telemetry_ttl=5.0, heartbeat_ttl=30.0):
        if resident.exceeds(capacity):
            raise ValueError("resident group exceeds capacity")
        if type(queue_limit) is not int or queue_limit < 1:
            raise ValueError("positive queue limit required")
        if any(not math.isfinite(x) or x <= 0 for x in (telemetry_ttl, heartbeat_ttl)):
            raise ValueError("positive finite TTL required")
        self.capacity, self.resident = capacity, resident
        self.queue_limit, self.telemetry_ttl, self.heartbeat_ttl = queue_limit, telemetry_ttl, heartbeat_ttl
        self._queue: dict[str, JobRef] = {}
        self._active: dict[str, Reservation] = {}
        self._oom_configs: set[str] = set()
        self._quarantined = False
        self._interactive_streak = 0
        self._lock = RLock()

    def enqueue(self, job: JobRef) -> Decision:
        with self._lock:
            existing = self._queue.get(job.job_id)
            active = self._active.get(job.job_id)
            if active:
                return Decision("wait", "already_reserved") if active.job == job else Decision("reject", "identity_conflict")
            if existing:
                return Decision("wait", "queued") if existing == job else Decision("reject", "identity_conflict")
            if self._quarantined or job.config_id in self._oom_configs:
                return Decision("reject", "oom_configuration")
            over = (self.resident + job.resources).exceeds(self.capacity)
            if over:
                return Decision("reject", "capacity:" + ",".join(over))
            if len(self._queue) >= self.queue_limit:
                return Decision("reject", "queue_full")
            self._queue[job.job_id] = job
            return Decision("wait", "queued")

    def reserve_next(self, telemetry: Telemetry, *, now: float) -> Decision:
        with self._lock:
            if not math.isfinite(now):
                raise ValueError("finite monotonic time required")
            self.expire(now=now)
            if not self._queue:
                return Decision("wait", "empty")
            if self._quarantined:
                return Decision("reject", "oom_configuration")
            if len(self._active) >= self.queue_limit:
                return Decision("wait", "reservation_limit")
            if not math.isfinite(telemetry.observed_at) or not 0 <= now - telemetry.observed_at <= self.telemetry_ttl:
                return Decision("wait", "stale_telemetry")
            batch = next((j for j in self._queue.values() if j.priority == "batch"), None)
            interactive = next((j for j in self._queue.values() if j.priority == "interactive"), None)
            # A waiting/rejected candidate never consumes a fairness turn. Once
            # batch is due, do not bypass it with smaller interactive demands.
            job = interactive if interactive and (batch is None or self._interactive_streak < 3) else batch
            if job.config_id in self._oom_configs:
                del self._queue[job.job_id]
                return Decision("reject", "oom_configuration")
            if job.gpu_group and (not telemetry.gpu_safe or any(r.job.gpu_group for r in self._active.values())):
                return Decision("wait", "gpu_group_unavailable")
            used = self.resident + telemetry.external
            for reservation in self._active.values():
                used += reservation.job.resources
            over = (used + job.resources).exceeds(self.capacity)
            if over:
                return Decision("wait", "capacity:" + ",".join(over))
            reservation = Reservation(job, str(uuid4()), now)
            self._active[job.job_id] = reservation
            del self._queue[job.job_id]
            self._interactive_streak = min(3, self._interactive_streak + 1) if job.priority == "interactive" else 0
            return Decision("admit", "reserved", reservation)

    def heartbeat(self, job_id: str, token: str, *, now: float) -> bool:
        with self._lock:
            self.expire(now=now)
            r = self._active.get(job_id)
            if not r or r.token != token or r.state == "UNKNOWN" or not math.isfinite(now) or now < r.heartbeat_at:
                return False
            self._active[job_id] = Reservation(r.job, token, now, "ACTIVE")
            return True

    def expire(self, *, now: float) -> None:
        with self._lock:
            if not math.isfinite(now):
                raise ValueError("finite monotonic time required")
            for job_id, r in self._active.items():
                if now - r.heartbeat_at > self.heartbeat_ttl:
                    self._active[job_id] = Reservation(r.job, r.token, r.heartbeat_at, "UNKNOWN")

    def release(self, job_id: str, proof: StopProof, *, oom=False) -> bool:
        """Cleanup never needs fresh telemetry or free capacity."""
        with self._lock:
            r = self._active.get(job_id)
            if not r or r.token != proof.token or proof.worker_stopped is not True or (r.job.gpu_group and proof.device_safe is not True):
                return False
            if oom:
                self._oom_configs.add(r.job.config_id)
                if len(self._oom_configs) >= self.queue_limit:
                    self._quarantined = True  # bounded history; operator intervention
            del self._active[job_id]
            return True

    def cancel_queued(self, job_id: str) -> bool:
        with self._lock:
            return self._queue.pop(job_id, None) is not None

    def block_configuration(self, config_id: str):
        with self._lock:
            self._oom_configs.add(_reference(config_id))
            if len(self._oom_configs) >= self.queue_limit:
                self._quarantined = True

    def configuration_blocked(self, config_id: str) -> bool:
        with self._lock:
            return self._quarantined or config_id in self._oom_configs

    def snapshot(self) -> tuple[Reservation, ...]:
        with self._lock:
            return tuple(self._active.values())

    def queued(self) -> tuple[JobRef, ...]:
        with self._lock:
            return tuple(self._queue.values())

    def export_state(self, *, node_id: str, policy_id: str) -> dict:
        """Detached JSON state. The owner must persist before exposing a decision.

        This is not a durable write. The owner also pins journal identity and
        rejects missing/corrupt/stale journals; node/policy IDs alone do not
        authenticate a file or prove that an older snapshot is current.
        """
        with self._lock:
            return {
                "schema": 2, "node_id": _reference(node_id), "policy_id": _reference(policy_id),
                "capacity": asdict(self.capacity), "resident": asdict(self.resident),
                "queue_limit": self.queue_limit, "telemetry_ttl": self.telemetry_ttl,
                "heartbeat_ttl": self.heartbeat_ttl,
                "queue": [asdict(j) for j in self._queue.values()],
                "reservations": [asdict(r) for r in self._active.values()],
                "oom_configs": sorted(self._oom_configs), "quarantined": self._quarantined,
                "interactive_streak": self._interactive_streak,
            }

    @classmethod
    def restore_state(cls, state: object, *, node_id: str, policy_id: str,
                      capacity: Resources, resident: Resources, queue_limit=64,
                      telemetry_ttl=5.0, heartbeat_ttl=30.0):
        """Validate completely, then return a new ledger with UNKNOWN owners.

        No partial state is installed on error. Never fall back to an empty
        ledger after a restore failure. Monotonic heartbeats from another
        process lifetime cannot authorize resumption.
        """
        if type(state) is not dict or type(state.get("schema")) is not int or state["schema"] not in (1, 2):
            raise ValueError("unsupported snapshot schema")
        legacy = state["schema"] == 1
        keys = ("schema", "node_id", "policy_id", "capacity", "resident",
                "queue_limit", "telemetry_ttl", "heartbeat_ttl", "queue",
                "reservations", "oom_configs", "quarantined")
        state = _mapping(state, keys if legacy else (*keys, "interactive_streak"))
        streak = 0 if legacy else state["interactive_streak"]
        if type(streak) is not int or not 0 <= streak <= 3:
            raise ValueError("invalid fairness state")
        if state["node_id"] != _reference(node_id) or state["policy_id"] != _reference(policy_id):
            raise ValueError("snapshot identity mismatch")
        if _resources(state["capacity"]) != capacity or _resources(state["resident"]) != resident:
            raise ValueError("snapshot capacity mismatch")
        if type(state["queue_limit"]) is not int or state["queue_limit"] != queue_limit:
            raise ValueError("snapshot queue policy mismatch")
        if _number(state["telemetry_ttl"]) != telemetry_ttl or _number(state["heartbeat_ttl"]) != heartbeat_ttl:
            raise ValueError("snapshot TTL policy mismatch")
        result = cls(capacity, resident, queue_limit=queue_limit,
                     telemetry_ttl=telemetry_ttl, heartbeat_ttl=heartbeat_ttl)
        for key, limit in (("queue", queue_limit), ("reservations", queue_limit), ("oom_configs", 2 * queue_limit)):
            if type(state[key]) is not list or len(state[key]) > limit:
                raise ValueError("snapshot collection exceeds bound")
        if type(state["quarantined"]) is not bool:
            raise ValueError("invalid quarantine state")
        oom = [_reference(v) for v in state["oom_configs"]]
        if len(set(oom)) != len(oom) or (len(oom) >= queue_limit and not state["quarantined"]):
            raise ValueError("invalid OOM history")
        result._oom_configs = set(oom)
        result._quarantined = state["quarantined"]
        result._interactive_streak = streak
        used, tokens = resident, set()
        for entry in state["reservations"]:
            entry = _mapping(entry, ("job", "token", "heartbeat_at", "state"))
            j = _job(entry["job"], legacy=legacy)
            token = entry["token"]
            if not isinstance(token, str) or str(UUID(token)) != token or token in tokens:
                raise ValueError("invalid or duplicate reservation token")
            if entry["state"] not in ("RESERVED", "ACTIVE", "UNKNOWN"):
                raise ValueError("invalid reservation state")
            _number(entry["heartbeat_at"])
            if j.job_id in result._active:
                raise ValueError("duplicate active job")
            result._active[j.job_id] = Reservation(j, token, 0.0, "UNKNOWN")
            tokens.add(token)
            used += j.resources
        if used.exceeds(capacity) or sum(r.job.gpu_group for r in result._active.values()) > 1:
            raise ValueError("invalid active resource accounting")
        for entry in state["queue"]:
            j = _job(entry, legacy=legacy)
            if j.job_id in result._queue or j.job_id in result._active or (resident + j.resources).exceeds(capacity):
                raise ValueError("invalid queued job")
            result._queue[j.job_id] = j
        return result
