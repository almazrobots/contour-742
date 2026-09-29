"""T-239: synthetic admission decisions, no model imports or GPU allocations."""
from concurrent.futures import ThreadPoolExecutor

import pytest

from inspector_ml.resource_admission import AdmissionLedger, JobRef, Resources, StopProof, Telemetry


CAP = Resources(cpu=8000, ram=1000, vram=1000, pixels=1000, spool=1000, tokens=1000)
RESIDENT = Resources(ram=100, vram=400)


def ledger(**kwargs):
    return AdmissionLedger(CAP, RESIDENT, **kwargs)


def job(name="j", **kwargs):
    return JobRef(name, "config", Resources(**kwargs))


def reserve(l, now=1, external=Resources()):
    return l.reserve_next(Telemetry(now, external), now=now)


def test_concurrent_admission_reserves_whole_group_before_start():
    l = ledger()
    for i in range(20):
        l.enqueue(job(str(i), vram=200))
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda _: reserve(l), range(20)))
    assert sum(r.action == "admit" for r in results) == 1
    assert len(l.snapshot()) == 1
    assert l.snapshot()[0].state == "RESERVED"


@pytest.mark.parametrize("dimension", ["cpu", "ram", "vram", "pixels", "spool", "tokens"])
def test_capacity_accounts_resident_external_and_active(dimension):
    l = ledger()
    demand = getattr(CAP, dimension) - getattr(RESIDENT, dimension)
    l.enqueue(job(**{dimension: demand}))
    assert reserve(l, external=Resources(**{dimension: 1})).reason == f"capacity:{dimension}"
    assert reserve(l).action == "admit"
    over = ledger().enqueue(job(**{dimension: demand + 1}))
    assert over.action == "reject" and over.reason == f"capacity:{dimension}"


def test_expired_live_worker_keeps_reservation_and_blocks_new_load():
    l = ledger()
    l.enqueue(job("a", ram=200))
    first = reserve(l).reservation
    l.enqueue(job("b"))
    assert reserve(l, now=100).reason == "gpu_group_unavailable"
    assert l.snapshot()[0].state == "UNKNOWN"
    assert not l.heartbeat("a", first.token, now=101)
    assert not l.release("a", StopProof(first.token, False, True))
    assert not l.release("a", StopProof(first.token, True, False))
    assert not l.release("a", StopProof("foreign", True, True))
    assert l.release("a", StopProof(first.token, True, True))
    assert reserve(l, now=102).action == "admit"


def test_stale_telemetry_blocks_admit_but_not_cleanup():
    l = ledger()
    l.enqueue(job("a"))
    first = reserve(l).reservation
    l.enqueue(job("b"))
    assert l.reserve_next(Telemetry(1, Resources()), now=9).reason == "stale_telemetry"
    assert l.release("a", StopProof(first.token, True, True))
    assert l.cancel_queued("b")


def test_queue_bounded_refs_identity_and_no_payloads():
    l = ledger(queue_limit=1)
    assert l.enqueue(job()).reason == "queued"
    assert l.enqueue(job()).reason == "queued"
    assert l.enqueue(job(ram=1)).reason == "identity_conflict"
    assert l.enqueue(job("other")).reason == "queue_full"
    with pytest.raises(ValueError):
        job("x" * 129)
    with pytest.raises(ValueError):
        job("embedded text payload")


def test_oom_same_configuration_not_retried():
    l = ledger()
    l.enqueue(job("a"))
    first = reserve(l).reservation
    l.enqueue(job("b"))
    assert l.release("a", StopProof(first.token, True, True), oom=True)
    assert reserve(l).reason == "oom_configuration"
    assert l.enqueue(job("c")).reason == "oom_configuration"
    assert l.enqueue(JobRef("d", "smaller-batch", Resources(vram=10))).reason == "queued"
    assert reserve(l).action == "admit"


def test_cpu_jobs_share_capacity_without_gpu_exclusivity():
    l = ledger()
    for name in ("a", "b", "c"):
        l.enqueue(JobRef(name, "cfg", Resources(ram=400), gpu_group=False))
    assert reserve(l).action == "admit"
    assert reserve(l).action == "admit"
    assert reserve(l).reason == "capacity:ram"


@pytest.mark.parametrize("value", [-1, True, 1.5, float("nan")])
def test_invalid_budget_rejected(value):
    with pytest.raises(ValueError):
        Resources(ram=value)


@pytest.mark.parametrize("observed", [float("nan"), float("inf"), 2])
def test_invalid_or_future_telemetry_does_not_admit(observed):
    l = ledger()
    l.enqueue(job())
    assert l.reserve_next(Telemetry(observed, Resources()), now=1).reason == "stale_telemetry"


def test_late_heartbeat_cannot_revive_expired_attempt():
    l = ledger()
    l.enqueue(job())
    r = reserve(l).reservation
    assert not l.heartbeat("j", r.token, now=99)
    assert l.snapshot()[0].state == "UNKNOWN"


