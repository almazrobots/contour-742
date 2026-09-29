"""T-238 execution fencing: synthetic payloads only; no OCR/GPU needed by these tests."""
from concurrent.futures import ThreadPoolExecutor
import json
import multiprocessing
from pathlib import Path
import shutil
from threading import Event
from uuid import uuid4

import pytest

from inspector_ml.cache import FileCache
from inspector_ml.pipeline_contract import digest
from inspector_ml.pipeline_execution import (
    ExecutionConflict, ExecutionJournal, ExecutionJournalError, request_digest,
)


class MemoryCache:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value):
        self.values[key] = value


REQUEST = {"stage": "parse", "body": {"page": 1, "source_sha": "a" * 64}}
REPLY = {"artifact": "b" * 64, "trace": "SYNTHETIC_PRIVATE_TRANSCRIPTION"}


def running_child(root, job, entered, release):
    journal = ExecutionJournal(Path(root), MemoryCache())

    def work():
        entered.set()
        if not release.wait(30):
            raise RuntimeError("test release not received")
        return REPLY

    journal.execute(job, 1, REQUEST, work)


@pytest.fixture
def journal(tmp_path):
    return ExecutionJournal(tmp_path, MemoryCache())


class ForbiddenReplay(BaseException):
    pass


def forbidden():
    # BaseException deliberately escapes the journal's callable-failure handler.
    raise ForbiddenReplay("execution must not be replayed")


def test_reply_replayed_after_new_journal_without_callable_or_plaintext_on_disk(journal):
    job = str(uuid4())
    first = journal.execute(job, 1, REQUEST, lambda: REPLY)
    assert first.status == "DONE" and first.reply == REPLY
    other = ExecutionJournal(journal.root, journal.cache)
    assert other.execute(job, 1, REQUEST, forbidden) == first
    assert other.probe(job, 1, request_digest(REQUEST)) == first
    disk = "".join(p.read_text() for p in journal.root.iterdir())
    assert "SYNTHETIC_PRIVATE_TRANSCRIPTION" not in disk
    assert "source_sha" not in disk and "parse" not in disk
    assert first.to_dict()["requires_remote_quiescence"] is False


def test_request_digest_uses_pipeline_canonical_numbers_and_stage(journal):
    assert request_digest({"x": 1.0}) == digest({"x": 1})
    assert request_digest({"x": 1.0}) == request_digest({"x": 1})
    job = str(uuid4())
    journal.execute(job, 1, REQUEST, lambda: REPLY)
    changed = {**REQUEST, "stage": "merge"}
    with pytest.raises(ExecutionConflict):
        journal.execute(job, 1, changed, forbidden)
    with pytest.raises(ExecutionConflict):
        journal.probe(job, 1, request_digest(changed))
    with pytest.raises(ExecutionConflict):
        journal.cancel_unstarted(job, 1, request_digest(changed))


def test_running_probe_duplicate_and_cancel_cannot_repeat_or_stop_callable(journal):
    entered, release = Event(), Event()
    job, calls = str(uuid4()), []

    def work():
        calls.append(1)
        entered.set()
        assert release.wait(10)
        return REPLY

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(journal.execute, job, 1, REQUEST, work)
        try:
            assert entered.wait(10)
            for snapshot in [journal.probe(job, 1), journal.execute(job, 1, REQUEST, forbidden),
                             journal.cancel_unstarted(job, 1, request_digest(REQUEST))]:
                assert snapshot.status == "RUNNING" and snapshot.reply is None
                assert snapshot.requires_remote_quiescence
            with pytest.raises(ExecutionConflict):
                journal.probe(job, 1, "f" * 64)
        finally:
            release.set()
        assert future.result().status == "DONE"
    assert calls == [1]


def test_absent_probe_is_not_cancel_but_tombstone_fences_late_post(journal):
    job = str(uuid4())
    assert journal.probe(job, 1).status == "ABSENT"
    sealed = journal.cancel_unstarted(job, 1, request_digest(REQUEST))
    assert sealed.status == "CANCELLED" and sealed.reply is None
    assert not sealed.requires_remote_quiescence
    assert journal.execute(job, 1, REQUEST, forbidden) == sealed
    assert ExecutionJournal(journal.root, journal.cache).cancel_unstarted(job, 1, request_digest(REQUEST)) == sealed
    # Another epoch is a distinct key; ONLY the coordinator may authorize this.
    assert journal.execute(job, 2, REQUEST, lambda: REPLY).status == "DONE"


