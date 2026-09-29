"""Fixed-container Reader actuator; only the supervisor decides admission.

Run on the HOST with a root-owned policy and a private Unix socket. Never expose
this app over TCP or mount docker.sock into ML. The socket directory is owned by
the launcher and grants access only to the supervisor uid. This helper does not
seal execution-proxy epochs: the supervisor must do that separately.
"""
from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import re
import subprocess
import time
from threading import RLock
import urllib.request
from uuid import UUID

from .resource_telemetry import process_identity


class LifecycleUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class ReaderPolicy:
    policy_identity: str
    container_id: str
    container_name: str
    gpu_uuid: str

    def __post_init__(self):
        if str(UUID(self.policy_identity)) != self.policy_identity:
            raise ValueError("canonical policy UUID required")
        if not re.fullmatch(r"[0-9a-f]{64}", self.container_id):
            raise ValueError("full pinned container ID required")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", self.container_name):
            raise ValueError("fixed container name required")
        if not re.fullmatch(r"GPU-[a-fA-F0-9-]{36}", self.gpu_uuid):
            raise ValueError("physical GPU UUID required")


def _run(args):
    # Fixed executables and arguments: no shell, caller commands, or environment dumps.
    return subprocess.run(args, capture_output=True, text=True, check=True, timeout=45).stdout


def _healthy():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


