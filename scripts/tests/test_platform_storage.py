"""S3 startup continuity, private secrets and rejection of unsafe migrations."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('platform_storage', ROOT / 'deploy/platform/storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class PlatformStorage(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.state = self.base / 'state'
        self.state.mkdir()
        self.env = self.base / 'credentials.env'
        self.env.write_text('YC_S3_ENDPOINT=https://storage.example.test\n'
                            'YC_S3_REGION=region-1\nYC_S3_BUCKET=private-test\n'
                            'AWS_ACCESS_KEY_ID=test-access\nAWS_SECRET_ACCESS_KEY="test-secret"\n')
        self.env.chmod(0o600)
        self.key = self.base / 'corpus-key'
        self.key.write_text('a' * 64 + '\n')
        self.key.chmod(0o600)

    def configure(self, **kwargs):
        return storage.prepare_s3(self.state, self.env, self.key,
                                  'platform/release/blobs/', 'corpus/history/blobs/', **kwargs)

    def test_repeat_without_credentials_argument_retains_s3_and_secret_bytes(self):
        overlay = self.configure()
        before = {p: p.read_bytes() for p in self.state.rglob('*') if p.is_file()}
        self.assertEqual(storage.prepare_s3(self.state), overlay)
        self.assertEqual(before, {p: p.read_bytes() for p in self.state.rglob('*') if p.is_file()})
        d = json.loads(overlay.read_text())
        self.assertEqual(d['services']['api']['environment']['INSPECTOR_BLOB_STORE'], 's3')
        self.assertNotIn('test-secret', overlay.read_text())
        self.assertNotIn('test-access', (self.state / 'storage.json').read_text())
        self.assertEqual((self.state / 'secrets/s3/secret_access_key').stat().st_mode & 0o777, 0o600)

    def test_lost_secret_or_overlay_never_silently_reverts_to_fs(self):
        overlay = self.configure()
        overlay.unlink()
        with self.assertRaisesRegex(ValueError, 'refusing fs fallback'):
            storage.prepare_s3(self.state)
        self.configure()
        (self.state / 'secrets/s3/encryption_key').unlink()
        with self.assertRaisesRegex(ValueError, 'refusing fs fallback'):
            storage.prepare_s3(self.state)

    def test_changed_corpus_key_does_not_overwrite_existing_key(self):
        self.configure()
        old = (self.state / 'secrets/s3/encryption_key').read_text()
        self.key.write_text('b' * 64)
        with self.assertRaisesRegex(ValueError, 'explicit credential/key rotation'):
            self.configure()
        self.assertEqual((self.state / 'secrets/s3/encryption_key').read_text(), old)

    def test_rejects_public_credentials_and_http_endpoint_without_secret_disclosure(self):
        self.env.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private'):
            self.configure()
        self.env.chmod(0o600)
        self.env.write_text(self.env.read_text().replace('https://', 'http://'))
        with self.assertRaisesRegex(ValueError, 'HTTPS'):
            self.configure()
        self.assertFalse((self.state / 'storage.json').exists())

    def test_existing_bucket_identity_requires_explicit_migration(self):
        self.configure()
        self.env.write_text(self.env.read_text().replace('private-test', 'different-bucket'))
        with self.assertRaisesRegex(ValueError, 'explicit storage migration'):
            self.configure()

    def test_fs_default_and_incomplete_s3_inputs_are_distinct(self):
        self.assertIsNone(storage.prepare_s3(self.state))
        with self.assertRaisesRegex(ValueError, 'original --s3-key-file'):
            storage.prepare_s3(self.state, self.env)
        with self.assertRaisesRegex(ValueError, 'require --s3-env'):
            storage.prepare_s3(self.state, prefix='blobs/')


if __name__ == '__main__':
    unittest.main()
