"""Fixed Reader actuator faults, with synthetic Docker/proc/driver observations."""
import json
import subprocess

from fastapi.testclient import TestClient
import pytest

from inspector_ml.reader_lifecycle import ReaderLifecycle, ReaderPolicy, create_app

CONTAINER = "a" * 64
IDENTITY = "2f348314-47d5-46dc-a04e-6bbab0a4ef92"
GPU = "GPU-d08b815b-bdc4-4410-8327-c008f91bb3e7"
BOOT = "20f33f5f-6053-450f-97e0-9e14077a4dc6"


class Host:
    def __init__(self, tmp_path):
        self.proc = tmp_path / "proc"
        boot = self.proc / "sys/kernel/random"
        boot.mkdir(parents=True)
        (boot / "boot_id").write_text(BOOT)
        self.cgroup_root = tmp_path / "cgroup"
        directory = self.cgroup_root / "system.slice" / f"docker-{CONTAINER}.scope"
        directory.mkdir(parents=True)
        self.events = directory / "memory.events"
        self.events.write_text("low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n")
        self.oom_killed = False
        self.calls = []
        self.running = True
        self.restart = "no"
        self.foreign = False
        self.timeout = False
        self.orphan = False
        self.driver_lost = False
        self.wrong_port = False
        self.add_process()

    def add_process(self):
        directory = self.proc / "42"
        directory.mkdir(exist_ok=True)
        (directory / "stat").write_text("42 (Reader worker) " + " ".join(["S"] + ["0"] * 18 + ["99"]))
        (directory / "cgroup").write_text(f"0::/system.slice/docker-{CONTAINER}.scope\n")

    def run(self, args):
        self.calls.append(args)
        if args[0] == "/usr/bin/nvidia-smi":
            if self.driver_lost:
                raise subprocess.CalledProcessError(1, args)
            if args[1] == "--query-gpu=uuid,memory.total,memory.used":
                return GPU + ", 24576, 12000\n"
            return f"{GPU}, 42\n" if self.running or self.orphan else ""
        if args[1] == "inspect":
            return json.dumps([{"Id": "b" * 64 if self.foreign else CONTAINER,
                "Name": "/vllm-reader", "HostConfig": {"RestartPolicy": {"Name": self.restart},
                    "PortBindings": {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "9999" if self.wrong_port else "8000"}]}},
                "NetworkSettings": {"Ports": {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "9999" if self.wrong_port else "8000"}]} if self.running else {}},
                "State": {"Running": self.running, "Pid": 42 if self.running else 0, "OOMKilled": self.oom_killed}}])
        if self.timeout:
            raise subprocess.TimeoutExpired(args, 45)
        if args[1] == "stop":
            self.running = False
            if not self.orphan:
                for path in (self.proc / "42").iterdir():
                    path.unlink()
                (self.proc / "42").rmdir()
        elif args[1] == "start":
            self.running = True
            self.add_process()
        else:
            raise AssertionError(args)
        return CONTAINER


@pytest.fixture
def fixture(tmp_path):
    host = Host(tmp_path)
    policy = ReaderPolicy(IDENTITY, CONTAINER, "vllm-reader", GPU)
    client = TestClient(create_app(ReaderLifecycle(policy, run=host.run, proc=host.proc, cgroup_root=host.cgroup_root, healthy=lambda: True)))
    return host, client


def request(client, operation):
    return client.post("/" + operation, json={"policy_identity": IDENTITY})


def test_probe_returns_pinned_process_identity_without_commands(fixture):
    host, client = fixture
    result = request(client, "probe")
    assert result.status_code == 200
    assert result.json()["ready"] and not result.json()["stopped"]
    assert result.json()["gpu_processes"] == [{"pid": 42, "start_ticks": 99, "boot_id": BOOT}]
    assert result.json()["gpu_uuid"] == GPU
    assert all(call[1] not in {"start", "stop"} for call in host.calls)


def test_stop_and_start_only_pinned_container_and_idempotent(fixture):
    host, client = fixture
    assert request(client, "stop").json()["stopped"]
    assert request(client, "stop").json()["stopped"]
    assert request(client, "start").json()["running"]
    assert request(client, "start").json()["running"]
    commands = [call for call in host.calls if call[1] in {"start", "stop"}]
    assert commands == [["/usr/bin/docker", "stop", "--time", "30", CONTAINER],
                        ["/usr/bin/docker", "start", CONTAINER]]


