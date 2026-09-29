"""Private, resumable candidate staging from the whole catalog; never changes live results.

SQLite is a staging artifact for T-244, not the platform assignment/label database.
Uses existing lexical/passport extractors and the resident OCR Reader, no Judge/training.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from datetime import datetime, UTC
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import urllib.request

MODEL = 'PaddlePaddle/PaddleOCR-VL-1.5'
REVISION = '2a4195faa5e7914c12f2fc601d72c81caf8d2da5'


def utc():
    return datetime.now(UTC).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def wave_rest(busy_seconds, fraction=.65):
    """A whole drained wave gets idle time; peak utilization is not an average."""
    if busy_seconds < 0 or not 0 < fraction <= 1:
        raise ValueError('invalid duty bounds')
    return busy_seconds * (1 / fraction - 1)


def candidate(sha, ex, artifact, provenance):
    row = ex.model_dump() if hasattr(ex, 'model_dump') else dict(ex)
    identity = [sha, row['code'], row['page'], row.get('bbox'), row['raw'], artifact]
    return {'id': digest(identity), 'source_sha256': sha, 'operation': 'reading',
            'parameter': row['code'], 'page': row['page'], 'extraction': row,
            'artifact_sha256': artifact, 'provenance': provenance,
            'status': 'machine_candidate', 'human_label': None}


def install_schema(db):
    db.executescript('''PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(sha TEXT PRIMARY KEY,kind TEXT,state TEXT NOT NULL DEFAULT 'pending',pages INTEGER,error TEXT);
    CREATE TABLE IF NOT EXISTS refs(id TEXT PRIMARY KEY,sha TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,sha TEXT NOT NULL,parameter TEXT NOT NULL,page INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS candidates_parameter ON candidates(parameter);
    CREATE TABLE IF NOT EXISTS bands(sha TEXT,page INTEGER,band INTEGER,state TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(sha,page,band));
    ''')
    # A process killed mid-work leaves re-runnable, deterministic staging jobs.
    db.execute("UPDATE sources SET state='pending' WHERE state='running'")
    db.execute("UPDATE bands SET state='pending' WHERE state='running'")
    # Early text staging used a chunk identity as an artifact field. Preserve that identity,
    # explicitly mark it unverified instead of presenting it as a serialized OCR digest.
    db.execute("""UPDATE candidates SET payload=json_set(payload,
        '$.artifact_fingerprint',json_extract(payload,'$.artifact_sha256'),
        '$.artifact_sha256',NULL,
        '$.provenance.artifact_kind','legacy_staging_fingerprint_unverified')
        WHERE json_extract(payload,'$.provenance.artifact_kind')='parsed-or-text'""")
    db.commit()


def write_candidates(db, rows):
    db.executemany('INSERT OR IGNORE INTO candidates VALUES (?,?,?,?,?)',
        [(r['id'], r['source_sha256'], r['parameter'], r['page'], json.dumps(r, ensure_ascii=False)) for r in rows])


_SPECS = None


def specs():
    global _SPECS
    if _SPECS is None:
        from teacher.harvest import service_specs
        from inspector_ml.paths import repo_root
        matrix = json.loads((repo_root() / 'data/seed/matrix.json').read_text())
        _SPECS = service_specs({p['code']: p for p in matrix})
        if len(_SPECS) != 132:
            raise ValueError('expected the 132-parameter matrix')
    return _SPECS


def extract_pages(sha, kind, pages, artifact, provenance):
    from inspector_ml.extract import extract
    from inspector_ml.model import ParsedDoc
    doc = ParsedDoc(sha256=sha, kind=kind, pages=pages, engine=provenance['engine'])
    return [candidate(sha, e, artifact, provenance) for e in extract(doc, specs())]


def prepare_source(job):
    """One process per PDF: bounded chunks and no cross-thread PDFium calls."""
    from inspector_ml.model import Page, ParsedDoc
    from inspector_ml.parse import PDFIUM_LOCK, _text_lines, parse_file
    sha, kind, blob, cache, out, code = job
    spool = Path(out) / 'cpu' / (sha + '.jsonl')
    scans = []
    provenance = {'code_sha': code, 'extract_revision': 23, 'model_revision': None,
                  'historical_run_id': None, 'engine': 'pdf-text/current-rules'}
    with open(blob, 'rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != sha:
            raise ValueError('source_digest_mismatch')
    count = 0
    with spool.open('w') as output:
        def emit(pages, artifact, engine):
            nonlocal count
            p = provenance | {'engine': engine,
                'artifact_kind': 'parsed_cache' if cached else 'original_document',
                'artifact_path': cache if cached else blob,
                'parser_revision': None if not cached else Path(cache).name,
                'chunk_fingerprint': artifact}
            # SHA refers to real bytes: cached serialized document, or the verified original.
            for row in extract_pages(sha, kind, pages, artifact if cached else sha, p):
                output.write(json.dumps(row, ensure_ascii=False) + '\n')
                count += 1
        cached = None
        if cache:
            try:
                raw = Path(cache).read_bytes()
                cached = ParsedDoc.model_validate_json(raw)
                if cached.sha256 != sha:
                    cached = None
            except Exception:
                cached = None
        if cached:
            # All cached pages, not an arbitrary first-N file/page sample.
            for start in range(0, len(cached.pages), 20):
                emit(cached.pages[start:start + 20], hashlib.sha256(raw).hexdigest(), cached.engine)
            pages_n = len(cached.pages)
            scans = [p.page for p in cached.pages if kind == 'pdf' and
                     (p.quality != 'OK' or sum(len(l.text) for l in p.lines) < 40) and p.source != 'skipped']
        elif kind == 'pdf':
            import pypdfium2 as pdfium
            with PDFIUM_LOCK:
                pdf = pdfium.PdfDocument(blob)
                try:
                    pages_n = len(pdf)
                    chunk = []
                    for index in range(pages_n):
                        page = pdf[index]
                        try:
                            lines = _text_lines(page)
                            chunk.append(Page(page=index + 1, width=page.get_width(), height=page.get_height(),
                                source='text', lines=lines))
                            if sum(len(l.text) for l in lines) < 40:
                                scans.append(index + 1)
                        finally:
                            page.close()
                        if len(chunk) == 20:
                            emit(chunk, digest([sha, 'pdf-text', index]), 'pdf-text/current-rules')
                            chunk = []
                    if chunk:
                        emit(chunk, digest([sha, 'pdf-text', pages_n]), 'pdf-text/current-rules')
                finally:
                    pdf.close()
        elif kind in ('docx', 'xlsx', 'xml'):
            alias = Path(out) / 'cpu' / (sha + '.' + kind)
            if not alias.exists():
                alias.symlink_to(blob)
            doc = parse_file(alias, sha)
            pages_n = len(doc.pages)
            for start in range(0, pages_n, 20):
                emit(doc.pages[start:start + 20], digest([sha, 'structured', start]), doc.engine)
        elif kind == 'image':
            pages_n, scans = 1, [1]
        else:
            return {'sha': sha, 'state': 'unsupported', 'pages': 0, 'count': 0, 'scans': [], 'spool': str(spool)}
    return {'sha': sha, 'state': 'cpu_complete', 'pages': pages_n, 'count': count, 'scans': scans, 'spool': str(spool)}


def reader_band(job):
    from PIL import Image
    from inspector_ml.parse import PDFIUM_LOCK
    from inspector_ml.model import Page, Line, Word
    sha, kind, blob, page_n, band, out, code, endpoint = job
    lo, hi = max(0, band / 4 - .02), min(1, (band + 1) / 4 + .02)
    if kind == 'pdf':
        import pypdfium2 as pdfium
        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(blob)
            try:
                page = pdf[page_n - 1]
                try:
                    w, h = page.get_size()
                    scale = min(150 / 72, 2200 / max(w, h), math.sqrt(2_000_000 / (w * h)))
                    bitmap = page.render(scale=scale)
                    try:
                        image = bitmap.to_pil().copy()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            finally:
                pdf.close()
    else:
        with Image.open(blob) as source:
            image = source.convert('RGB')
            image.thumbnail((1800, 1800))
    crop = image.crop((0, int(image.height * lo), image.width, int(image.height * hi)))
    image.close()
    path = Path(out) / 'reader' / f'{sha}-p{page_n}-b{band}'
    crop.save(path.with_suffix('.png'))
    stream = io.BytesIO()
    crop.save(stream, format='PNG')
    body = {'model': MODEL, 'temperature': 0, 'max_tokens': 1600,
            'messages': [{'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()}},
                {'type': 'text', 'text': 'OCR:'}]}]}
    crop.close()
    request = urllib.request.Request(endpoint + '/chat/completions', data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
    start = time.monotonic()
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read()
    data = json.loads(raw)
    path.with_suffix('.json').write_bytes(raw)
    choice = data['choices'][0]
    if choice.get('finish_reason') != 'stop':
        return {'state': 'truncated', 'rows': [], 'latency': time.monotonic() - start}
    text = choice['message']['content'] or ''
    # Reader has no word coordinates: explicitly coarse band geometry, never invent word boxes.
    box = (0., lo, 1., hi)
    page = Page(page=page_n, width=1, height=1, source='ocr',
                lines=[Line(text=line, words=[Word(text=line, bbox=box)]) for line in text.splitlines() if line.strip()])
    provenance = {'engine': MODEL, 'model_revision': REVISION, 'code_sha': code,
                  'extract_revision': 23, 'geometry': 'coarse_band_not_word_boxes',
                  'crop_path': str(path.with_suffix('.png')), 'historical_run_id': None}
    rows = extract_pages(sha, 'image' if kind == 'image' else 'pdf', [page], hashlib.sha256(raw).hexdigest(), provenance)
    return {'state': 'complete', 'rows': rows, 'latency': time.monotonic() - start}


def bootstrap(db, catalog, blobs):
    counts = {'catalog_entries': 0, 'nonworking_entries': 0}
    for path in sorted(Path(catalog).glob('*.jsonl')):
        for line in path.open():
            row = json.loads(line)
            sha = row.get('sha256', '')
            if not re.fullmatch('[a-f0-9]{64}', sha):
                continue
            counts['catalog_entries'] += 1
            # Original working objects; methodology and already annotated copies are separately counted.
            if not re.match(r'^(01_|1[0-8]_)', row.get('archive', path.name)):
                counts['nonworking_entries'] += 1
                continue
            ext = Path(row.get('path', '')).suffix.lower()
            kind = {'.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.xml': 'xml',
                    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.tif': 'image', '.tiff': 'image'}.get(ext, 'unsupported')
            state = 'pending' if (Path(blobs) / sha).is_file() else 'missing_original'
            db.execute('INSERT OR IGNORE INTO sources(sha,kind,state) VALUES(?,?,?)', (sha, kind, state))
            db.execute('INSERT OR IGNORE INTO refs VALUES(?,?,?)', (digest(row), sha, json.dumps(row, ensure_ascii=False)))
    db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('catalog_counts', json.dumps(counts)))
    db.commit()


def historical_refs(db, out):
    """Preserve exact historical identities separately; never join objects by SHA alone."""
    target = Path(out) / 'historical-files.json'
    if not target.exists():
        sql = """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='30s';
