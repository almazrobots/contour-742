"""Private, resumable transfer of historical originals; never changes source files."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--image', required=True)
    p.add_argument('--manifest-sha256', required=True)
    p.add_argument('--bulk', action='store_true')
    a = p.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r'/opt/resource-ocr/cpu-view-transfer-[a-z0-9-]+', str(a.root)):
        raise ValueError('private transfer root required')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', a.image):
        raise ValueError('immutable API image required')
    os.umask(0o077)
    raw = (a.root / 'manifest.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != a.manifest_sha256:
        raise ValueError('manifest digest mismatch')
    m = json.loads(raw)
    if m['schema'] != 'platform-blob-mirror/1' or m.get('missing') or any(not re.fullmatch(r'[a-f0-9]{64}', s) for s in m['shas']):
        raise ValueError('complete valid inventory required')
    lock = (a.root / 'mirror.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    source = Path('/opt/stand-gpu/blobs')
    for sha in set(m['shas']):
        if (source / sha).is_symlink() or not (source / sha).is_file():
            raise ValueError('missing or symlink source')
    prefix = 'platform-view/20260929-gpu/'
    identity = {'image': a.image, 'manifest_sha256': a.manifest_sha256, 'prefix': prefix}
    proof = a.root / 'roundtrip.json'
    base = ['docker', 'run', '--rm', '--user', '0:0', '--cpus', '1', '--memory', '512m',
            '--memory-swap', '512m', '--pids-limit', '128', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:size=32m',
            '-v', str(source) + ':/source:ro', '-v', str(a.root) + ':/transfer',
            '-v', str(a.root / 'secrets') + ':/transfer/secrets:ro',
            '-e', 'INSPECTOR_PROFILE=dev', '-e', 'INSPECTOR_QUEUE=inproc',
            '-e', 'INSPECTOR_BLOB_DIR=/source', '-e', 'INSPECTOR_BLOB_STORE=s3',
            '-e', 'INSPECTOR_S3_ENDPOINT=https://storage.yandexcloud.net',
            '-e', 'INSPECTOR_S3_REGION=ru-central1', '-e', 'INSPECTOR_S3_BUCKET=nadzorium',
            '-e', 'INSPECTOR_S3_PREFIX=' + prefix,
            '-e', 'INSPECTOR_S3_ACCESS_KEY_ID_FILE=/transfer/secrets/s3_access_key_id',
            '-e', 'INSPECTOR_S3_SECRET_ACCESS_KEY_FILE=/transfer/secrets/s3_secret_access_key',
            '-e', 'INSPECTOR_S3_KEY_FILE=/transfer/secrets/s3_encryption_key',
            '--entrypoint', 'node', a.image]
    def run(command, log):
        with (a.root / log).open('a') as out:
            subprocess.run(base + command, stdout=out, stderr=out, check=True)
    def mirror(name, digest, output):
        run(['apps/api/dist/cli/blobs-mirror.mjs', '--manifest', '/transfer/' + name,
             '--manifest-sha256', digest, '--output', '/transfer/' + output], output + '.log')
    if not a.bulk:
        sha = min(set(m['shas']), key=lambda s: (source / s).stat().st_size)
        if (source / sha).stat().st_size > 4 * 1024 * 1024:
            raise ValueError('small roundtrip source required')
        pilot = json.dumps({'schema': m['schema'], 'shas': [sha]}).encode()
        (a.root / 'pilot.json').write_bytes(pilot)
        mirror('pilot.json', hashlib.sha256(pilot).hexdigest(), 'pilot-progress')
        # Independent readback through the same CPU credentials/key. No plaintext
        # is saved; GCM authentication and source content SHA must both match.
        js = r'''
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,createDecipheriv} from 'node:crypto';
const require=createRequire('/app/apps/api/package.json');
const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');
const secret=n=>readFileSync('/transfer/secrets/'+n,'utf8').trim();
const sha=JSON.parse(readFileSync('/transfer/pilot.json')).shas[0];
const client=new S3Client({endpoint:process.env.INSPECTOR_S3_ENDPOINT,region:'ru-central1',credentials:{accessKeyId:secret('s3_access_key_id'),secretAccessKey:secret('s3_secret_access_key')}});
const r=await client.send(new GetObjectCommand({Bucket:'nadzorium',Key:process.env.INSPECTOR_S3_PREFIX+sha}));
const b=Buffer.from(await r.Body.transformToByteArray());
const text=secret('s3_encryption_key');const key=Buffer.from(text,/^[a-fA-F0-9]{64}$/.test(text)?'hex':'base64');
const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));
const plain=Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);
const hash=b=>createHash('sha256').update(b).digest('hex');
if(hash(plain)!==sha||hash(readFileSync('/source/'+sha))!==sha||r.Metadata?.sha256!==sha)throw Error('roundtrip mismatch');
writeFileSync('/transfer/roundtrip-read.json',JSON.stringify({authenticated:true,source_sha256:sha,plaintext_bytes:plain.length,encrypted_bytes:b.length}),{mode:0o600});
'''
        (a.root / 'verify.mjs').write_text(js)
        run(['/transfer/verify.mjs'], 'roundtrip.log')
        proof.write_text(json.dumps({'identity': identity, 'roundtrip': json.loads((a.root / 'roundtrip-read.json').read_text())}))
        print(json.dumps({'roundtrip_verified': True, 'source_changed': False}))
    else:
        saved = json.loads(proof.read_text())
        if saved['identity'] != identity or not saved['roundtrip']['authenticated']:
            raise ValueError('matching successful roundtrip required before bulk')
        mirror('manifest.json', a.manifest_sha256, 'bulk-progress')
        print(json.dumps({'mirror_complete': True, 'unique_sources': len(set(m['shas'])), 'source_changed': False}))


if __name__ == '__main__':
    main()