def test_cancel_wins_race_before_delayed_post_has_started(journal):
    job = str(uuid4())
    delayed = Event()
    with ThreadPoolExecutor(max_workers=1) as executor:
        def late():
            assert delayed.wait(10)
            return journal.execute(job, 1, REQUEST, forbidden)
        future = executor.submit(late)
        assert journal.cancel_unstarted(job, 1, request_digest(REQUEST)).status == "CANCELLED"
        delayed.set()
        assert future.result().status == "CANCELLED"


@pytest.mark.l4_fault
def test_sigkill_owner_yields_interrupted_not_stopped_and_cannot_reexecute(journal):
    ctx = multiprocessing.get_context("spawn")
    entered, release = ctx.Event(), ctx.Event()
    job = str(uuid4())
    process = ctx.Process(target=running_child, args=(str(journal.root), job, entered, release))
    process.start()
    try:
        assert entered.wait(15)
        assert journal.probe(job, 1).status == "RUNNING"
        assert journal.execute(job, 1, REQUEST, forbidden).status == "RUNNING"
    finally:
        process.kill()
        process.join(10)
    assert not process.is_alive()
    snapshot = journal.probe(job, 1)
    assert snapshot.status == "INTERRUPTED" and snapshot.requires_remote_quiescence
    assert snapshot.reason == "owner_disappeared" and snapshot.reply is None
    assert journal.execute(job, 1, REQUEST, forbidden) == snapshot
    assert journal.cancel_unstarted(job, 1, request_digest(REQUEST)) == snapshot


@pytest.mark.l4_fault
def test_call_failure_stays_terminal_and_exception_text_never_reaches_disk(journal):
    job = str(uuid4())

    def broken():
        raise RuntimeError("SECRET_DOCUMENT_TEXT")

    snapshot = journal.execute(job, 1, REQUEST, broken)
    assert snapshot.status == "FAILED" and snapshot.reason == "call_failed"
    assert snapshot.requires_remote_quiescence
    assert "SECRET_DOCUMENT_TEXT" not in "".join(p.read_text() for p in journal.root.iterdir())
    assert journal.execute(job, 1, REQUEST, forbidden) == snapshot


@pytest.mark.l4_fault
@pytest.mark.parametrize("damage", ["lost", "corrupt", "unavailable"])
def test_done_without_valid_reply_never_becomes_success_or_new_execution(journal, damage):
    job = str(uuid4())
    assert journal.execute(job, 1, REQUEST, lambda: REPLY).status == "DONE"
    if damage == "lost":
        journal.cache.values.clear()
    elif damage == "corrupt":
        key = next(iter(journal.cache.values))
        journal.cache.values[key] = json.dumps({"forged": True})
    else:
        def down(key):
            raise ConnectionError("secret redis address")
        journal.cache.get = down
    snapshot = journal.probe(job, 1)
    assert snapshot.status == "FAILED" and snapshot.reply is None
    assert snapshot.reason == {"lost": "result_missing", "corrupt": "result_corrupt", "unavailable": "result_unavailable"}[damage]
    assert journal.execute(job, 1, REQUEST, forbidden) == snapshot


@pytest.mark.l4_fault
def test_cache_write_failure_and_crash_before_done_do_not_reinvoke_callable(journal, monkeypatch):
    job = str(uuid4())
    monkeypatch.setattr(journal.cache, "set", lambda *args: None)
    assert journal.execute(job, 1, REQUEST, lambda: REPLY).status == "FAILED"
    assert journal.execute(job, 1, REQUEST, forbidden).status == "FAILED"
    # A process can disappear after computing output, before publishing DONE.
    other = str(uuid4())
    def interrupted():
        raise SystemExit(137)
    with pytest.raises(SystemExit):
        journal.execute(other, 1, REQUEST, interrupted)
    assert journal.probe(other, 1).status == "INTERRUPTED"
    assert journal.execute(other, 1, REQUEST, forbidden).status == "INTERRUPTED"


