#!/usr/bin/env python3
"""Executable portability contract for the dmSDK inventory importer."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "import_defold_sdk",
    REPOSITORY_ROOT / "scripts" / "import-defold-sdk.py",
)
assert SPEC and SPEC.loader
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class GeneratedPathPortabilityTests(unittest.TestCase):
    def test_native_and_posix_windows_paths_have_identical_bytes(self) -> None:
        root = r"D:\a\deherm\deherm"
        native = r"D:\a\deherm\deherm\upstream\defold\engine\render.h:7"
        posix = "D:/a/deherm/deherm/upstream/defold/engine/render.h:7"

        expected = "upstream/defold/engine/render.h:7"
        self.assertEqual(IMPORTER.strip_checkout_path(native, root), expected)
        self.assertEqual(IMPORTER.strip_checkout_path(posix, root), expected)

    def test_windows_path_matching_is_case_insensitive(self) -> None:
        root = r"D:\a\deherm\deherm"
        value = r"d:\A\Deherm\DEHERM\build\dmsdk-parse\missing.h"
        self.assertEqual(
            IMPORTER.strip_checkout_path(value, root),
            "build/dmsdk-parse/missing.h",
        )

    def test_nested_inventory_values_are_normalized_before_json_encoding(self) -> None:
        root = r"D:\a\deherm\deherm"
        value = {
            "diagnostics": [
                r"In file included from D:\a\deherm\deherm\upstream\x.h:1"
            ],
            "type": r"struct (unnamed at D:\a\deherm\deherm\upstream\x.h:2:3)",
            "unrelated": r"a\b",
        }

        self.assertEqual(
            IMPORTER.normalize_generated_value(value, root),
            {
                "diagnostics": ["In file included from upstream/x.h:1"],
                "type": "struct (unnamed at upstream/x.h:2:3)",
                "unrelated": r"a\b",
            },
        )

    def test_leak_guard_recognizes_json_escaped_windows_paths(self) -> None:
        root = r"D:\a\deherm\deherm"
        serialized = r'{"type":"D:\\a\\deherm\\deherm\\upstream\\x.h"}'
        self.assertTrue(IMPORTER.contains_checkout_path(serialized, root))
        self.assertFalse(
            IMPORTER.contains_checkout_path('{"type":"upstream/x.h"}', root)
        )


if __name__ == "__main__":
    unittest.main()
