"""Exercise the actual launcher preflight without starting listeners or workers."""
import hashlib
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'start-local.sh'


class MockIsolation(unittest.TestCase):
    def run_preflight(self, non_mock=False):
        with tempfile.TemporaryDirectory(prefix='feedback-launcher-') as td:
            root = pathlib.Path(td)
            (root / 'scripts').mkdir()
            real = root / 'real'
            real.mkdir()
            with sqlite3.connect(real / 'feedback.db') as db:
                db.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
                db.execute('INSERT INTO settings VALUES (?, ?)', ('kaneo.baseUrl', 'https://real.example'))
            before = hashlib.sha256((real / 'feedback.db').read_bytes()).hexdigest()
            (root / '.env').write_text(f'FEEDBACK_DATA_DIR={real}\n')
            mock = root / 'data/mock-demo'
            if non_mock:
                mock.mkdir(parents=True)
                with sqlite3.connect(mock / 'feedback.db') as db:
                    db.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
                    db.execute('INSERT INTO settings VALUES (?, ?)', ('ai.baseUrl', 'https://real.example'))
            # The boundary precedes the first mkdir/launch; execute unmodified actual preflight.
            preflight = SOURCE.read_text().split('mkdir -p "$FEEDBACK_DATA_DIR"', 1)[0]
            script = root / 'scripts/preflight.sh'
            script.write_text(preflight + '\nprintf "%s\\n" "$FEEDBACK_DATA_DIR"\n')
            result = subprocess.run(['bash', str(script)], capture_output=True, text=True)
            self.assertEqual(before, hashlib.sha256((real / 'feedback.db').read_bytes()).hexdigest())
            if non_mock:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('拒绝启动', result.stderr)
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), str(mock))

    def test_shared_env_cannot_select_real_database(self):
        self.run_preflight()

    def test_mock_database_with_real_connection_rejected_before_worker(self):
        self.run_preflight(non_mock=True)


if __name__ == '__main__':
    unittest.main()
