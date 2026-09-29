"""Read explicitly headed fire-distance tables by columns, retaining source words.

Only the four-column distance layout is recognized. No inferred grid or subject
identity is introduced for unrecognized tables.
"""
from __future__ import annotations

from .model import Line, Page


def columns(page: Page) -> list[tuple[str, Page]] | None:
    for index, line in enumerate(page.lines):
        words = line.words
        labels = [w.text.lower().strip(".,:") for w in words]
        required = ("наименование", "объект", "требуемое", "минимальное")
        if not all(labels.count(label) == 1 for label in required):
            continue
        positions = [labels.index(label) for label in required]
        if positions != sorted(positions) or any(w.bbox is None for w in words):
            continue
        # Require the semantic header, not merely four isolated words.
        header = " ".join(x.text.lower() for x in page.lines[index:index + 5])
        prefix = " ".join(x.text.lower() for x in page.lines[:index])
        if "расстояние" not in header or "определяется" not in header or "противопожарные расстояния" not in prefix:
            continue
        edges = [(words[positions[i + 1] - 1].bbox[2] + words[positions[i + 1]].bbox[0]) / 2 for i in range(3)]
        first = words[positions[0]].bbox
        left = first[0] - (first[2] - first[0]) / 2
        bounds = [left, *edges, 1.0]
        if bounds != sorted(bounds):
            continue
        end = len(page.lines)
        for offset, source in enumerate(page.lines[index + 5:], index + 5):
            # A word crossing a column gutter signals a new full-width block
            # (often the footer). Do not carry table roles into following prose.
            if any(w.bbox and any(w.bbox[0] < edge - .002 and w.bbox[2] > edge + .002 for edge in edges) for w in source.words):
                end = offset
                break
        if any(w.bbox is None for source in page.lines[index:end] for w in source.words):
            continue
        result = [("before", page.model_copy(update={"lines": page.lines[:index]}))]
        for column, role in enumerate(("origin", "destination", "required_distance", "actual_distance")):
            lines = []
            for source in page.lines[index:end]:
                selected = [w for w in source.words if w.bbox is not None and bounds[column] <= (w.bbox[0] + w.bbox[2]) / 2 < bounds[column + 1]]
                if selected:
                    lines.append(Line(text=" ".join(w.text for w in selected), words=selected))
            result.append((role, page.model_copy(update={"lines": lines})))
        result.append(("before", page.model_copy(update={"lines": page.lines[end:]})))
        return result
    return None