SELECT json_build_object('snapshot_utc',transaction_timestamp(),'files',coalesce(json_agg(to_jsonb(f)),'[]'::json)) FROM inspector.files f;
COMMIT;"""
        proc = subprocess.run(['docker','exec','-i','-u','postgres','nadzorium-gpu-postgres-1',
            'psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d','inspector'],
            input=sql.encode(), capture_output=True, timeout=45)
        if proc.returncode:
            raise RuntimeError('historical_read_only_snapshot_failed')
        data = json.loads(proc.stdout)
        target.write_text(json.dumps(data, ensure_ascii=False))
    else:
        data = json.loads(target.read_text())
    for row in data['files']:
        if db.execute('SELECT 1 FROM sources WHERE sha=?', (row['sha256'],)).fetchone():
            ref = {'source_kind': 'historical_file_identity', 'snapshot_utc': data['snapshot_utc'],
                   'file': row, 'catalog_object_authority': 'not_inferred_from_sha'}
            db.execute('INSERT OR IGNORE INTO refs VALUES(?,?,?)', (digest(ref), row['sha256'], json.dumps(ref, ensure_ascii=False)))
    db.commit()


def summary(db, out, extra):
    counts = {'sources': dict(db.execute('SELECT state,count(*) FROM sources GROUP BY state')),
              'bands': dict(db.execute('SELECT state,count(*) FROM bands GROUP BY state')),
              'candidates': db.execute('SELECT count(*) FROM candidates').fetchone()[0],
              'source_refs': db.execute('SELECT count(*) FROM refs').fetchone()[0],
              'coverage': {sp.code: 0 for sp in specs()}}
    counts['coverage'].update(dict(db.execute('SELECT parameter,count(*) FROM candidates GROUP BY parameter')))
    doc = {'schema': 'verification-candidate-staging.v1', 'updated_at': utc(), **extra, **counts}
    target = Path(out) / 'status.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    temp.replace(target)
    print(json.dumps({k: v for k, v in doc.items() if k != 'coverage'}), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--catalog', default='/opt/corpus/catalog')
    ap.add_argument('--blobs', default='/opt/corpus/blobs')
    ap.add_argument('--cache', default='/opt/inspector/cache')
    ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--gpu-max', type=int, default=16)
    ap.add_argument('--gpu-duty', type=float, default=.65)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--gpu', action='store_true')
    ap.add_argument('--historical-refs', action='store_true')
    ap.add_argument('--endpoint', default='http://127.0.0.1:8000/v1')
    a = ap.parse_args()
    if not 1 <= a.workers <= 24 or not 1 <= a.gpu_max <= 32 or a.limit < 0 or not 0 < a.gpu_duty <= 1:
        raise ValueError('invalid worker or scope bounds')
    if a.endpoint != 'http://127.0.0.1:8000/v1':
        raise ValueError('only the inspected resident loopback Reader is allowed')
    os.umask(0o077)
    out = Path(a.out)
    out.mkdir(parents=True, mode=0o700, exist_ok=True)
    own = (out / 'run.lock').open('a')
    fcntl.flock(own, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for folder in ('cpu', 'reader'):
        (out / folder).mkdir(mode=0o700, exist_ok=True)
    code = os.environ.get('VERIFICATION_CODE_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}', code):
        raise ValueError('code must be pinned to a full commit SHA')
    db = sqlite3.connect(out / 'candidates.sqlite')
    install_schema(db)
    bootstrap(db, a.catalog, a.blobs)
    if a.historical_refs:
        historical_refs(db, out)
    pending = list(db.execute("SELECT sha,kind FROM sources WHERE state='pending' ORDER BY sha"))
    if a.limit:
        pending = pending[:a.limit]
    caches = {}
    for path in Path(a.cache).glob('parsed-*.json'):
        match = re.match(r'parsed-([a-f0-9]{64})-r(\d+)(?:-o[a-f0-9]+)?\.json$', path.name)
        if match:
            sha, rev = match.groups()
            if sha not in caches or int(rev) > caches[sha][0]:
                caches[sha] = (int(rev), str(path))
    gpu_lock = None
    gpu_state = 'disabled'
    if a.gpu:
        gpu_lock = Path('/opt/resource-ocr/gpu.lock').open('a')
        try:
            fcntl.flock(gpu_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with urllib.request.urlopen(a.endpoint + '/models', timeout=10) as response:
                models = json.load(response)
            if MODEL not in [m['id'] for m in models['data']]:
                raise ValueError('resident Reader model mismatch')
            gpu_state = 'resident_reader'
        except Exception:
            gpu_lock.close()
            gpu_lock = None
            gpu_state = 'blocked_lock_or_endpoint'
    n_cpu, n_gpu, last, sampled = 0, 0, 0., None
    gpu_errors = 0
    wave_started, next_wave = None, 0.
    extras = {'code_sha': code, 'gpu': gpu_state, 'phase': 'running', 'worker_limit': a.workers,
              'started_at': utc(), 'platform_queue': 'not_implemented_staging_only',
              'gpu_duty_target': a.gpu_duty}
    jobs, gjobs = {}, {}
    iterator = iter(pending)
    exhausted = False
    with ProcessPoolExecutor(a.workers) as cpus, ThreadPoolExecutor(a.gpu_max) as gpu:
        while True:
            while len(jobs) < a.workers and not exhausted:
                try:
                    sha, kind = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                db.execute("UPDATE sources SET state='running' WHERE sha=?", (sha,))
                args = (sha, kind, str(Path(a.blobs) / sha), caches.get(sha, (None, None))[1], str(out), code)
                jobs[cpus.submit(prepare_source, args)] = sha
            for future in list(jobs):
                if not future.done():
                    continue
                sha = jobs.pop(future)
                try:
                    result = future.result()
                    with Path(result['spool']).open() as spool:
                        chunk = []
                        for line in spool:
                            chunk.append(json.loads(line))
                            if len(chunk) == 1000:
                                write_candidates(db, chunk)
                                chunk = []
                        write_candidates(db, chunk)
                    db.execute('UPDATE sources SET state=?,pages=?,error=NULL WHERE sha=?', (result['state'], result['pages'], sha))
                    db.executemany('INSERT OR IGNORE INTO bands(sha,page,band) VALUES(?,?,?)',
                        [(sha, p, b) for p in result['scans'] for b in range(4)])
                except Exception as exc:
                    db.execute("UPDATE sources SET state='error',error=? WHERE sha=?", (type(exc).__name__ + ':' + str(exc)[:500], sha))
                n_cpu += 1
            for future in list(gjobs):
                if not future.done():
                    continue
                sha, page, band = gjobs.pop(future)
                try:
                    result = future.result()
                    write_candidates(db, result['rows'])
                    db.execute('UPDATE bands SET state=?,error=NULL WHERE sha=? AND page=? AND band=?', (result['state'], sha, page, band))
                except Exception as exc:
                    db.execute("UPDATE bands SET state='error',error=? WHERE sha=? AND page=? AND band=?", (type(exc).__name__ + ':' + str(exc)[:500], sha, page, band))
                    gpu_errors += 1
                n_gpu += 1
            if wave_started is not None and not gjobs:
                next_wave = time.monotonic() + wave_rest(time.monotonic() - wave_started, a.gpu_duty)
                wave_started = None
            if gpu_lock and gpu_errors >= 10:
                # Keep already in-flight requests, halt new calls; preserve pending jobs for review.
                gpu_lock.close()
                gpu_lock = None
                gpu_state = 'blocked_reader_errors'
                extras['gpu'] = gpu_state
            if gpu_lock and not gjobs and time.monotonic() >= next_wave:
                rows = db.execute("SELECT b.sha,s.kind,b.page,b.band FROM bands b JOIN sources s ON s.sha=b.sha WHERE b.state='pending' ORDER BY b.page,b.sha,b.band LIMIT ?", (a.gpu_max,)).fetchall()
                if rows:
                    wave_started = time.monotonic()
                for sha, kind, page, band in rows:
                    db.execute("UPDATE bands SET state='running' WHERE sha=? AND page=? AND band=?", (sha, page, band))
                    args = (sha, kind, str(Path(a.blobs) / sha), page, band, str(out), code, a.endpoint)
                    gjobs[gpu.submit(reader_band, args)] = (sha, page, band)
            db.commit()
            if time.monotonic() - last > 15:
                try:
                    metrics = subprocess.check_output(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], timeout=5, text=True).strip().split(',')
                    sampled = {'utilization': int(metrics[0]), 'vram_mib': int(metrics[1])}
                except Exception:
                    pass
                summary(db, out, extras | {'cpu_completed': n_cpu, 'gpu_completed': n_gpu,
                    'cpu_inflight': len(jobs), 'gpu_inflight': len(gjobs), 'gpu_concurrency': a.gpu_max,
                    'gpu_rest_seconds_remaining': max(0, next_wave - time.monotonic()),
                    'gpu_sample': sampled})
                last = time.monotonic()
            if exhausted and not jobs and not gjobs and (not gpu_lock or not db.execute("SELECT 1 FROM bands WHERE state='pending' LIMIT 1").fetchone()):
                break
            time.sleep(.2)
    summary(db, out, extras | {'phase': 'cpu_completed_gpu_blocked' if gpu_state.startswith('blocked') else 'completed',
        'cpu_completed': n_cpu, 'gpu_completed': n_gpu, 'gpu_sample': sampled})


if __name__ == '__main__':
    main()
