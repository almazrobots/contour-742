"""Read a policy copy; exercise isolated admission journals, never the live ledger."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from inspector_ml.node_admission import NodeAdmission
from inspector_ml.resource_admission import JobRef, Resources, Telemetry

parser = argparse.ArgumentParser()
parser.add_argument("policy", type=Path)
args = parser.parse_args()
p = json.loads(args.policy.read_text())
results = {}
with TemporaryDirectory(prefix="resource-policy-smoke-") as directory:
    for scenario in ("stale", "ram", "vram", "spool", "pixels", "cpu", "tokens"):
        owner = NodeAdmission(Path(directory) / scenario, journal_identity=str(uuid4()),
            node_id="isolated-smoke", policy_id="isolated-smoke",
            capacity=Resources(**p["capacity"]), resident=Resources(**p["resident"]),
            telemetry_ttl=p["telemetry_ttl"], heartbeat_ttl=p["heartbeat_ttl"], initialize=True)
        try:
            demand = dict(p["job_budget"])
            if scenario != "stale":
                demand[scenario] = p["capacity"][scenario] + 1
            enqueued = owner.enqueue(JobRef("synthetic-job", "isolated-smoke", Resources(**demand)))
            now = 1000.0
            observed = now - p["telemetry_ttl"] - 1 if scenario == "stale" else now
            decision = owner.reserve_next(Telemetry(observed, Resources()), now=now) if scenario == "stale" else enqueued
            assert decision.action == ("wait" if scenario == "stale" else "reject"), decision
            assert decision.reason == ("stale_telemetry" if scenario == "stale" else f"capacity:{scenario}"), decision
            assert not owner.snapshot(), "refused demand created a reservation"
            assert len(owner.queued()) == (1 if scenario == "stale" else 0), "incorrect queue state"
            results[scenario] = {"action": decision.action, "reason": decision.reason, "reservations": 0}
            if scenario == "stale":
                admitted = owner.reserve_next(Telemetry(now, Resources()), now=now)
                assert admitted.action == "admit", admitted
                assert len(owner.snapshot()) == 1
                results[scenario]["fresh_observation"] = "admit_once"
        finally:
            owner.close()
print(json.dumps({"scope": "isolated policy copy; no worker launched", "results": results}))