@pytest.mark.l4_fault
def test_no_callable_if_running_fence_cannot_be_persisted(journal, monkeypatch):
    def broken(*args, **kwargs):
        raise OSError("disk unavailable")
    monkeypatch.setattr(journal, "_write", broken)
    with pytest.raises(OSError):
        journal.execute(str(uuid4()), 1, REQUEST, forbidden)


def test_corrupt_metadata_does_not_erase_fence_or_authorize_reexecution(journal):
    job = str(uuid4())
    path = journal.root / f"{job}.1.json"
    path.write_text("{corrupt")
    for operation in [lambda: journal.probe(job, 1), lambda: journal.cancel_unstarted(job, 1, request_digest(REQUEST)),
                      lambda: journal.execute(job, 1, REQUEST, forbidden)]:
        with pytest.raises(ExecutionJournalError):
            operation()
    assert path.read_text() == "{corrupt"


def test_invalid_identity_and_plaintext_reply_cache_rejected(tmp_path, journal):
    with pytest.raises(ValueError):
        ExecutionJournal(tmp_path, FileCache(tmp_path / "plain"))
    for job, epoch in [("../escape", 1), (str(uuid4()).upper(), 1), (str(uuid4()), 0), (str(uuid4()), True)]:
        with pytest.raises(ValueError):
            journal.execute(job, epoch, REQUEST, forbidden)


def test_lock_acquired_before_metadata_is_running_unknown_not_absent_or_cancelled(journal):
    job = str(uuid4())
    with journal._lock(f"{job}.1") as acquired:
        assert acquired
        snapshot = journal.probe(job, 1, request_digest(REQUEST))
        assert snapshot.status == "RUNNING" and snapshot.request_digest is None
        assert snapshot.reply is None and snapshot.requires_remote_quiescence
        assert journal.cancel_unstarted(job, 1, request_digest(REQUEST)).status == "RUNNING"
        assert journal.execute(job, 1, REQUEST, forbidden).status == "RUNNING"
    assert journal.cancel_unstarted(job, 1, request_digest(REQUEST)).status == "CANCELLED"


@pytest.mark.l4_fault
def test_transient_redis_outage_preserves_done_reference_and_recovers_without_execution(journal, monkeypatch):
    job = str(uuid4())
    calls = []

    def work():
        calls.append(1)
        return REPLY

    completed = journal.execute(job, 1, REQUEST, work)
    metadata = journal.root / f"{job}.1.json"
    committed = metadata.read_bytes()
    healthy_get = journal.cache.get

    def down(key):
        raise ConnectionError("temporary Redis outage")

    monkeypatch.setattr(journal.cache, "get", down)
    for observed in [journal.probe(job, 1), journal.execute(job, 1, REQUEST, forbidden)]:
        assert observed.status == "FAILED" and observed.reason == "result_unavailable"
        assert observed.reply is None and observed.requires_remote_quiescence
        assert metadata.read_bytes() == committed
    monkeypatch.setattr(journal.cache, "get", healthy_get)
    assert journal.probe(job, 1) == completed
    assert journal.execute(job, 1, REQUEST, forbidden) == completed
    assert calls == [1]


@pytest.fixture
def strict_journal(tmp_path):
    return ExecutionJournal(tmp_path / "executions-v2", MemoryCache(), journal_identity=str(uuid4()), initialize=True)


def test_strict_provisioning_is_explicit_once_and_restart_checks_pinned_identity(tmp_path):
    root, identity = tmp_path / "strict", str(uuid4())
    with pytest.raises(ExecutionJournalError):
        ExecutionJournal(root, MemoryCache(), journal_identity=identity)
    assert not root.exists()
    first = ExecutionJournal(root, MemoryCache(), journal_identity=identity, initialize=True)
    with pytest.raises(FileExistsError):
        ExecutionJournal(root, first.cache, journal_identity=identity, initialize=True)
    with pytest.raises(ExecutionJournalError):
        ExecutionJournal(root, first.cache, journal_identity=str(uuid4()))
    second = ExecutionJournal(root, first.cache, journal_identity=identity)
    job = str(uuid4())
    assert second.execute(job, 1, REQUEST, lambda: REPLY).status == "DONE"
    assert first.execute(job, 1, REQUEST, forbidden).status == "DONE"