@pytest.mark.parametrize("fault", ["foreign", "timeout", "orphan", "driver_lost"])
def test_uncertain_stop_never_returns_success(fixture, fault):
    host, client = fixture
    setattr(host, fault, True)
    assert request(client, "stop").status_code == 503


def test_unmanaged_restart_policy_refuses_control(fixture):
    host, client = fixture
    host.restart = "unless-stopped"
    assert request(client, "stop").status_code == 503
    assert not any(call[1] == "stop" for call in host.calls)


def test_foreign_policy_and_arbitrary_arguments_never_reach_docker(fixture):
    host, client = fixture
    assert client.post("/stop", json={"policy_identity": "foreign"}).status_code == 409
    assert client.post("/stop", json={"policy_identity": IDENTITY, "container_id": "other"}).status_code == 422
    assert request(client, "exec").status_code == 404
    assert host.calls == []


def test_driver_pid_without_proc_identity_is_unknown(fixture):
    host, client = fixture
    original = host.run
    def run(args):
        if args[1] == "--query-compute-apps=gpu_uuid,pid":
            return f"{GPU}, 777\n"
        return original(args)
    policy = ReaderPolicy(IDENTITY, CONTAINER, "vllm-reader", GPU)
    client = TestClient(create_app(ReaderLifecycle(policy, run=run, proc=host.proc, cgroup_root=host.cgroup_root)))
    assert request(client, "probe").status_code == 503


def test_orphan_after_stop_cannot_be_replaced_by_new_reader(fixture):
    host, client = fixture
    host.orphan = True
    assert request(client, "stop").status_code == 503
    assert request(client, "start").status_code == 503
    assert not any(call[1] == "start" for call in host.calls)


def test_unrelated_health_endpoint_never_marks_reader_ready(fixture):
    host, client = fixture
    host.wrong_port = True
    assert request(client, "probe").status_code == 503


def test_real_private_unix_transport_bounds_requests(tmp_path):
    import http.client
    import socket
    from threading import Thread
    from inspector_ml.reader_lifecycle import unix_server

    host = Host(tmp_path)
    lifecycle = ReaderLifecycle(ReaderPolicy(IDENTITY, CONTAINER, "vllm-reader", GPU),
                                run=host.run, proc=host.proc, cgroup_root=host.cgroup_root, healthy=lambda: True)
    path = tmp_path / "reader.sock"
    with unix_server(path, lifecycle) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        def call(body, route="/probe"):
            connection = http.client.HTTPConnection("localhost", timeout=5)
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(5)
            connection.sock.connect(str(path))
            try:
                try:
                    connection.request("POST", route, body=body)
                except BrokenPipeError:
                    # A bounded endpoint may reject the headers before the
                    # client writes the body. Still verify the real HTTP reply.
                    pass
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        try:
            code, body = call(json.dumps({"policy_identity": IDENTITY}))
            assert code == 200 and body["ready"]
            assert call(json.dumps({"policy_identity": "foreign"}))[0] == 409
            assert call(json.dumps({"policy_identity": IDENTITY, "args": "other"}))[0] == 422
            assert call("x" * 1025)[0] == 413
            assert call("{bad}")[0] == 400
            assert call("{}", "/exec")[0] == 404
        finally:
            server.shutdown()
            thread.join(timeout=5)


def test_live_reader_child_oom_is_reported_and_survives_stop(fixture):
    host, client = fixture
    host.events.write_text("oom 2\noom_kill 1\n")
    result = request(client, "probe").json()
    assert result["running"] and result["oom_killed"]
    assert result["oom_count"] == 2 and result["oom_kill_count"] == 1
    stopped = request(client, "stop").json()
    assert stopped["stopped"] and stopped["oom_killed"]
    assert stopped["oom_kill_count"] is None


def test_stopped_docker_oom_evidence_does_not_require_cgroup(fixture):
    host, client = fixture
    request(client, "stop")
    host.oom_killed = True
    host.events.unlink()
    result = request(client, "probe").json()
    assert result["stopped"] and result["oom_killed"]
    assert result["oom_count"] is None and result["oom_kill_count"] is None


