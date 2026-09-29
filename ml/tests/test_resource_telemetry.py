from pathlib import Path
import subprocess

import pytest

from inspector_ml.resource_admission import AdmissionLedger, JobRef, Resources
from inspector_ml.resource_telemetry import ProcessIdentity, TelemetryUnavailable, available_memory, observe


MIB = 1024 * 1024
BOOT_ID = "e5aca966-3f4f-41da-805f-dac22dc3b8af"
CAP = Resources(cpu=2000, ram=8 * MIB, vram=24 * MIB, spool=8 * MIB)
RESIDENT = Resources(ram=MIB, vram=6 * MIB)


def setup(tmp_path):
    proc, group = tmp_path / "proc", tmp_path / "cgroup"
    proc.mkdir(); group.mkdir()
    boot = proc / "sys" / "kernel" / "random"
    boot.mkdir(parents=True)
    (boot / "boot_id").write_text(BOOT_ID + "\n")
    (group / "cgroup.controllers").write_text("cpu memory\n")
    (proc / "meminfo").write_text("MemTotal: 16384 kB\nMemAvailable: 8192 kB\n")
    (group / "memory.max").write_text(str(8 * MIB))
    (group / "memory.current").write_text(str(5 * MIB))
    (proc / "42").mkdir()
    # Field 22 follows 19 fields beginning at state; comm deliberately contains ')'.
    (proc / "42" / "stat").write_text("42 (worker ) name) " + " ".join(["S"] + ["0"] * 18 + ["99"]))
    return proc, group


def sample(tmp_path, **kwargs):
    proc, group = setup(tmp_path)
    def smi(args):
        return "GPU-test, 24, 20\n" if "--query-gpu=" in args[0] else "GPU-test, 42\n"
    options = dict(gpu_uuid="GPU-test", capacity=CAP, resident=RESIDENT,
                   allowed_gpu_processes=frozenset({ProcessIdentity(42, 99, BOOT_ID)}),
                   spool=tmp_path, cgroup=group, cgroup_root=group, proc=proc, smi=smi)
    options.update(kwargs)
    return observe(**options)


def test_effective_free_memory_bounds_admission_and_known_gpu(tmp_path):
    result = sample(tmp_path)
    assert result.available_ram == 3 * MIB
    assert result.gpu_used_bytes == 20 * MIB
    assert result.telemetry.gpu_safe
    assert result.gpu_processes == (ProcessIdentity(42, 99, BOOT_ID),)
    ledger = AdmissionLedger(CAP, RESIDENT)
    ledger.enqueue(JobRef("job", "config", Resources(ram=4 * MIB, vram=MIB)))
    assert ledger.reserve_next(result.telemetry, now=result.telemetry.observed_at).reason == "capacity:ram"


def test_reused_pid_does_not_become_trusted_gpu_owner(tmp_path):
    result = sample(tmp_path, allowed_gpu_processes=frozenset({ProcessIdentity(42, 98, BOOT_ID)}))
    assert not result.telemetry.gpu_safe
    assert result.unknown_gpu_processes == (ProcessIdentity(42, 99, BOOT_ID),)
    ledger = AdmissionLedger(CAP, RESIDENT)
    ledger.enqueue(JobRef("job", "config", Resources()))
    assert ledger.reserve_next(result.telemetry, now=result.telemetry.observed_at).reason == "gpu_group_unavailable"


@pytest.mark.parametrize("reply", ["", "GPU-test, N/A, 2\n", "GPU-test, 24, 25\n", "GPU-other, 24, 2\n"])
def test_missing_or_invalid_gpu_telemetry_never_grants_credit(tmp_path, reply):
    with pytest.raises(TelemetryUnavailable):
        sample(tmp_path, smi=lambda args: reply)


def test_smi_timeout_fails_closed(tmp_path):
    def unavailable(args):
        raise subprocess.TimeoutExpired("nvidia-smi", 3)
    with pytest.raises(TelemetryUnavailable):
        sample(tmp_path, smi=unavailable)


