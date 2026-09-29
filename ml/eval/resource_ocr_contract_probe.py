"""T-236: three previously reproduced defects must now be refused.

Synthetic CPU probe on the remote host. Historical defective observations are
preserved in commit 65f099e1 and the baseline report.
"""

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from inspector_ml.docstore import assemble_parts, parse_part, part_key, parsed_key
from inspector_ml.parse import parse_pdf
from eval.resource_ocr_baseline import MemoryCache
from tests.test_parse_parts import sha, text_pdf


def refused(action):
    try:
        action()
    except ValueError as exc:
        return {"rejected": True, "reason": str(exc)}
    raise AssertionError("invalid checkpoint/range was accepted")


def main():
    with TemporaryDirectory(prefix="t236-contract-") as directory:
        path = text_pdf(Path(directory) / "five.pdf", 5)
        digest = sha(path)
        cache = MemoryCache()
        parse_part(cache, path, digest, 0, 2)
        observations = {"incomplete_tail": refused(
            lambda: assemble_parts(cache, path, digest, [(0, 2)]))}
        assert cache.get(parsed_key(digest)) is None

        part, _ = parse_part(cache, path, digest, 0, 2)
        parse_part(cache, path, digest, 2, 5)
        poisoned = part.model_copy(update={"sha256": "f" * 64,
                                          "pages": [part.pages[0]]})
        cache.set(part_key(digest, 0, 2), poisoned.model_dump_json())
        observations["poisoned_checkpoint"] = refused(
            lambda: assemble_parts(cache, path, digest, [(0, 2), (2, 5)]))
        assert cache.get(parsed_key(digest)) is None

        whole = parse_pdf(path, digest)
        cache.set(parsed_key(digest), whole.model_dump_json())
        observations["invalid_cached_range"] = refused(
            lambda: parse_part(cache, path, digest, 5, 9))
        print(json.dumps(observations, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
