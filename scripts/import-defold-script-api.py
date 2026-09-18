#!/usr/bin/env python3
"""Inventory Defold's generated public Lua/script API annotations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "upstream" / "ref-doc.zip"
OUTPUT = ROOT / "packages" / "bindings" / "generated" / "defold-script-api-inventory.json"
REPORT = ROOT / ".agents" / "docs" / "research" / "script-api-coverage.md"

FUNCTION = re.compile(r"^function\s+([\w.:]+)\(([^)]*)\)\s+end\s*$")
ANNOTATION = re.compile(r"^---@(?P<kind>class|field|enum|alias|param|return)\s*(?P<body>.*)$")


def revision() -> str:
    lock = (ROOT / "upstream.lock").read_text()
    match = re.search(r"^DEFOLD_REV=(\w+)$", lock, re.MULTILINE)
    return match.group(1) if match else "unknown"


def build_inventory() -> dict:
    if not ARCHIVE.exists():
        raise SystemExit("upstream/ref-doc.zip is missing; run npm run bootstrap")
    files = []
    declarations = []
    counts = {kind: 0 for kind in ("function", "class", "field", "enum", "alias")}
    with zipfile.ZipFile(ARCHIVE) as archive:
        names = sorted(
            name for name in archive.namelist()
            if name.startswith("doc/") and name.endswith(".lua")
        )
        for name in names:
            module = Path(name).stem
            lines = archive.read(name).decode("utf-8").splitlines()
            file_counts = {kind: 0 for kind in counts}
            pending: list[dict[str, str | int]] = []
            for line_number, line in enumerate(lines, 1):
                annotation = ANNOTATION.match(line)
                if annotation:
                    kind = annotation.group("kind")
                    body = annotation.group("body")
                    if kind in counts:
                        counts[kind] += 1
                        file_counts[kind] += 1
                        if kind in {"class", "field", "enum", "alias"}:
                            declarations.append(
                                {
                                    "kind": kind,
                                    "name": body.split()[0] if body else "",
                                    "module": module,
                                    "source": name,
                                    "line": line_number,
                                }
                            )
                    pending.append({"kind": kind, "body": body, "line": line_number})
                    continue
                function = FUNCTION.match(line)
                if function:
                    counts["function"] += 1
                    file_counts["function"] += 1
                    declarations.append(
                        {
                            "kind": "function",
                            "name": function.group(1),
                            "module": module,
                            "source": name,
                            "line": line_number,
                            "parameters": [
                                item.strip()
                                for item in function.group(2).split(",")
                                if item.strip()
                            ],
                            "annotations": [
                                item for item in pending if item["kind"] in {"param", "return"}
                            ],
                            "status": "needs-native-mapping",
                        }
                    )
                    pending = []
                elif not line.startswith("---") and line.strip():
                    pending = []
            files.append({"source": name, "module": module, "counts": file_counts})
    return {
        "schemaVersion": 1,
        "defoldRevision": revision(),
        "fileCount": len(files),
        "declarationCount": sum(counts.values()),
        "countsByKind": counts,
        "files": files,
        "declarations": declarations,
    }


def markdown(data: dict) -> str:
    rows = "\n".join(f"| `{kind}` | {count} |" for kind, count in data["countsByKind"].items())
    return f"""---
type: Research
title: Generated Defold script API coverage inventory
description: Declaration-level inventory of the public Lua-shaped engine API that TypeScript game code must replace.
tags: [research, generated, script-api, lua, typescript, coverage]
status: active
generated: {{ by: scripts/import-defold-script-api.py, at: 2026-09-17T00:00:00-04:00 }}
sources:
  - id: defold-ref-doc
    resource: https://d.defold.com/archive/{data['defoldRevision']}/engine/share/ref-doc.zip
    title: Pinned Defold generated API reference
    author: team:defold
---

# Defold script API coverage inventory

The pinned reference archive contains **{data['fileCount']}** generated Lua
annotation modules and **{data['declarationCount']}** declarations. This is the
source for the ergonomic `defold.script.*` TypeScript surface; dmSDK headers
remain the source for the lower-level `defold.sdk.*` surface.

| Kind | Count |
| --- | ---: |
{rows}

The discovery inventory deliberately records each of the
**{data['countsByKind']['function']} functions** as `needs-native-mapping`.
`scripts/generate-script-sdk.mjs` enriches that source ledger into the binding
IR, emits the complete TypeScript/TSDoc surface, and records runtime
implementation separately. A generated declaration is not automatically a
linked or conformance-tested binding.

The machine-readable inventory is
`packages/bindings/generated/defold-script-api-inventory.json`.
The enriched per-symbol ledger is
`packages/bindings/generated/defold-script-api-ir.json`.

## Executable coverage audit

Generation covers all 926 functions and all 410 named types, including TSDoc
and 1398 class fields. This inventory intentionally does not embed mutable
runtime counts. `packages/bindings/generated/defold-script-api-accounting.json` is the
SHA-bound, exact partition of generated stable-ID routes, separate-module
routes, and pending lowerings. `packages/bindings/generated/defold-script-real-engine-matrix.json`
independently records compile, link, and observed packaged-engine evidence.

A generated signature, a generated transport route, and an engine-observed
semantic call are three different states. Consumers must not infer the latter
from this declaration inventory.
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = build_inventory()
    outputs = (
        (OUTPUT, json.dumps(data, indent=2) + "\n"),
        (REPORT, markdown(data)),
    )
    if args.check:
        stale = [str(path.relative_to(ROOT)) for path, text in outputs if not path.exists() or path.read_text() != text]
        if stale:
            print("stale generated script API inventory: " + ", ".join(stale), file=sys.stderr)
            return 1
        print("Defold script API coverage inventory is current")
        return 0
    for path, text in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    print(f"inventoried {data['declarationCount']} script declarations from {data['fileCount']} modules")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