def test_full_spool_blocks_admit(tmp_path, monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr("inspector_ml.resource_telemetry.os.statvfs", lambda _: SimpleNamespace(f_bavail=0, f_frsize=4096))
    result = sample(tmp_path)
    ledger = AdmissionLedger(CAP, RESIDENT)
    ledger.enqueue(JobRef("job", "config", Resources(spool=1)))
    assert ledger.reserve_next(result.telemetry, now=result.telemetry.observed_at).reason == "capacity:spool"


def test_sampling_time_counts_towards_telemetry_age(tmp_path, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("inspector_ml.resource_telemetry.time.monotonic", lambda: clock[0])

    def slow_smi(args):
        clock[0] += 3.0
        return "GPU-test, 24, 20\n" if "--query-gpu=" in args[0] else "GPU-test, 42\n"

    result = sample(tmp_path, smi=slow_smi)
    ledger = AdmissionLedger(CAP, RESIDENT, telemetry_ttl=5)
    ledger.enqueue(JobRef("job", "config", Resources()))
    assert ledger.reserve_next(result.telemetry, now=clock[0]).reason == "stale_telemetry"


def test_disappeared_gpu_process_does_not_become_empty_safe_sample(tmp_path):
    def smi(args):
        if "--query-gpu=" in args[0]:
            return "GPU-test, 24, 20\n"
        (tmp_path / "proc" / "42" / "stat").unlink()
        return "GPU-test, 42\n"

    with pytest.raises(TelemetryUnavailable):
        sample(tmp_path, smi=smi)


@pytest.mark.parametrize("free_mib", [0, 1, 3, 8, 16])
def test_headroom_never_exceeds_observed_free_or_configured_budget(tmp_path, monkeypatch, free_mib):
    from types import SimpleNamespace

    free = free_mib * MIB
    monkeypatch.setattr("inspector_ml.resource_telemetry.available_memory", lambda *_, **__: free)
    monkeypatch.setattr("inspector_ml.resource_telemetry.os.statvfs",
                        lambda _: SimpleNamespace(f_bavail=free_mib, f_frsize=MIB))
    resident = Resources(ram=MIB, vram=6 * MIB, spool=2 * MIB)

    def smi(args):
        return f"GPU-test, 24, {24 - free_mib}\n" if "--query-gpu=" in args[0] else "GPU-test, 42\n"

    result = sample(tmp_path, resident=resident, smi=smi)
    for field in ("ram", "vram", "spool"):
        headroom = getattr(CAP, field) - getattr(resident, field) - getattr(result.telemetry.external, field)
        assert headroom == min(free, getattr(CAP, field) - getattr(resident, field))


def test_observed_job_memory_never_releases_active_reservation(tmp_path):
    result = sample(tmp_path)
    ledger = AdmissionLedger(CAP, RESIDENT)
    ledger.enqueue(JobRef("active", "config", Resources(ram=2 * MIB), gpu_group=False))
    assert ledger.reserve_next(result.telemetry, now=result.telemetry.observed_at).action == "admit"
    # The next sample already includes the running job's memory. Its reservation
    # still protects against that job growing to its declared maximum later.
    ledger.enqueue(JobRef("next", "config", Resources(ram=2 * MIB), gpu_group=False))
    assert ledger.reserve_next(result.telemetry, now=result.telemetry.observed_at).reason == "capacity:ram"


def test_parent_limit_bounds_unlimited_leaf(tmp_path):
    proc, root = setup(tmp_path)
    parent = root / "parent"
    leaf = parent / "leaf"
    leaf.mkdir(parents=True)
    (root / "memory.max").write_text("max")
    (parent / "memory.max").write_text(str(4 * MIB))
    (parent / "memory.current").write_text(str(3 * MIB))
    (leaf / "memory.max").write_text("max")
    (leaf / "memory.current").write_text(str(MIB))
    assert available_memory(proc, leaf, cgroup_root=root) == MIB


def test_private_namespace_root_limit_is_not_skipped(tmp_path):
    proc, root = setup(tmp_path)
    assert available_memory(proc, root, cgroup_root=root) == 3 * MIB


def test_host_root_without_memory_max_uses_host_available(tmp_path):
    proc, root = setup(tmp_path)
    (root / "memory.max").unlink()
    assert available_memory(proc, root, cgroup_root=root) == 8 * MIB


def test_cgroup_outside_pinned_root_fails_closed(tmp_path):
    proc, root = setup(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "memory.max").write_text("max")
    (outside / "memory.current").write_text("0")
    with pytest.raises(TelemetryUnavailable):
        observe(gpu_uuid="GPU-test", capacity=CAP, resident=RESIDENT,
                allowed_gpu_processes=frozenset(), spool=tmp_path,
                cgroup=outside, cgroup_root=root, proc=proc,
                smi=lambda args: "GPU-test, 24, 0\n" if "--query-gpu=" in args[0] else "")


@pytest.mark.parametrize("missing", ["memory.max", "memory.current"])
def test_missing_nonroot_controller_file_fails_closed(tmp_path, missing):
    def smi(args):
        if "--query-gpu=" in args[0]:
            leaf = tmp_path / "cgroup" / "leaf"
            leaf.mkdir()
            (leaf / "memory.max").write_text("max")
            (leaf / "memory.current").write_text("0")
            (leaf / missing).unlink()
            return "GPU-test, 24, 20\n"
        return "GPU-test, 42\n"

    with pytest.raises(TelemetryUnavailable):
        sample(tmp_path, cgroup=tmp_path / "cgroup" / "leaf", smi=smi)


def test_limited_root_without_usage_fails_closed(tmp_path):
    def smi(args):
        if "--query-gpu=" in args[0]:
            (tmp_path / "cgroup" / "memory.current").unlink()
            return "GPU-test, 24, 20\n"
        return "GPU-test, 42\n"

    with pytest.raises(TelemetryUnavailable):
        sample(tmp_path, smi=smi)


@pytest.mark.parametrize("exists", [False, True])
def test_missing_or_empty_hierarchy_root_never_grants_host_memory(tmp_path, exists):
    root = tmp_path / "unmounted"
    if exists:
        root.mkdir()
    with pytest.raises(TelemetryUnavailable):
        sample(tmp_path, cgroup=root, cgroup_root=root)


def test_previous_boot_identity_does_not_trust_reused_pid_and_ticks(tmp_path):
    previous_boot = "e63e46db-8481-4ea9-bd48-0222f5a390da"
    result = sample(tmp_path, allowed_gpu_processes=frozenset({ProcessIdentity(42, 99, previous_boot)}))
    assert not result.telemetry.gpu_safe
    assert result.unknown_gpu_processes == (ProcessIdentity(42, 99, BOOT_ID),)


@pytest.mark.parametrize("boot_id", [None, "not-a-uuid"])
def test_missing_or_corrupt_boot_identity_fails_closed(tmp_path, boot_id):
    def smi(args):
        if "--query-gpu=" in args[0]:
            path = tmp_path / "proc" / "sys" / "kernel" / "random" / "boot_id"
            if boot_id is None:
                path.unlink()
            else:
                path.write_text(boot_id)
            return "GPU-test, 24, 20\n"
        return "GPU-test, 42\n"

    with pytest.raises(TelemetryUnavailable):
        sample(tmp_path, smi=smi)
