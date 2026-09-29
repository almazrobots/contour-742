"""Linux admission observations. Unknown GPU owners never authorize a launch.

Reservations remain an upper bound on allocations, so observed usage is not
subtracted from active reservations: conservative double accounting is safe.
This probe is evidence for admission, never proof that a worker has stopped.
"""
import csv
from dataclasses import dataclass
import io
import os
from pathlib import Path
import subprocess
import time
from uuid import UUID

from .resource_admission import Resources, Telemetry


class TelemetryUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    start_ticks: int
    boot_id: str


@dataclass(frozen=True)
class NodeObservation:
    telemetry: Telemetry
    gpu_uuid: str
    gpu_used_bytes: int
    available_ram: int
    available_spool: int
    gpu_processes: tuple[ProcessIdentity, ...]
    unknown_gpu_processes: tuple[ProcessIdentity, ...]


def process_identity(pid: int, proc: Path = Path("/proc")) -> ProcessIdentity:
    if type(pid) is not int or pid <= 0:
        raise TelemetryUnavailable("invalid GPU process PID")
    # comm may contain spaces and parentheses; fields after the final ')' start at 3.
    raw = (proc / str(pid) / "stat").read_text()
    fields = raw[raw.rindex(")") + 2:].split()
    boot_id = (proc / "sys/kernel/random/boot_id").read_text().strip()
    if str(UUID(boot_id)) != boot_id:
        raise TelemetryUnavailable("invalid boot identity")
    return ProcessIdentity(pid, int(fields[19]), boot_id)


def available_memory(proc: Path, cgroup: Path, cgroup_root: Path = Path("/sys/fs/cgroup")) -> int:
    memory = {}
    for line in (proc / "meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in {"MemTotal", "MemAvailable"}:
            amount, unit = value.split()
            if unit != "kB":
                raise TelemetryUnavailable("unknown memory unit")
            memory[key] = int(amount) * 1024
    available = memory["MemAvailable"]
    if not 0 <= available <= memory["MemTotal"]:
        raise TelemetryUnavailable("invalid host memory observation")
    # Read limits at every visible ancestor; a child may say max under a capped parent.
    current = cgroup.resolve()
    boundary = cgroup_root.resolve()
    if not current.is_dir() or not boundary.is_dir() or not (boundary / "cgroup.controllers").is_file():
        raise TelemetryUnavailable("visible cgroup hierarchy unavailable")
    if current != boundary and boundary not in current.parents:
        raise TelemetryUnavailable("cgroup outside visible hierarchy")
    while True:
        try:
            limit = (current / "memory.max").read_text().strip()
        except FileNotFoundError:
            if current == boundary:
                break  # Actual hierarchy root has no limit; namespace roots may have one.
            raise
        used = int((current / "memory.current").read_text())
        if used < 0:
            raise TelemetryUnavailable("negative cgroup usage")
        if limit != "max":
            available = min(available, max(0, int(limit) - used))
        if current == boundary:
            break
        current = current.parent
    return available


def _smi(arguments):
    return subprocess.run(["nvidia-smi", *arguments, "--format=csv,noheader,nounits"],
                          capture_output=True, text=True, check=True, timeout=3).stdout


def observe(*, gpu_uuid: str, capacity: Resources, resident: Resources,
            allowed_gpu_processes: frozenset[ProcessIdentity], spool: Path,
            cgroup: Path, proc: Path = Path("/proc"), cgroup_root: Path = Path("/sys/fs/cgroup"),
            smi=_smi) -> NodeObservation:
    """Caller supplies a pinned GPU UUID and supervisor-owned process identities.

    CPU capacity must come from the supervisor's enforced cpuset/cpu.max, not
    instantaneous utilization. This function does not invent CPU or token credit.
    Missing telemetry raises; the caller must retain reservations and wait.
    """
    started = time.monotonic()
    try:
        rows = list(csv.reader(io.StringIO(smi(["--query-gpu=uuid,memory.total,memory.used"]))))
        selected = [row for row in rows if row and row[0].strip() == gpu_uuid]
        if len(selected) != 1 or len(selected[0]) != 3:
            raise TelemetryUnavailable("pinned GPU not uniquely observed")
        total, used = (int(value.strip()) * 1024 * 1024 for value in selected[0][1:])
        if not 0 <= used <= total or capacity.vram > total:
            raise TelemetryUnavailable("invalid GPU capacity observation")
        identities = set()
        for row in csv.reader(io.StringIO(smi(["--query-compute-apps=gpu_uuid,pid"]))):
            if row and row[0].strip() == gpu_uuid:
                if len(row) != 2:
                    raise TelemetryUnavailable("invalid GPU process observation")
                identities.add(process_identity(int(row[1].strip()), proc))
        ram = available_memory(proc, cgroup, cgroup_root)
        disk = os.statvfs(spool)
        free_spool = disk.f_bavail * disk.f_frsize
        unknown = identities - allowed_gpu_processes
        # Resident is already counted by the ledger. This construction leaves no
        # more headroom than the actual free bytes, even under an ancestor limit.
        external = Resources(
            ram=max(0, capacity.ram - ram - resident.ram),
            vram=max(0, capacity.vram - (total - used) - resident.vram),
            spool=max(0, capacity.spool - free_spool - resident.spool))
        return NodeObservation(Telemetry(started, external, gpu_safe=not unknown),
                               gpu_uuid, used, ram, free_spool,
                               tuple(sorted(identities, key=lambda p: p.pid)),
                               tuple(sorted(unknown, key=lambda p: p.pid)))
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError) as exc:
        raise TelemetryUnavailable("resource telemetry unavailable; admission must wait") from exc