@pytest.mark.l4_fault
@pytest.mark.parametrize("damage", ["state", "lock", "both", "root", "identity", "registry", "registry-lock", "replaced-lock"])
def test_strict_lost_state_never_becomes_absent_cancelled_or_new_execution(strict_journal, damage):
    journal, job = strict_journal, str(uuid4())
    # Model ML dying while the external Reader might still run. Its local metadata
    # must not be mistaken for an unstarted attempt if storage subsequently vanishes.
    with pytest.raises(SystemExit):
        journal.execute(job, 1, REQUEST, lambda: (_ for _ in ()).throw(SystemExit(137)))
    state = journal.root / f"{job}.1.json"
    lock = journal.root / f"{job}.1.lock"
    if damage in {"state", "both"}:
        state.unlink()
    if damage in {"lock", "both"}:
        lock.unlink()
    if damage == "root":
        shutil.rmtree(journal.root)
    if damage == "identity":
        (journal.root / "identity.json").unlink()
    if damage == "registry":
        (journal.root / "registry.json").unlink()
    if damage == "registry-lock":
        (journal.root / "registry.lock").unlink()
    if damage == "replaced-lock":
        # Retain the old inode, avoiding filesystem inode reuse in the test.
        lock.rename(lock.with_suffix(".retired"))
        lock.write_text("")
    for operation in [lambda: journal.probe(job, 1), lambda: journal.cancel_unstarted(job, 1, request_digest(REQUEST)),
                      lambda: journal.execute(job, 1, REQUEST, forbidden)]:
        with pytest.raises(ExecutionJournalError):
            operation()
    if damage == "root":
        assert not journal.root.exists()
    elif damage in {"state", "both"}:
        assert not state.exists()  # No replacement CANCELLED tombstone.
    elif damage == "lock":
        assert not lock.exists()  # No replacement inode while an old owner might live.
    if damage in {"root", "identity", "registry", "registry-lock"}:
        with pytest.raises(ExecutionJournalError):
            ExecutionJournal(journal.root, journal.cache, journal_identity=journal.identity)
    else:
        reopened = ExecutionJournal(journal.root, journal.cache, journal_identity=journal.identity)
        with pytest.raises(ExecutionJournalError):
            reopened.cancel_unstarted(job, 1, request_digest(REQUEST))


def test_strict_absent_placeholder_and_late_post_cancellation_survive_restart(strict_journal):
    journal, job = strict_journal, str(uuid4())
    assert journal.probe(job, 1).status == "ABSENT"
    reopened = ExecutionJournal(journal.root, journal.cache, journal_identity=journal.identity)
    assert reopened.probe(job, 1).status == "ABSENT"
    assert reopened.cancel_unstarted(job, 1, request_digest(REQUEST)).status == "CANCELLED"
    assert journal.execute(job, 1, REQUEST, forbidden).status == "CANCELLED"
    payload = "".join(path.read_text() for path in journal.root.iterdir())
    assert "source_sha" not in payload and "SYNTHETIC_PRIVATE_TRANSCRIPTION" not in payload


def test_strict_concurrent_first_observers_share_one_scope_lock(strict_journal):
    journal, job = strict_journal, str(uuid4())
    entered, release = Event(), Event()
    calls = []

    def work():
        calls.append(1)
        entered.set()
        assert release.wait(10)
        return REPLY

    with ThreadPoolExecutor(max_workers=2) as executor:
        running = executor.submit(journal.execute, job, 1, REQUEST, work)
        try:
            assert entered.wait(10)
            other = ExecutionJournal(journal.root, journal.cache, journal_identity=journal.identity)
            assert other.execute(job, 1, REQUEST, forbidden).status == "RUNNING"
            assert other.cancel_unstarted(job, 1, request_digest(REQUEST)).status == "RUNNING"
        finally:
            release.set()
        assert running.result().status == "DONE"
    assert calls == [1]


def test_strict_initialize_cli_is_offline_and_refuses_repeat(tmp_path, monkeypatch):
    from inspector_ml.pipeline_execution import main
    root = tmp_path / "cli"
    monkeypatch.setenv("INSPECTOR_PIPELINE_EXECUTIONS_DIR", str(root))
    monkeypatch.setenv("INSPECTOR_PIPELINE_JOURNAL_IDENTITY", str(uuid4()))
    monkeypatch.setattr("sys.argv", ["pipeline_execution", "--initialize"])
    main()
    assert (root / "identity.json").is_file()
    with pytest.raises(FileExistsError):
        main()
