"""Deployment state ownership and journal continuity; no model calls."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('platform_configure', ROOT / 'deploy/platform/configure.py')
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class PlatformBootstrap(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source'
        (self.source / 'deploy/stand').mkdir(parents=True)
        (self.source / 'deploy/stand/images.env').write_text('POSTGRES_IMAGE=postgres@sha256:' + 'a'*64 + '\n')
        self.state = self.base / 'state'
        self.args = [self.source, self.state, 'platform-test', 'a'*40,
                     {role: 'sha256:' + 'b'*64 for role in ['api', 'web', 'ml']},
                     '172.17.0.1', 49443, 49511, 49512, 49379]

    def prepare(self):
        return configure.prepare(*self.args)

    def test_repeat_keeps_journal_identities_and_never_starts_processing(self):
        first = self.prepare()
        identity_files = ['execution-proxy.identity', 'local-execution.identity', 'deployment.json']
        before = {p: (self.state / p).read_bytes() for p in identity_files}
        second = self.prepare()
        self.assertEqual(first, second)
        self.assertFalse(second['processing_started'])
        self.assertEqual(before, {p: (self.state / p).read_bytes() for p in identity_files})
        settings = json.loads((self.state / 'platform-override.json').read_text())['services']
        self.assertEqual(settings['api']['environment']['INSPECTOR_PIPELINE_EXECUTION'], 'durable')
        self.assertEqual(settings['ml']['image'] if 'image' in settings['ml'] else self.args[4]['ml'],
                         settings['execution-proxy']['image'])
        command = settings['execution-proxy']['command']
        self.assertEqual(command[command.index('--host') + 1], '127.0.0.1')
        self.assertNotIn('docker.sock', json.dumps(settings))
        env = dict(line.split('=', 1) for line in (self.state / 'stand.env').read_text().splitlines())
        self.assertRegex(env['REDIS_IMAGE'], r'^redis:[^@]+@sha256:[0-9a-f]{64}$')

    def test_rejects_another_project_or_port_map_in_existing_state(self):
        self.prepare()
        self.args[2] = 'other-project'
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            self.prepare()
        self.args[2] = 'platform-test'
        self.args[7] = 49444
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            self.prepare()

    def test_missing_identity_does_not_adopt_existing_execution_history(self):
        self.prepare()
        journal = self.state / 'pipeline-cache/external-executions'
        journal.mkdir()
        (journal / 'receipt.json').write_text('{"result":"historical"}')
        (self.state / 'execution-proxy.identity').unlink()
        with self.assertRaisesRegex(ValueError, 'refusing reinitialization'):
            self.prepare()
        self.assertEqual((journal / 'receipt.json').read_text(), '{"result":"historical"}')
        self.assertFalse((self.state / 'execution-proxy.identity').exists())

    def test_private_state_is_never_inside_the_docker_source_context(self):
        self.args[1] = self.source / 'private'
        with self.assertRaisesRegex(ValueError, 'outside source'):
            self.prepare()
        self.assertFalse((self.source / 'private').exists())

    def test_rejects_unidentified_existing_state_and_invalid_namespace(self):
        self.state.mkdir()
        (self.state / 'stand.env').write_text('EXISTING=1\n')
        with self.assertRaisesRegex(ValueError, 'unidentified'):
            self.prepare()
        self.args[2] = 'invalid;command'
        with self.assertRaisesRegex(ValueError, 'namespace'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()