class ReaderLifecycle:
    def __init__(self, policy: ReaderPolicy, *, run=_run, proc=Path("/proc"), healthy=_healthy, cgroup_root=Path("/sys/fs/cgroup")):
        self.policy, self.run, self.proc, self.healthy = policy, run, Path(proc), healthy
        self.cgroup_root = Path(cgroup_root)
        self._lock = RLock()

    def _inspect(self):
        records = json.loads(self.run(["/usr/bin/docker", "inspect", self.policy.container_id]))
        if len(records) != 1:
            raise LifecycleUnavailable("Reader identity unavailable")
        info = records[0]
        if info["Id"] != self.policy.container_id or info["Name"] != "/" + self.policy.container_name:
            raise LifecycleUnavailable("Reader container identity changed")
        # Docker must not restart a Reader behind the admission owner's back.
        if info["HostConfig"]["RestartPolicy"]["Name"] not in ("", "no"):
            raise LifecycleUnavailable("Reader restart policy is not supervisor-owned")
        # Docker clears runtime bindings on stop; configured bindings remain.
        ports = (info["NetworkSettings"]["Ports"] if info["State"]["Running"]
                 else info["HostConfig"]["PortBindings"])
        bindings = ports.get("8000/tcp")
        if bindings != [{"HostIp": "127.0.0.1", "HostPort": "8000"}]:
            raise LifecycleUnavailable("Reader health address is not pinned to its container")
        state = info["State"]
        if (type(state["Running"]) is not bool or type(state["Pid"]) is not int
                or type(state["OOMKilled"]) is not bool):
            raise LifecycleUnavailable("invalid Reader process state")
        if state.get("Restarting") or state.get("Paused") or state.get("Dead"):
            raise LifecycleUnavailable("Reader process state is not stable")
        return state

    def _belongs(self, pid):
        lines = (self.proc / str(pid) / "cgroup").read_text().splitlines()
        for line in lines:
            path = line.split(":", 2)[2]
            components = path.split("/")
            if self.policy.container_id in components or f"docker-{self.policy.container_id}.scope" in components:
                return True
        return False

    def _oom_events(self, state):
        """Counters belong to the current pinned cgroup lifetime, not the host.

        A stopped container has no required cgroup: None is unavailable, never zero.
        Running containers must expose complete cgroup-v2 OOM evidence.
        """
        if not state["Running"]:
            return None
        lines = (self.proc / str(state["Pid"]) / "cgroup").read_text().splitlines()
        unified = [line[3:] for line in lines if line.startswith("0::/")]
        if len(unified) != 1:
            raise LifecycleUnavailable("Reader unified cgroup unavailable")
        components = unified[0].strip("/").split("/")
        pins = {self.policy.container_id, f"docker-{self.policy.container_id}.scope"}
        matches = [i for i, component in enumerate(components) if component in pins]
        if len(matches) != 1 or any(c in (".", "..", "") for c in components):
            raise LifecycleUnavailable("Reader OOM cgroup is not pinned")
        root = self.cgroup_root.resolve()
        directory = root.joinpath(*components[:matches[0] + 1]).resolve()
        if not directory.is_relative_to(root):
            raise LifecycleUnavailable("Reader OOM cgroup escaped host root")
        events = {}
        for line in (directory / "memory.events").read_text().splitlines():
            key, value = line.split()
            if key in events or not value.isdecimal():
                raise LifecycleUnavailable("Reader OOM counters malformed")
            events[key] = int(value)
        if not {"oom", "oom_kill"} <= events.keys():
            raise LifecycleUnavailable("Reader OOM counters incomplete")
        return {key: events[key] for key in ("oom", "oom_kill")}

    def _snapshot(self):
        observed_at = time.monotonic()
        state = self._inspect()
        oom_before = self._oom_events(state)
        devices = self.run(["/usr/bin/nvidia-smi", "--query-gpu=uuid,memory.total,memory.used",
                            "--format=csv,noheader,nounits"])
        rows = [[field.strip() for field in line.split(",")] for line in devices.splitlines()]
        selected = [row for row in rows if row[0] == self.policy.gpu_uuid]
        if len(selected) != 1 or len(selected[0]) != 3:
            raise LifecycleUnavailable("pinned GPU unavailable")
        total, used = (int(value) * 1024 * 1024 for value in selected[0][1:])
        if not 0 <= used <= total or total <= 0:
            raise LifecycleUnavailable("pinned GPU memory observation malformed")
        owned = []
        for directory in self.proc.iterdir():
            if not directory.name.isdecimal():
                continue
            pid = int(directory.name)
            try:
                before = process_identity(pid, self.proc)
                if not self._belongs(pid):
                    continue
                after = process_identity(pid, self.proc)
                if before != after:
                    raise LifecycleUnavailable("Reader process identity changed during probe")
                owned.append(after)
            except FileNotFoundError:
                continue  # An exited process cannot still execute local work.
        gpu_owned = []
        gpu_all = set()
        raw = self.run(["/usr/bin/nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader,nounits"])
        for line in raw.splitlines():
            fields = [value.strip() for value in line.split(",")]
            if len(fields) != 2:
                raise LifecycleUnavailable("GPU process observation malformed")
            pid = int(fields[1])
            # A driver-reported PID without /proc identity is UNKNOWN, not stopped.
            identity = process_identity(pid, self.proc)
            if fields[0] == self.policy.gpu_uuid:
                gpu_all.add(identity)
            if self._belongs(pid):
                if fields[0] != self.policy.gpu_uuid or identity not in owned:
                    raise LifecycleUnavailable("Reader GPU/process identity changed")
                gpu_owned.append(identity)
        # Recheck every selected owner, including unrelated jobs: PID reuse or
        # disappearance is UNKNOWN, never evidence of an empty physical GPU.
        for identity in gpu_all:
            if process_identity(identity.pid, self.proc) != identity:
                raise LifecycleUnavailable("GPU owner identity changed during probe")
        after = self._inspect()
        if state != after:
            raise LifecycleUnavailable("Reader state changed during probe")
        oom_after = self._oom_events(after)
        if oom_before is not None and any(oom_after[k] < v for k, v in oom_before.items()):
            raise LifecycleUnavailable("Reader OOM counters reset during probe")
        running = state["Running"]
        if running and (state["Pid"] <= 0 or state["Pid"] not in {p.pid for p in owned}):
            raise LifecycleUnavailable("Reader init is not in its pinned cgroup")
        if not running and state["Pid"] != 0:
            raise LifecycleUnavailable("stopped Reader still has init PID")
        return {"policy_identity": self.policy.policy_identity,
                "container_id": self.policy.container_id, "gpu_uuid": self.policy.gpu_uuid,
                "gpu_observation": {"gpu_uuid": self.policy.gpu_uuid,
                    "total_bytes": total, "used_bytes": used, "observed_at": observed_at,
                    "processes": [asdict(p) for p in sorted(gpu_all, key=lambda p: p.pid)]},
                "oom_killed": state["OOMKilled"] or bool(oom_after and oom_after["oom_kill"]),
                "oom_count": oom_after["oom"] if oom_after is not None else None,
                "oom_kill_count": oom_after["oom_kill"] if oom_after is not None else None,
                "running": running, "ready": bool(running and gpu_owned and self.healthy()),
                "stopped": not running and not owned and not gpu_owned,
                "processes": [asdict(p) for p in sorted(owned, key=lambda p: p.pid)],
                "gpu_processes": [asdict(p) for p in sorted(gpu_owned, key=lambda p: p.pid)]}

    def action(self, operation):
        if operation not in {"probe", "start", "stop"}:
            raise ValueError("unsupported Reader action")
        with self._lock:
            try:
                snapshot = self._snapshot()
                before = snapshot
                if operation == "start" and not snapshot["running"]:
                    if not snapshot["stopped"]:
                        raise LifecycleUnavailable("Reader descendants have not stopped")
                    self.run(["/usr/bin/docker", "start", self.policy.container_id])
                    snapshot = self._snapshot()
                    if not snapshot["running"]:
                        raise LifecycleUnavailable("Reader start not confirmed")
                elif operation == "stop" and snapshot["running"]:
                    self.run(["/usr/bin/docker", "stop", "--time", "30", self.policy.container_id])
                    snapshot = self._snapshot()
                if operation == "stop" and not snapshot["stopped"]:
                    raise LifecycleUnavailable("Reader stop not confirmed")
                # An actuator transition must not erase evidence seen before it.
                snapshot["oom_killed"] |= before["oom_killed"]
                return snapshot
            except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.SubprocessError) as error:
                raise LifecycleUnavailable("Reader lifecycle observation unavailable") from error