def test_zero_demand_reservations_are_bounded():
    l = ledger(queue_limit=1)
    l.enqueue(JobRef("a", "cfg", Resources(), gpu_group=False))
    assert reserve(l).action == "admit"
    l.enqueue(JobRef("b", "cfg", Resources(), gpu_group=False))
    assert reserve(l).reason == "reservation_limit"


def saved(l):
    import json
    return json.loads(json.dumps(l.export_state(node_id="node-1", policy_id="policy-1")))


def restored(state, **kwargs):
    return AdmissionLedger.restore_state(state, node_id="node-1", policy_id="policy-1",
                                         capacity=CAP, resident=RESIDENT, **kwargs)


def test_restart_preserves_reserved_capacity_and_requires_stop_proof():
    l = ledger()
    l.enqueue(job("active", ram=200, vram=100))
    r = reserve(l).reservation
    assert l.heartbeat("active", r.token, now=2)
    l.enqueue(job("next"))
    state = saved(l)
    recovered = restored(state)
    prior = recovered.snapshot()[0]
    assert prior.job == r.job and prior.token == r.token
    assert prior.state == "UNKNOWN" and prior.heartbeat_at == 0
    assert not recovered.heartbeat("active", r.token, now=0.01)
    assert reserve(recovered, now=0.01).reason == "gpu_group_unavailable"
    assert recovered.release("active", StopProof(r.token, True, True))
    assert reserve(recovered, now=0.02).reservation.job.job_id == "next"
    assert state == saved(l)  # restore did not alter input or original owner


def test_restart_restores_unstarted_reservation_as_unknown():
    l = ledger()
    l.enqueue(job())
    r = reserve(l).reservation
    recovered = restored(saved(l))
    assert recovered.snapshot()[0].state == "UNKNOWN"
    assert not recovered.release("j", StopProof(r.token, False, True))


def test_restart_keeps_oom_policy_and_quarantine():
    l = ledger(queue_limit=1)
    l.enqueue(job())
    r = reserve(l).reservation
    l.release("j", StopProof(r.token, True, True), oom=True)
    recovered = restored(saved(l), queue_limit=1)
    assert recovered.enqueue(JobRef("new", "different", Resources())).reason == "oom_configuration"
    assert saved(recovered)["oom_configs"] == ["config"]
    assert saved(recovered)["quarantined"] is True


def test_export_is_detached_and_queue_order_survives():
    l = ledger()
    l.enqueue(job("first"))
    l.enqueue(job("second"))
    state = saved(l)
    state["queue"][0]["job_id"] = "mutated"
    assert saved(l)["queue"][0]["job_id"] == "first"
    recovered = restored(saved(l))
    assert reserve(recovered).reservation.job.job_id == "first"


@pytest.mark.parametrize("key,value", [
    ("schema", True), ("schema", 3), ("node_id", "another-node"),
    ("policy_id", "another-policy"), ("queue_limit", True), ("queue_limit", 65),
    ("telemetry_ttl", float("nan")), ("heartbeat_ttl", True),
    ("quarantined", 1), ("oom_configs", ["bad value"]),
    ("oom_configs", ["dup", "dup"]), ("queue", {}), ("reservations", {}),
])
def test_restore_rejects_invalid_identity_policy_or_shape(key, value):
    state = saved(ledger())
    state[key] = value
    with pytest.raises(ValueError):
        restored(state)


def test_restore_rejects_unknown_fields_and_changed_resources():
    state = saved(ledger())
    state["extra"] = 1
    with pytest.raises(ValueError):
        restored(state)
    del state["extra"]
    state["capacity"]["vram"] += 1
    with pytest.raises(ValueError):
        restored(state)


@pytest.mark.parametrize("mutation", ["token", "duplicate", "overcommit", "heartbeat", "extra", "queue_collision", "state"])
def test_restore_rejects_corrupt_reservation_accounting(mutation):
    import copy
    l = ledger()
    l.enqueue(job())
    reserve(l)
    state = saved(l)
    r = state["reservations"][0]
    if mutation == "token":
        r["token"] = "not-a-uuid"
    elif mutation == "duplicate":
        state["reservations"].append(copy.deepcopy(r))
    elif mutation == "overcommit":
        r["job"]["resources"]["ram"] = 1001
    elif mutation == "heartbeat":
        r["heartbeat_at"] = float("inf")
    elif mutation == "extra":
        r["extra"] = "field"
    elif mutation == "queue_collision":
        state["queue"].append(copy.deepcopy(r["job"]))
    else:
        r["state"] = "DONE"
    with pytest.raises(ValueError):
        restored(state)


