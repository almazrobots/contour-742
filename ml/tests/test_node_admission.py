"""Real process/lock/storage faults; synthetic demands only, no GPU allocations."""
import multiprocessing
from pathlib import Path
import shutil
from uuid import uuid4

import pytest

from inspector_ml.node_admission import NodeAdmission, NodeAdmissionBusy, NodeAdmissionError
from inspector_ml.resource_admission import JobRef, Resources, StopProof, Telemetry

CAP = Resources(cpu=8000, ram=1000, vram=1000, pixels=1000, spool=1000, tokens=1000)
RESIDENT = Resources(ram=100, vram=400)


def owner(root, identity, **kwargs):
    return NodeAdmission(Path(root), journal_identity=identity, node_id="synthetic-node", policy_id="policy-v1",
                         capacity=CAP, resident=RESIDENT, **kwargs)


def demand(name):
    return JobRef(name, "synthetic-config", Resources(vram=100, ram=100))


def reserve(agent, now=1):
    return agent.reserve_next(Telemetry(now, Resources()), now=now)


def reserved_child(root, identity, ready, release):
    with owner(root, identity) as agent:
        agent.enqueue(demand("old-worker"))
        decision = reserve(agent)
        ready.send(decision.reservation.token)
        if not release.wait(30):
            raise RuntimeError("parent did not terminate or release synthetic owner")


def test_explicit_provision_once_and_exclusive_owner(tmp_path):
    root, identity = tmp_path / "node", str(uuid4())
    with pytest.raises(NodeAdmissionError):
        owner(root, identity)
    assert not root.exists()
    with owner(root, identity, initialize=True) as first:
        with pytest.raises(NodeAdmissionBusy):
            owner(root, identity)
        with pytest.raises(FileExistsError):
            owner(root, identity, initialize=True)
        assert first.snapshot() == ()
    with owner(root, identity) as second:
        assert second.snapshot() == ()
    with pytest.raises(NodeAdmissionError):
        owner(root, str(uuid4()))


@pytest.mark.l4_fault
def test_sigkill_after_durable_reserve_restores_unknown_until_real_supervisor_proof(tmp_path):
    root, identity = tmp_path / "node", str(uuid4())
    owner(root, identity, initialize=True).close()
    ctx = multiprocessing.get_context("spawn")
    receiving, sending = ctx.Pipe(duplex=False)
    release = ctx.Event()
    child = ctx.Process(target=reserved_child, args=(str(root), identity, sending, release))
    child.start()
    sending.close()
    try:
        assert receiving.poll(15), "child failed before durable reserve"
        token = receiving.recv()
        with pytest.raises(NodeAdmissionBusy):
            owner(root, identity)
    finally:
        if child.is_alive():
            child.kill()
        child.join(10)
        receiving.close()
    assert not child.is_alive()
    with owner(root, identity) as recovered:
        assert recovered.snapshot()[0].state == "UNKNOWN"
        assert recovered.snapshot()[0].token == token
        recovered.enqueue(demand("next-worker"))
        assert reserve(recovered, now=100).reason == "gpu_group_unavailable"
        assert not recovered.heartbeat("old-worker", token, now=101)
        assert not recovered.release("old-worker", StopProof(token, False, True))
        assert not recovered.release("old-worker", StopProof(token, True, False))
        assert not recovered.release("old-worker", StopProof("foreign", True, True))
        assert recovered.release("old-worker", StopProof(token, True, True))
        assert reserve(recovered, now=102).action == "admit"


@pytest.mark.l4_fault
@pytest.mark.parametrize("damage", ["state", "identity", "lock", "root", "corrupt", "duplicate", "nan", "replaced-lock"])
def test_missing_or_corrupt_journal_never_opens_empty_admission(tmp_path, damage):
    root, identity = tmp_path / "node", str(uuid4())
    with owner(root, identity, initialize=True) as agent:
        agent.enqueue(demand("running"))
        assert reserve(agent).action == "admit"
    if damage in {"state", "identity", "lock"}:
        (root / {"state": "state.json", "identity": "identity.json", "lock": "owner.lock"}[damage]).unlink()
    elif damage == "root":
        shutil.rmtree(root)
    elif damage == "corrupt":
        (root / "state.json").write_text("{broken")
    elif damage == "duplicate":
        raw = (root / "state.json").read_text()
        (root / "state.json").write_text('{"schema":"node-admission.v1",' + raw[1:])
    elif damage == "nan":
        (root / "state.json").write_text('{"state":NaN}')
    else:
        (root / "owner.lock").rename(root / "old-owner.lock")
        (root / "owner.lock").touch()
    with pytest.raises(NodeAdmissionError):
        owner(root, identity)
    if damage == "root":
        assert not root.exists()
    elif damage == "state":
        assert not (root / "state.json").exists()