def create_app(lifecycle: ReaderLifecycle):
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel, ConfigDict

    class ActionRequest(BaseModel):
        model_config = ConfigDict(extra="forbid")
        policy_identity: str

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.post("/{operation}")
    def action(operation: str, request: ActionRequest):
        if operation not in {"probe", "start", "stop"}:
            raise HTTPException(404, "unknown lifecycle operation")
        if request.policy_identity != lifecycle.policy.policy_identity:
            raise HTTPException(409, "foreign Reader policy")
        try:
            return lifecycle.action(operation)
        except LifecycleUnavailable as error:
            raise HTTPException(503, "Reader lifecycle UNKNOWN; retain reservations") from error

    return app


def unix_server(socket: Path, lifecycle: ReaderLifecycle):
    """Stdlib-only host transport; serialized actuator, bounded private requests."""
    from http.server import BaseHTTPRequestHandler
    from socketserver import UnixStreamServer

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_):
            pass

        def reply(self, code, value):
            data = json.dumps(value).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path not in ("/probe", "/start", "/stop"):
                return self.reply(404, {"error": "unknown operation"})
            if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                return self.reply(400, {"error": "bounded Content-Length required"})
            try:
                length = int(self.headers["Content-Length"])
                if not 0 < length <= 1024:
                    return self.reply(413, {"error": "body too large"})
                body = json.loads(self.rfile.read(length))
                if type(body) is not dict or set(body) != {"policy_identity"} or type(body["policy_identity"]) is not str:
                    return self.reply(422, {"error": "invalid request"})
            except (ValueError, OSError):
                return self.reply(400, {"error": "invalid body"})
            if body["policy_identity"] != lifecycle.policy.policy_identity:
                return self.reply(409, {"error": "foreign Reader policy"})
            try:
                return self.reply(200, lifecycle.action(self.path[1:]))
            except LifecycleUnavailable:
                return self.reply(503, {"error": "Reader lifecycle UNKNOWN; retain reservations"})

    return UnixStreamServer(str(socket), Handler)


def main():
    """Root launcher creates a private directory shared only with supervisor uid.

    python -m inspector_ml.reader_lifecycle --policy ROOT_OWNED.json --socket PRIVATE/reader.sock
    Provision Reader restart=no before launch; preserve its pinned container ID.
    """
    import argparse
    import fcntl
    import stat
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    args = parser.parse_args()
    info = args.policy.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit("policy must be root-owned and not writable by group/others")
    directory = args.socket.parent.stat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o027:
        raise SystemExit("socket directory must exclude unrelated users")
    owner = os.open(args.policy.with_suffix(".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if args.socket.exists():
        raise SystemExit("socket exists; launcher must establish previous helper stopped")
    policy = ReaderPolicy(**json.loads(args.policy.read_text()))
    os.setgid(directory.st_gid)
    os.umask(0o007)  # socket group is the supervisor's private service group
    with unix_server(args.socket, ReaderLifecycle(policy)) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
