#!/usr/bin/env python3
"""Inventory every public dmSDK declaration with Clang.

This is deliberately a coverage compiler, not a best-effort binding generator:
every discovered declaration receives a lowering class, and every header that
cannot be parsed remains visible in the report.  Later emitters consume this IR
and replace ``needs-policy`` with explicit ABI policies.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFOLD = ROOT / "upstream" / "defold"
ENGINE = DEFOLD / "engine"
INVENTORY = ROOT / "packages" / "bindings" / "generated" / "defold-sdk-inventory.json"
REPORT = ROOT / ".agents" / "docs" / "research" / "sdk-coverage.md"

DECL_KINDS = {
    "FunctionDecl": "function",
    "CXXMethodDecl": "method",
    "CXXConstructorDecl": "constructor",
    "CXXDestructorDecl": "destructor",
    "FunctionTemplateDecl": "function-template",
    "ClassTemplateDecl": "class-template",
    "CXXRecordDecl": "record",
    "RecordDecl": "record",
    "EnumDecl": "enum",
    "TypedefDecl": "type-alias",
    "TypeAliasDecl": "type-alias",
    "VarDecl": "variable",
}

CONTAINER_KINDS = {
    "NamespaceDecl",
    "LinkageSpecDecl",
    "ExternCContextDecl",
    "CXXRecordDecl",
    "RecordDecl",
    "ClassTemplateDecl",
}

SAFE_SCALARS = {
    "void",
    "bool",
    "float",
    "double",
    "int8_t",
    "uint8_t",
    "int16_t",
    "uint16_t",
    "int32_t",
    "uint32_t",
}


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


def absolute_source(file_name: str | None) -> Path | None:
    if not file_name:
        return None
    path = Path(file_name)
    return (ROOT / path).resolve() if not path.is_absolute() else path.resolve()


def node_source(node: dict[str, Any]) -> Path | None:
    loc = node.get("loc", {})
    source = absolute_source(loc.get("file"))
    if source:
        return source
    begin = node.get("range", {}).get("begin", {})
    return absolute_source(begin.get("file"))


def qualified(scope: tuple[str, ...], name: str) -> str:
    return "::".join((*scope, name)) if scope else name


def function_parts(node: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    signature = node.get("type", {}).get("qualType", "")
    result = signature.split("(", 1)[0].strip() if "(" in signature else signature
    parameters = []
    for child in node.get("inner", []):
        if child.get("kind") == "ParmVarDecl":
            parameters.append(
                {
                    "name": child.get("name", ""),
                    "type": child.get("type", {}).get("qualType", "unknown"),
                }
            )
    return result, parameters


def enum_value(node: dict[str, Any]) -> str | int | None:
    pending = [node]
    while pending:
        current = pending.pop()
        if "value" in current:
            value = current["value"]
            try:
                return int(value)
            except (TypeError, ValueError):
                return str(value)
        pending.extend(current.get("inner", []))
    return None


def record_members(node: dict[str, Any]) -> list[dict[str, Any]]:
    members = []
    access = "public" if node.get("tagUsed") == "struct" else "private"
    for child in node.get("inner", []):
        if child.get("kind") == "AccessSpecDecl":
            access = child.get("access", access)
        elif child.get("kind") == "FieldDecl" and child.get("name"):
            members.append(
                {
                    "name": child["name"],
                    "type": child.get("type", {}).get("qualType", "unknown"),
                    "access": child.get("access", access),
                    "line": child.get("loc", {}).get("line"),
                }
            )
    return members


def enum_members(node: dict[str, Any]) -> list[dict[str, Any]]:
    members = []
    for child in node.get("inner", []):
        if child.get("kind") != "EnumConstantDecl" or not child.get("name"):
            continue
        member = {"name": child["name"], "line": child.get("loc", {}).get("line")}
        value = enum_value(child)
        if value is not None:
            member["value"] = value
        members.append(member)
    return members


def normalize_type(type_name: str) -> str:
    value = re.sub(r"\b(const|volatile|restrict)\b", "", type_name)
    # clang spells an anonymous record by where it was declared, e.g.
    #   struct (unnamed struct at /abs/path/to/upstream/defold/.../render.h:147:9)
    # With the absolute path left in, the derived API policy depends on WHERE the
    # repository was cloned: the same Defold revision produced a different policy
    # root on a laptop, in a temporary worktree and on a CI runner, which breaks
    # the store's whole claim to be addressed by the engine revision. Rewriting
    # the checkout prefix to a repository-relative path makes the IR - and every
    # artifact derived from it - reproducible across machines.
    value = value.replace(f"{ROOT}/", "")
    value = re.sub(r"\s+", " ", value).strip()
    return value


def lowering_for(kind: str, node: dict[str, Any]) -> tuple[str, list[str]]:
    if kind not in {"function", "method", "constructor", "destructor", "function-template"}:
        return "type-only", []
    if kind != "function":
        return "needs-policy", [kind]

    result, parameters = function_parts(node)
    types = [result, *(item["type"] for item in parameters)]
    reasons: set[str] = set()
    for original in types:
        type_name = normalize_type(original)
        if "(*" in type_name or "(^" in type_name:
            reasons.add("callback")
        if "*" in type_name:
            reasons.add("pointer/ownership")
        if "&" in type_name:
            reasons.add("reference/lifetime")
        if "[" in type_name:
            reasons.add("array/span")
        if "<" in type_name or ">" in type_name:
            reasons.add("template")
        bare = type_name.replace("signed ", "").replace("unsigned ", "")
        if bare not in SAFE_SCALARS and not any(mark in type_name for mark in "*&[<"):
            reasons.add("named-or-wide-type")
    return ("direct-candidate", []) if not reasons else ("needs-policy", sorted(reasons))


def symbol_from_node(
    node: dict[str, Any], kind: str, scope: tuple[str, ...], header: Path, access: str
) -> dict[str, Any] | None:
    name = node.get("name")
    if not name or node.get("isImplicit"):
        return None
    status, reasons = lowering_for(kind, node)
    symbol: dict[str, Any] = {
        "kind": kind,
        "name": qualified(scope, name),
        "header": relative(header),
        "line": node.get("loc", {}).get("line"),
        "status": status,
        "access": node.get("access", access),
    }
    type_name = node.get("type", {}).get("qualType")
    if type_name:
        symbol["type"] = type_name
    if kind in {"function", "method", "constructor", "destructor"}:
        result, parameters = function_parts(node)
        symbol["returns"] = result
        symbol["parameters"] = parameters
    if kind == "record":
        symbol["recordKind"] = node.get("tagUsed", "class")
        symbol["completeDefinition"] = node.get("completeDefinition", False)
        symbol["members"] = record_members(node)
        if node.get("bases"):
            symbol["bases"] = [
                base.get("type", {}).get("qualType", "unknown")
                for base in node["bases"]
            ]
    if kind == "enum":
        symbol["members"] = enum_members(node)
    if reasons:
        symbol["policyReasons"] = reasons
    return symbol


def declarations_for(ast: dict[str, Any], header: Path) -> list[dict[str, Any]]:
    target = header.resolve()
    declarations: list[dict[str, Any]] = []

    def visit_scope(
        children: Iterable[dict[str, Any]],
        scope: tuple[str, ...],
        inherited_source: Path | None,
        inherited_access: str = "public",
    ) -> None:
        last_source = inherited_source
        current_access = inherited_access
        for node in children:
            explicit_source = node_source(node)
            source = explicit_source or last_source
            if explicit_source:
                last_source = explicit_source
            kind_name = node.get("kind", "")
            if kind_name == "AccessSpecDecl":
                current_access = node.get("access", current_access)
                continue
            in_target = source == target
            public_kind = DECL_KINDS.get(kind_name)

            if in_target and public_kind:
                symbol = symbol_from_node(node, public_kind, scope, header, current_access)
                if symbol:
                    declarations.append(symbol)

            if kind_name in CONTAINER_KINDS and in_target:
                container_name = node.get("name")
                child_scope = (*scope, container_name) if container_name else scope
                child_access = (
                    "public"
                    if kind_name in {"NamespaceDecl", "LinkageSpecDecl", "ExternCContextDecl"}
                    or node.get("tagUsed") == "struct"
                    else "private"
                )
                visit_scope(node.get("inner", []), child_scope, source, child_access)

    visit_scope(ast.get("inner", []), (), None)
    return declarations


def include_roots() -> list[Path]:
    roots = {path.parent for path in ENGINE.glob("**/dmsdk") if path.is_dir()}
    roots.add(ENGINE / "sdk" / "src")
    return sorted(roots)


def parse_header(header: Path, includes: list[Path]) -> dict[str, Any]:
    command = [
        "clang++",
        "-x",
        "c++",
        "-std=c++17",
        "-fsyntax-only",
        "-Wno-everything",
        "-Xclang",
        "-ast-dump=json",
        "-DLUA_API=",
        "-DDM_PLATFORM_OSX=1",
        *(f"-I{path}" for path in includes),
        str(header),
    ]
    try:
        process = subprocess.run(
            command,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=45,
        )
    except subprocess.TimeoutExpired:
        return {"header": relative(header), "error": "clang timed out after 45 seconds"}
    # Clang prints absolute paths in diagnostics, and these are recorded as
    # blocker evidence. Left as-is they put the checkout location into the
    # committed inventory, which made the derived API policy depend on where the
    # repository was cloned rather than on the engine revision it names.
    stderr = process.stderr.decode("utf-8", errors="replace").replace(f"{ROOT}/", "")
    try:
        ast = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        detail = "\n".join(stderr.strip().splitlines()[-12:])
        return {"header": relative(header), "error": detail or f"invalid Clang JSON: {error}"}
    result = {
        "header": relative(header),
        "declarations": declarations_for(ast, header),
    }
    if process.returncode != 0:
        result["diagnostics"] = "\n".join(stderr.strip().splitlines()[-12:])
    return result


def defold_revision() -> str:
    lock = (ROOT / "upstream.lock").read_text()
    match = re.search(r"^DEFOLD_REV=(\w+)$", lock, re.MULTILINE)
    return match.group(1) if match else "unknown"


def inventory() -> dict[str, Any]:
    headers = sorted(
        path
        for path in ENGINE.glob("**/dmsdk/**/*")
        if path.is_file() and path.suffix in {".h", ".hpp"}
    )
    workers = min(8, max(1, os.cpu_count() or 1))
    with tempfile.TemporaryDirectory(prefix="defold-hermes-sdk-") as temp_name:
        temp = Path(temp_name)
        vectormath = DEFOLD / "packages" / "vectormathlibrary-r1649-common.tar.gz"
        includes = include_roots()
        if vectormath.exists():
            with tarfile.open(vectormath) as archive:
                archive.extractall(temp, filter="data")
            includes.append(temp / "include")
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(lambda header: parse_header(header, includes), headers))

    parsed = [item for item in results if "error" not in item]
    failures = [
        {"header": item["header"], "error": item["error"]}
        for item in results
        if "error" in item
    ]
    diagnostics = [
        {"header": item["header"], "diagnostics": item["diagnostics"]}
        for item in parsed
        if "diagnostics" in item
    ]
    declarations = [decl for item in parsed for decl in item["declarations"]]
    counts: dict[str, int] = {}
    statuses: dict[str, int] = {}
    for declaration in declarations:
        counts[declaration["kind"]] = counts.get(declaration["kind"], 0) + 1
        statuses[declaration["status"]] = statuses.get(declaration["status"], 0) + 1

    return {
        "schemaVersion": 1,
        "defoldRevision": defold_revision(),
        "platform": "arm64-macos",
        "headerCount": len(headers),
        "parsedHeaderCount": len(parsed),
        "failedHeaderCount": len(failures),
        "diagnosticHeaderCount": len(diagnostics),
        "declarationCount": len(declarations),
        "countsByKind": dict(sorted(counts.items())),
        "countsByStatus": dict(sorted(statuses.items())),
        "failures": failures,
        "diagnostics": diagnostics,
        "declarations": declarations,
    }


def markdown(data: dict[str, Any]) -> str:
    status_rows = "\n".join(
        f"| `{name}` | {count} |" for name, count in data["countsByStatus"].items()
    )
    kind_rows = "\n".join(
        f"| `{name}` | {count} |" for name, count in data["countsByKind"].items()
    )
    if data["failures"]:
        failures = "\n".join(
            f"* `{item['header']}` — `{item['error'].splitlines()[-1]}`"
            for item in data["failures"]
        )
    else:
        failures = "None."
    diagnostics = (
        f"{data['diagnosticHeaderCount']} headers emitted Clang diagnostics, mostly because "
        "generated DDF headers are build artifacts not present in a source checkout. Clang "
        "still produced a target-header AST for the inventory. These headers must be "
        "re-imported against the packaged Defold SDK before code emission."
        if data["diagnosticHeaderCount"]
        else "None."
    )
    return f"""---
