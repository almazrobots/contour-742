"""Prepare S3 secrets and a Compose overlay without exposing credentials.

The API's existing TieredBlobStore remains responsible for encryption, integrity,
and cache misses. Persisted configuration prevents repeat startup reverting to fs.
"""
import json
import os
from pathlib import Path
import re
import shlex
from urllib.parse import urlsplit


FIELDS = ('YC_S3_ENDPOINT', 'YC_S3_REGION', 'YC_S3_BUCKET',
          'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')


def read_credentials(path):
    path = Path(path)
    if path.stat().st_mode & 0o077:
        raise ValueError('S3 credentials file must be private (0600 or stricter)')
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:]
        name, sep, value = line.partition('=')
        name = name.strip()
        if not sep or name not in FIELDS or name in values:
            raise ValueError('Unsupported or duplicate S3 configuration field')
        try:
            tokens = shlex.split(value, comments=True)
        except ValueError:
            raise ValueError('Invalid S3 configuration quoting') from None
        if len(tokens) != 1 or not tokens[0] or '\n' in tokens[0]:
            raise ValueError('S3 configuration fields must contain one nonempty value')
        values[name] = tokens[0]
    if set(values) != set(FIELDS):
        raise ValueError('S3 configuration requires endpoint, region, bucket and two credentials')
    url = urlsplit(values['YC_S3_ENDPOINT'])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('S3 endpoint must use HTTPS without embedded credentials')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,64}', values['YC_S3_REGION']):
        raise ValueError('Invalid S3 region')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', values['YC_S3_BUCKET']):
        raise ValueError('Invalid S3 bucket')
    return values


def prefix_value(value):
    if not value or len(value) > 256 or not re.fullmatch(r'[A-Za-z0-9_./-]+', value):
        raise ValueError('Invalid S3 object prefix')
    if any(p in ('.', '..') for p in value.split('/')):
        raise ValueError('Invalid S3 object prefix')
    return value.rstrip('/') + '/'


def prepare_s3(state, credentials_file=None, encryption_key_file=None, prefix=None, read_prefixes=None):
    state = Path(state)
    config_file = state / 'storage.json'
    overlay_file = state / 'platform-s3.json'
    previous = json.loads(config_file.read_text()) if config_file.exists() else None
    if credentials_file is None:
        if encryption_key_file is not None or prefix is not None or read_prefixes is not None:
            raise ValueError('S3 options require --s3-env')
        if previous:
            for name in ('access_key_id', 'secret_access_key', 'encryption_key'):
                p = state / 'secrets/s3' / name
                if not p.is_file() or not p.read_text().strip():
                    raise ValueError('Persisted S3 secret missing; refusing fs fallback')
            if not overlay_file.is_file():
                raise ValueError('Persisted S3 overlay missing; refusing fs fallback')
            return overlay_file
        if overlay_file.exists():
            raise ValueError('Unidentified S3 overlay; explicit configuration required')
        return None
    if encryption_key_file is None:
        raise ValueError('S3 requires the original --s3-key-file, not a newly generated cache key')
    values = read_credentials(credentials_file)
    key = Path(encryption_key_file).read_text().strip()
    if not re.fullmatch(r'[0-9a-fA-F]{64}', key):
        raise ValueError('S3 encryption key must contain exactly 64 hexadecimal characters')
    config = {'schema': 'platform-storage/1', 'mode': 's3',
              'endpoint': values['YC_S3_ENDPOINT'], 'region': values['YC_S3_REGION'],
              'bucket': values['YC_S3_BUCKET'], 'prefix': prefix_value(prefix or 'blobs/'),
              'read_prefixes': [prefix_value(p) for p in (read_prefixes or '').split(',') if p]}
    if previous and previous != config:
        raise ValueError('Existing S3 identity differs; explicit storage migration required')
    secret_dir = state / 'secrets/s3'
    secret_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    secrets = {'access_key_id': values['AWS_ACCESS_KEY_ID'],
               'secret_access_key': values['AWS_SECRET_ACCESS_KEY'], 'encryption_key': key.lower()}
    for name, value in secrets.items():
        path = secret_dir / name
        if path.exists() and path.read_text().strip() != value:
            raise ValueError('Existing S3 secret differs; explicit credential/key rotation required')
    for name, value in secrets.items():
        path = secret_dir / name
        if not path.exists():
            with path.open('x') as stream:
                stream.write(value + '\n')
        path.chmod(0o600)
        if os.geteuid() == 0:
            os.chown(path, 1000, 1000)
    env = {'INSPECTOR_BLOB_STORE': 's3', 'INSPECTOR_S3_ENDPOINT': config['endpoint'],
           'INSPECTOR_S3_REGION': config['region'], 'INSPECTOR_S3_BUCKET': config['bucket'],
           'INSPECTOR_S3_PREFIX': config['prefix'],
           'INSPECTOR_S3_READ_PREFIXES': ','.join(config['read_prefixes']),
           'INSPECTOR_S3_ACCESS_KEY_ID_FILE': '/run/secrets/platform_s3_access_key_id',
           'INSPECTOR_S3_SECRET_ACCESS_KEY_FILE': '/run/secrets/platform_s3_secret_access_key',
           'INSPECTOR_S3_KEY_FILE': '/run/secrets/platform_s3_encryption_key'}
    overlay = {'services': {'api': {'environment': env,
               'secrets': ['platform_s3_' + n for n in secrets]}},
               'secrets': {'platform_s3_' + n: {'file': str(secret_dir / n)} for n in secrets}}
    overlay_file.write_text(json.dumps(overlay, indent=2))
    overlay_file.chmod(0o600)
    config_file.write_text(json.dumps(config, indent=2))
    config_file.chmod(0o600)
    return overlay_file