def test_all_mutations_are_visible_on_disk_before_return_and_oom_persists(tmp_path):
    root, identity = tmp_path / "node", str(uuid4())
    with owner(root, identity, initialize=True) as agent:
        before = (root / "state.json").read_bytes()
        agent.enqueue(demand("a"))
        assert (root / "state.json").read_bytes() != before
        r = reserve(agent).reservation
        assert r.token in (root / "state.json").read_text()
        assert agent.heartbeat("a", r.token, now=2)
        assert '"ACTIVE"' in (root / "state.json").read_text()
        agent.expire(now=100)
        assert '"UNKNOWN"' in (root / "state.json").read_text()
        assert agent.release("a", StopProof(r.token, True, True), oom=True)
        assert r.token not in (root / "state.json").read_text()
        cpu = JobRef("cpu", "other-config", Resources(), gpu_group=False)
        agent.enqueue(cpu)
        assert agent.cancel_queued("cpu")
    with owner(root, identity) as reopened:
        assert reopened.enqueue(demand("same-config-retry")).reason == "oom_configuration"
        assert reserve(reopened).reason == "empty"


@pytest.mark.l4_fault
@pytest.mark.parametrize("failure_boundary", ["before_replace", "after_replace"])
def test_failed_snapshot_write_returns_no_grant_and_poisoned_owner_cannot_continue(tmp_path, monkeypatch, failure_boundary):
    import inspector_ml.node_admission as module
    root, identity = tmp_path / "node", str(uuid4())
    agent = owner(root, identity, initialize=True)
    agent.enqueue(demand("pending"))
    saved = (root / "state.json").read_bytes()
    atomic = module._atomic

    def broken(*args):
        if failure_boundary == "after_replace":
            atomic(*args)
        raise OSError("injected fsync/storage failure")

    monkeypatch.setattr(module, "_atomic", broken)
    try:
        with pytest.raises(NodeAdmissionError):
            reserve(agent)
        assert ((root / "state.json").read_bytes() == saved) == (failure_boundary == "before_replace")
        with pytest.raises(NodeAdmissionError):
            agent.enqueue(demand("must-not-start"))
        with pytest.raises(NodeAdmissionError):
            agent.snapshot()
        with pytest.raises(NodeAdmissionBusy):
            owner(root, identity)
    finally:
        agent.close()
        monkeypatch.setattr(module, "_atomic", atomic)
    with owner(root, identity) as recovered:
        if failure_boundary == "before_replace":
            assert recovered.snapshot() == ()  # Failed reserve never granted permission to allocate.
            assert reserve(recovered).action == "admit"
        else:
            # Durable bytes may have landed before a write/ack failure. Recovery cannot
            # infer that the reservation was unused merely because the caller saw an error.
            assert recovered.snapshot()[0].state == "UNKNOWN"
            recovered.enqueue(demand("next"))
            assert reserve(recovered).reason == "gpu_group_unavailable"


def test_storage_loss_while_owner_lives_poison_admission_without_recreating_snapshot(tmp_path):
    root, identity = tmp_path / "node", str(uuid4())
    with owner(root, identity, initialize=True) as agent:
        (root / "state.json").unlink()
        with pytest.raises(NodeAdmissionError):
            agent.enqueue(demand("blocked"))
        assert not (root / "state.json").exists()


def test_foreign_policy_rejected_without_overwriting_existing_state(tmp_path):
    root, identity = tmp_path / "node", str(uuid4())
    owner(root, identity, initialize=True).close()
    original = (root / "state.json").read_bytes()
    with pytest.raises(NodeAdmissionError):
        NodeAdmission(root, journal_identity=identity, node_id="synthetic-node", policy_id="different-policy",
                      capacity=CAP, resident=RESIDENT)
    assert (root / "state.json").read_bytes() == original