@pytest.mark.parametrize("contents", ["oom 0\n", "oom 0\noom_kill -1\n", "oom 0\noom_kill 0\noom_kill 1\n"])
def test_live_reader_missing_or_malformed_oom_evidence_is_unknown(fixture, contents):
    host, client = fixture
    host.events.write_text(contents)
    assert request(client, "probe").status_code == 503
    host.events.unlink()
    assert request(client, "probe").status_code == 503


def test_docker_oom_flag_must_be_boolean(fixture):
    host, client = fixture
    host.oom_killed = "false"
    assert request(client, "probe").status_code == 503


def test_oom_during_probe_is_observed(fixture):
    host, client = fixture
    original = host.run
    def run(args):
        if args[1] == "--query-compute-apps=gpu_uuid,pid":
            host.events.write_text("oom 1\noom_kill 1\n")
        return original(args)
    lifecycle = ReaderLifecycle(ReaderPolicy(IDENTITY, CONTAINER, "vllm-reader", GPU),
        run=run, proc=host.proc, cgroup_root=host.cgroup_root, healthy=lambda: True)
    assert lifecycle.action("probe")["oom_killed"]


def test_oom_counter_reset_during_probe_is_unknown(fixture):
    host, _ = fixture
    host.events.write_text("oom 1\noom_kill 1\n")
    original = host.run
    def run(args):
        if args[1] == "--query-compute-apps=gpu_uuid,pid":
            host.events.write_text("oom 0\noom_kill 0\n")
        return original(args)
    lifecycle = ReaderLifecycle(ReaderPolicy(IDENTITY, CONTAINER, "vllm-reader", GPU),
        run=run, proc=host.proc, cgroup_root=host.cgroup_root)
    from inspector_ml.reader_lifecycle import LifecycleUnavailable
    with pytest.raises(LifecycleUnavailable, match="reset"):
        lifecycle.action("probe")


def test_oom_probe_refuses_unpinned_cgroup(fixture):
    host, client = fixture
    (host.proc / "42/cgroup").write_text("0::/system.slice/foreign.scope\n")
    assert request(client, "probe").status_code == 503
    assert not any(call[1] in {"start", "stop"} for call in host.calls)


def test_host_gpu_observation_includes_unrelated_compute_owners(fixture):
    import time
    host, _ = fixture
    directory = host.proc / "777"
    directory.mkdir()
    (directory / "stat").write_text("777 (other worker) " + " ".join(["S"] + ["0"] * 18 + ["123"]))
    (directory / "cgroup").write_text("0::/system.slice/unrelated.scope\n")
    original = host.run
    def run(args):
        if args[1] == "--query-compute-apps=gpu_uuid,pid":
            return f"{GPU}, 42\n{GPU}, 777\n"
        return original(args)
    lifecycle = ReaderLifecycle(ReaderPolicy(IDENTITY, CONTAINER, "vllm-reader", GPU),
        run=run, proc=host.proc, cgroup_root=host.cgroup_root, healthy=lambda: True)
    before = time.monotonic()
    result = lifecycle.action("probe")
    observation = result["gpu_observation"]
    assert before <= observation["observed_at"] <= time.monotonic()
    assert observation["gpu_uuid"] == GPU
    assert observation["total_bytes"] == 24576 * 1024 * 1024
    assert observation["used_bytes"] == 12000 * 1024 * 1024
    assert observation["processes"] == [
        {"pid": 42, "start_ticks": 99, "boot_id": BOOT},
        {"pid": 777, "start_ticks": 123, "boot_id": BOOT}]
    assert result["gpu_processes"] == [{"pid": 42, "start_ticks": 99, "boot_id": BOOT}]
    assert not any(call[1] in {"start", "stop"} for call in host.calls)


@pytest.mark.parametrize("memory", ["24576, 24577", "24576, -1", "N/A, 0", "0, 0", "24576"])
def test_invalid_host_gpu_memory_is_unknown(fixture, memory):
    host, _ = fixture
    original = host.run
    def run(args):
        if args[1] == "--query-gpu=uuid,memory.total,memory.used":
            return f"{GPU}, {memory}\n"
        return original(args)
    lifecycle = ReaderLifecycle(ReaderPolicy(IDENTITY, CONTAINER, "vllm-reader", GPU),
        run=run, proc=host.proc, cgroup_root=host.cgroup_root)
    from inspector_ml.reader_lifecycle import LifecycleUnavailable
    with pytest.raises(LifecycleUnavailable):
        lifecycle.action("probe")
