"""Гейт выбора моделей (T-129): модель в коде = выбранная в реестре ml/models.yaml, выбор обоснован замером,
рекомендованные проектом кандидаты не пропущены, проверка версий свежая. Замечание владельца 27.09: судья стоял
на Qwen3-VL-8B, хотя ML-CONCEPT рекомендовал Qwen3.5-9B, и 9B оказалась точнее и легче — такого больше не должно быть."""

from datetime import date
from pathlib import Path

import pytest
import yaml

from inspector_ml import vlm

REG = yaml.safe_load((Path(__file__).parents[1] / "models.yaml").read_text("utf-8"))
ROLES = REG["roles"]
from inspector_ml import ocr_gpu

CODE_DEFAULT = {"judge": vlm.JUDGE, "reader": vlm.READER, "reader2": vlm.READER2, "ocr_anchor": ocr_gpu.PPOCR_MODEL}


@pytest.mark.l7_discipline
def test_portable_bootstrap_pins_registry_gpu_models():
    import ast
    tree = ast.parse((Path(__file__).parents[2] / "scripts/platform-start.py").read_text())
    assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "MODELS" for target in node.targets))
    assert ast.literal_eval(assignment.value) == [
        (ROLES[role]["gpu_equivalent"], ROLES[role]["revision"]) for role in ("reader", "judge")]


@pytest.mark.l7_discipline
@pytest.mark.parametrize("role", sorted(ROLES))
def test_code_default_equals_registry_choice(role, monkeypatch):
    assert CODE_DEFAULT[role] == ROLES[role]["chosen"], f"{role}: в коде {CODE_DEFAULT[role]}, в реестре {ROLES[role]['chosen']}"


@pytest.mark.l7_discipline
@pytest.mark.parametrize("role", sorted(ROLES))
def test_chosen_is_a_candidate_and_best_measured(role):
    r = ROLES[role]
    by = {c["model"]: c for c in r["candidates"]}
    assert r["chosen"] in by, f"{role}: выбранной модели нет среди кандидатов"
    measured = [c for c in r["candidates"] if c.get("measure")]
    if measured:
        best = max(measured, key=lambda c: (c["measure"]["correct"] / c["measure"]["total"], -c["measure"]["peak_rss_gb"]))
        assert by[r["chosen"]].get("measure"), f"{role}: у выбранной модели нет замера, а у других есть"
        assert best["model"] == r["chosen"], f"{role}: по замеру лучше {best['model']}"


@pytest.mark.l7_discipline
@pytest.mark.parametrize("role", sorted(ROLES))
def test_every_candidate_measured_or_rejected_and_license_open(role):
    for c in ROLES[role]["candidates"]:
        if c["model"] == ROLES[role]["chosen"]:
            continue
        assert c.get("measure") or c.get("rejected"), f"{role}: кандидат {c['model']} не померен и не отклонён"
    for c in ROLES[role]["candidates"]:
        if "license" in c:
            assert c["license"] in {"apache-2.0", "mit", "bsd-3-clause"}, f"{c['model']}: лицензия {c['license']} — не открытая"


@pytest.mark.l7_discipline
@pytest.mark.parametrize("role", sorted(ROLES))
def test_version_check_is_fresh(role):
    age = (date.today() - ROLES[role]["checked"]).days
    assert age <= 14, f"{role}: проверка версий на Hugging Face {age} дн. назад — перепроверить (модели выходят ежемесячно)"


@pytest.mark.l7_discipline
@pytest.mark.parametrize("role", sorted(ROLES))
def test_models_are_local_open_weights_not_cloud(role):
    for c in ROLES[role]["candidates"]:
        assert "/" in c["model"] and not c["model"].startswith(("gpt", "claude", "gemini", "http")), c["model"]


# Роли, которые стенд gpu держит в vLLM (deploy/gpu-stand/vllm.sh): ревизия HF закреплена, скрипт запускает ровно её (OWASP-0212)
VLLM_ROLES = ("reader", "judge")


@pytest.mark.l7_discipline
@pytest.mark.parametrize("role", VLLM_ROLES)
def test_gpu_roles_pin_hf_revision_used_by_vllm_script(role):
    import re

    r = ROLES[role]
    rev = str(r.get("revision", ""))
    assert re.fullmatch(r"[0-9a-f]{40}", rev), f"{role}: revision — полный sha коммита Hugging Face (40 hex)"
    sh = (Path(__file__).parents[2] / "deploy/gpu-stand/vllm.sh").read_text("utf-8")
    assert re.search(rf'"{re.escape(r["gpu_equivalent"])}"\s+"{rev}"', sh), f"{role}: vllm.sh не запускает {r['gpu_equivalent']}@{rev}"