type: Research
title: Generated dmSDK coverage inventory
description: Clang-derived coverage accounting for every public dmSDK header and declaration at the pinned Defold revision.
tags: [research, generated, dmsdk, bindings, coverage]
status: active
generated: {{ by: scripts/import-defold-sdk.py, at: 2026-09-17T00:00:00-04:00 }}
sources:
  - id: defold
    resource: https://github.com/defold/defold/tree/{data['defoldRevision']}/engine
    title: Pinned Defold engine source
    author: team:defold
---

# dmSDK coverage inventory

Pinned revision: `{data['defoldRevision']}`
Inventory platform: `{data['platform']}`

Clang parsed **{data['parsedHeaderCount']} of {data['headerCount']}** public
`dmsdk/**/*.h(pp)` headers and accounted for **{data['declarationCount']}**
declarations. A declaration is accounted for when it is either a type-only
dependency, a direct scalar ABI candidate, or explicitly blocked on a lowering
policy. Nothing is silently discarded.

## Lowering state

| State | Declarations |
| --- | ---: |
{status_rows}

`needs-policy` is the generator queue: pointers, ownership, callbacks,
lifetimes, templates, arrays/spans, named handles, and wide integers must gain
an explicit ABI rule. It is not counted as implemented runtime compatibility.
`scripts/generate-dmsdk-sdk.mjs` expands these reason classes into explicit
per-symbol ABI strategies, hides non-public members, and emits the raw
TypeScript surface. Runtime implementation and conformance remain independent
coverage gates.