def test_restore_rejects_two_gpu_groups_with_distinct_ids():
    import copy
    from uuid import uuid4
    l = ledger()
    l.enqueue(job())
    reserve(l)
    state = saved(l)
    second = copy.deepcopy(state["reservations"][0])
    second["job"]["job_id"] = "another"
    second["token"] = str(uuid4())
    state["reservations"].append(second)
    with pytest.raises(ValueError):
        restored(state)


def test_restore_bounds_queue_and_oom_history():
    state = saved(ledger(queue_limit=1))
    state["queue"] = [{"job_id": "x", "config_id": "c", "resources": {}, "gpu_group": True}] * 2
    with pytest.raises(ValueError):
        restored(state, queue_limit=1)
    state["queue"] = []
    state["oom_configs"] = ["a", "b", "c"]
    state["quarantined"] = True
    with pytest.raises(ValueError):
        restored(state, queue_limit=1)


def interactive(name, **resources):
    return JobRef(name, "interactive-cfg", Resources(**resources), priority="interactive")


def finish_next(l):
    decision = reserve(l)
    assert decision.action == "admit"
    r = decision.reservation
    assert l.release(r.job.job_id, StopProof(r.token, True, True))
    return r.job.job_id


def test_interactive_priority_preserves_fifo_with_bounded_batch_delay():
    l = ledger()
    for i in range(3):
        l.enqueue(job(f"b{i}"))
    for i in range(8):
        l.enqueue(interactive(f"i{i}"))
    assert [finish_next(l) for _ in range(11)] == [
        "i0", "i1", "i2", "b0", "i3", "i4", "i5", "b1", "i6", "i7", "b2",
    ]


def test_continuous_interactive_arrival_does_not_starve_batch():
    l = ledger()
    l.enqueue(job("oldest-batch"))
    for i in range(3):
        l.enqueue(interactive(f"i{i}"))
        assert finish_next(l) == f"i{i}"
    l.enqueue(interactive("new-interactive"))
    assert finish_next(l) == "oldest-batch"
    assert finish_next(l) == "new-interactive"


def test_restart_does_not_reset_fairness_turn():
    l = ledger()
    l.enqueue(job("batch"))
    for i in range(3):
        l.enqueue(interactive(f"i{i}"))
        assert finish_next(l) == f"i{i}"
    l.enqueue(interactive("pending"))
    recovered = restored(saved(l))
    assert saved(recovered)["interactive_streak"] == 3
    assert finish_next(recovered) == "batch"
    assert saved(recovered)["interactive_streak"] == 0
    assert finish_next(recovered) == "pending"


def test_waiting_for_due_batch_does_not_allow_interactive_bypass():
    l = ledger()
    l.enqueue(job("batch", ram=900))
    for i in range(3):
        l.enqueue(interactive(f"i{i}"))
        assert finish_next(l) == f"i{i}"
    l.enqueue(interactive("fits"))
    assert reserve(l, external=Resources(ram=1)).reason == "capacity:ram"
    assert saved(l)["interactive_streak"] == 3
    assert finish_next(l) == "batch"


def test_wait_and_rejection_do_not_consume_interactive_turn():
    l = ledger()
    l.enqueue(job("batch"))
    l.enqueue(interactive("too-busy", ram=900))
    assert reserve(l, external=Resources(ram=1)).action == "wait"
    assert saved(l)["interactive_streak"] == 0
    assert l.enqueue(interactive("impossible", ram=901)).action == "reject"
    assert saved(l)["interactive_streak"] == 0
    assert finish_next(l) == "too-busy"
    assert saved(l)["interactive_streak"] == 1


def test_priority_change_cannot_rebind_queued_job_identity():
    l = ledger()
    l.enqueue(job("same"))
    assert l.enqueue(JobRef("same", "config", Resources(), priority="interactive")).reason == "identity_conflict"


@pytest.mark.parametrize("priority", ["urgent", None, True, 1])
def test_invalid_priority_rejected(priority):
    with pytest.raises(ValueError):
        JobRef("j", "c", Resources(), priority=priority)


@pytest.mark.parametrize("streak", [-1, 4, True, 1.5, None])
def test_restore_rejects_invalid_fairness_counter(streak):
    state = saved(ledger())
    state["interactive_streak"] = streak
    with pytest.raises(ValueError):
        restored(state)


def test_legacy_snapshot_restores_as_batch_without_reviving_active_owner():
    l = ledger()
    l.enqueue(job("active"))
    reserve(l)
    l.enqueue(job("queued"))
    state = saved(l)
    state["schema"] = 1
    del state["interactive_streak"]
    for entry in state["queue"]:
        del entry["priority"]
    for entry in state["reservations"]:
        del entry["job"]["priority"]
    recovered = restored(state)
    assert recovered.snapshot()[0].state == "UNKNOWN"
    assert recovered.snapshot()[0].job.priority == "batch"
    assert saved(recovered)["interactive_streak"] == 0
    assert saved(recovered)["queue"][0]["priority"] == "batch"
    assert saved(recovered)["schema"] == 2
