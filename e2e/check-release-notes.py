#!/usr/bin/env python3
"""Isolated checks for the changelog-to-Release publishing boundary."""

import pathlib
import runpy
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
extract = runpy.run_path(str(ROOT / "tools/release-notes.py"))["release_notes"]


class ReleaseNotesTest(unittest.TestCase):
    def test_exact_version_only(self):
        changelog = "## [未发布]\n- future\n## [0.5.0] — 2026-09-18\n\n### 修复\n- 本次修复\n\n## [0.4.0]\n- old\n"
        self.assertEqual(extract(changelog, "v0.5.0"), "### 修复\n- 本次修复\n")

    def test_reject_missing_empty_duplicate_and_unstable(self):
        for changelog, tag in [
            ("## [0.4.0]\n- old", "v0.5.0"),
            ("## [0.5.0]\n### 修复", "v0.5.0"),
            ("## [0.5.0]\n- a\n## [0.5.0]\n- b", "v0.5.0"),
            ("## [0.5.0-rc.1]\n- a", "v0.5.0-rc.1"),
        ]:
            with self.subTest(changelog=changelog, tag=tag), self.assertRaises(ValueError):
                extract(changelog, tag)


if __name__ == "__main__":
    unittest.main()