## Declaration kinds

| Kind | Count |
| --- | ---: |
{kind_rows}

## Parse failures

{failures}

## Partial-AST diagnostics

{diagnostics}

The machine-readable inventory is
`packages/bindings/generated/defold-sdk-inventory.json`. CI regenerates and compares it
so new or removed upstream API cannot drift unnoticed.
The enriched per-symbol ledger is `packages/bindings/generated/defold-sdk-ir.json`.

## Executable coverage audit

The complete declaration surface is generated, but this source inventory does
not embed mutable runtime-implementation counts. The exact generated adapter
and blocker census lives in the SHA-bound family reports under
`packages/bindings/generated/defold-dmsdk-*.json`; the ABI-shape queue is
`packages/bindings/generated/defold-dmsdk-abi-shapes.json`. Host behavior, extension
retention, target compilation, and live-engine observation remain independent
evidence stages.

“Zero unresolved TypeScript tokens” means only that the generator classified
every source token. It does not imply ABI layout, ownership, lifetime, target
support, or runtime compatibility.
"""


def strip_checkout_path(text: str) -> str:
    """Remove this checkout's location from a generated artifact.

    Nothing generated here may carry an absolute path.  Clang spells anonymous
    records and diagnostics by where it found them, and those strings flow into
    the dmSDK IR and from there into the derived API policy - which made the
    policy a function of WHERE the repository was cloned rather than of the
    engine revision its address names.  The same Defold revision produced three
    different policy roots on a laptop, in a temporary worktree, and on a CI
    runner, and the published store carried a developer's home directory.

    Individual call sites are normalized too, but this is the catch-all: it is
    applied to the serialized bytes, so a new leak cannot reach disk by taking a
    code path nobody remembered to normalize.
    """
    return text.replace(f"{ROOT}/", "")


def serialized_outputs() -> tuple[str, str]:
    data = inventory()
    inventory_text = strip_checkout_path(json.dumps(data, indent=2, sort_keys=False) + "\n")
    report_text = strip_checkout_path(markdown(data))
    # Fail closed rather than publish a path. A leak that survives the rewrite
    # means the path was spelled some other way - a symlink, a relative prefix -
    # and silently shipping it is what this whole change exists to stop.
    for name, text in (("inventory", inventory_text), ("report", report_text)):
        if str(ROOT) in text:
            raise SystemExit(f"generated SDK {name} still contains the checkout path {ROOT}")
    return inventory_text, report_text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    inventory_text, report_text = serialized_outputs()
    outputs = ((INVENTORY, inventory_text), (REPORT, report_text))
    if args.check:
        stale = [str(path.relative_to(ROOT)) for path, text in outputs if not path.exists() or path.read_text() != text]
        if stale:
            print("stale generated SDK inventory: " + ", ".join(stale), file=sys.stderr)
            return 1
        print("dmSDK coverage inventory is current")
        return 0
    for path, text in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    print(
        f"inventoried {json.loads(inventory_text)['declarationCount']} declarations "
        f"from {json.loads(inventory_text)['parsedHeaderCount']} headers"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
