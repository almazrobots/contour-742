import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('public',Path(__file__).parents[1]/'runner'/'verification-public-up.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PublicRouting(unittest.TestCase):
    def test_patch_preserves_main_and_basic_guard_but_bearer_api_is_not_basic_gated(self):
        before='site {\n\t@locked not path /api/* /health\n\tbasic_auth @locked bcrypt { import users }\n\treverse_proxy https://127.0.0.1:46443 {\n\t}\n}\n'
        fragment=(Path(__file__).parents[2]/'deploy/verification/Caddyfile.fragment').read_text()
        after=m.patch(before,fragment)
        self.assertIn(m.FEATURE_LOCK,after);self.assertIn('basic_auth @locked bcrypt',after)
        self.assertIn('reverse_proxy https://127.0.0.1:46443',after);self.assertIn('handle /verification/*',after)
        self.assertEqual(m.patch(after,fragment),after)
    def test_unexpected_config_is_not_rewritten(self):
        with self.assertRaises(ValueError):m.patch('other site {}','fragment')
