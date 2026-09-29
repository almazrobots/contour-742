"""Компонент балла «целостность документов и обработка частей» (OS-INSP-6.5.12, T-120).

Вход — реестр организатора `document_manifest.jsonl` (file_id, sha256, pdf_pages, exclusion_reason,
duplicate_group, distribution_status), `excluded_file_ids` из `split_policy.json` и отчёт о целостности пакета от
API (`GET /api/v1/inspection/:id/integrity`, OS-INSP-1.2.35): статус каждого файла.

Формулу компонента организатор не раскрыл — **допущение**: компонент равен доле файлов манифеста, учтённых верно.
Файл учтён верно, если:

- реестр его исключил (`exclusion_reason` или `excluded_file_ids`) — статус EXCLUDED (OS-INSP-1.2.32);
- он второй и далее в своей `duplicate_group` или повторяет SHA-256 уже встреченного файла — DUPLICATE (1.2.33);
- иначе — ACCEPTED или PART с тем же SHA-256 (1.2.31) и числом страниц, равным `pdf_pages`, если оно задано (1.2.34).

Файла нет в отчёте — учтён неверно. `distribution_status` не влияет: его смысл организатор не описал.
Пустой манифест — компонент не измерен (`share` None), в балл 6.5.6 он тогда не входит, а не додумывается.
"""

from __future__ import annotations

TAKEN = {"ACCEPTED", "PART"}


def _why(m: dict, got: dict | None, excluded: bool, dup_of: str | None) -> str | None:
    """Причина, по которой файл учтён неверно; None — учтён верно."""
    if got is None:
        return "нет в отчёте о целостности"
    st = got.get("status")
    if excluded:
        return (
            None
            if st == "EXCLUDED"
            else f"ожидался EXCLUDED (исключён реестром), в отчёте {st}"
        )
    if dup_of:
        return (
            None
            if st == "DUPLICATE"
            else f"ожидался DUPLICATE (дубль {dup_of}), в отчёте {st}"
        )
    if st not in TAKEN:
        return f"ожидался ACCEPTED или PART, в отчёте {st}"
    if m.get("sha256") and got.get("sha256") != m["sha256"]:
        return "SHA-256 в отчёте не совпадает с реестром"
    if m.get("pdf_pages") is not None and got.get("pages") != m["pdf_pages"]:
        return f"страниц {got.get('pages')}, в реестре {m['pdf_pages']}"
    return None


def integrity_share(
    manifest: list[dict], report: dict, excluded_ids: set[str] = frozenset()
) -> dict:
    """Доля файлов манифеста, учтённых в отчёте о целостности верно, и перечень неверных с причиной."""
    if not manifest:
        return {"share": None, "n": 0, "wrong": []}
    by_id = {f.get("file_id"): f for f in report.get("files") or []}
    first_of_group: dict[str, str] = {}
    first_of_sha: dict[str, str] = {}
    wrong = []
    for m in manifest:
        fid = m["file_id"]
        excluded = bool(m.get("exclusion_reason")) or fid in excluded_ids
        dup_of = None
        if not excluded:
            g, sha = m.get("duplicate_group"), m.get("sha256")
            dup_of = (first_of_group.get(g) if g else None) or (
                first_of_sha.get(sha) if sha else None
            )
            if g:
                first_of_group.setdefault(g, fid)
            if sha:
                first_of_sha.setdefault(sha, fid)
        why = _why(m, by_id.get(fid), excluded, dup_of)
        if why:
            wrong.append({"file_id": fid, "why": why})
    n = len(manifest)
    return {"share": (n - len(wrong)) / n, "n": n, "wrong": wrong}
