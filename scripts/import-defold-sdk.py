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
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
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

TYPE_SUPPORT_KINDS = {"record", "enum", "type-alias", "class-template"}

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


def cli_path(path: Path) -> str:
    """Spell a filesystem path identically for Clang on every host.

    Native ``WindowsPath`` stringification uses backslashes. Clang preserves
    those spellings in diagnostics and anonymous-record type names, both of
    which are authoritative inventory fields. Supplying POSIX separators keeps
    the compiler's JSON/text output independent of the runner OS.
    """
    return path.resolve().as_posix()


def canonical_checkout_root(root: Path | str = ROOT) -> str:
    return str(root).replace("\\", "/").rstrip("/")


def strip_checkout_path(text: str, root: Path | str = ROOT) -> str:
    """Remove a checkout prefix and canonicalize its path separators.

    The normalization happens on compiler-originated values *before* JSON
    serialization. That distinction matters on Windows: JSON doubles each
    backslash, so a serialized-text replacement cannot reliably recognize the
    original path. Matching is case-insensitive because Windows drive and path
    casing are not semantic inputs to the generated surface.
    """
    canonical = text.replace("\\", "/")
    prefix = canonical_checkout_root(root) + "/"
    if prefix.casefold() not in canonical.casefold():
        return text
    return re.sub(re.escape(prefix), "", canonical, flags=re.IGNORECASE)


def normalize_generated_value(value: Any, root: Path | str = ROOT) -> Any:
    """Recursively remove host/cache spellings from generated data."""
    if isinstance(value, str):
        normalized = strip_checkout_path(value, root)
        # The downloaded SDK is a revision-keyed derivation cache. Clang writes
        # that physical path into provenance and anonymous type spellings, but
        # the policy object itself must be content-addressed and shareable
        # across revisions with identical source facts. Preserve which stable
        # SDK tree supplied the declaration without embedding its cache key.
        rewritten = re.sub(
            r"upstream[/\\]extender[/\\]server[/\\]app[/\\]sdk[/\\][^/\\]+[/\\]defoldsdk[/\\]",
            "upstream/defold-sdk/",
            normalized,
        )
        return rewritten.replace("\\", "/") if rewritten != normalized else normalized
    if isinstance(value, list):
        return [normalize_generated_value(item, root) for item in value]
    if isinstance(value, dict):
        return {
            key: normalize_generated_value(item, root)
            for key, item in value.items()
        }
    return value


def contains_checkout_path(text: str, root: Path | str = ROOT) -> bool:
    """Recognize native, POSIX, and JSON-escaped checkout spellings."""
    comparable = re.sub(r"[\\/]+", "/", text).casefold()
    return canonical_checkout_root(root).casefold() in comparable


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
    value = strip_checkout_path(value)
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
    # How this declaration is reached, which is not the same question as
    # whether it exists.
    #
    # dmSDK is a HEADER sdk: an extension includes it and compiles against it.
    # A `static inline` function - dmEndian::ByteSwap is one - is compiled into
    # the caller's translation unit and deliberately emits no external symbol.
    # Our generated bindings are themselves C++ that Extender compiles, so such
    # a function is reached by the thunk we already emit; finding it absent from
    # every engine archive is the CORRECT result, not a missing symbol. Without
    # recording this, a linkage check cannot tell "header-only by design" from
    # "declared but not shipped" and would block both alike.
    #
    # `mangledName` is the compiler's own answer to which symbol a declaration
    # denotes. Recording it lets a symbol-evidence pass match mangled-to-mangled
    # instead of reconstructing names from demangler output, which differs
    # between the Itanium and MSVC ABIs and cannot separate overloads without
    # resolving typedefs.
    for field, key in (("inline", "inline"), ("storageClass", "storageClass"), ("mangledName", "mangledName")):
        if node.get(field):
            symbol[key] = node[field]
    type_name = node.get("type", {}).get("qualType")
    if type_name:
        symbol["type"] = type_name
    if kind in {"function", "method", "constructor", "destructor"}:
        result, parameters = function_parts(node)
        symbol["returns"] = result
        symbol["parameters"] = parameters
        symbol["sourceDefined"] = any(
            child.get("kind") == "CompoundStmt" for child in node.get("inner", [])
        )
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


def referenced_type_support(
    ast: dict[str, Any], header: Path, declarations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Return the minimal transitive type closure imported from support headers.

    Generated DDF and third-party headers are necessary to understand public
    dmSDK signatures, but their APIs are not themselves dmSDK declarations.
    Keeping only referenced enum/record/alias facts preserves that boundary and
    avoids copying the entire dependency AST into the policy.
    """
    target = header.resolve()
    candidates: list[dict[str, Any]] = []

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
            public_kind = DECL_KINDS.get(kind_name)
            if source and source != target and public_kind in TYPE_SUPPORT_KINDS:
                try:
                    source.relative_to(ROOT)
                except ValueError:
                    pass
                else:
                    symbol = symbol_from_node(node, public_kind, scope, source, current_access)
                    if symbol:
                        candidates.append(symbol)
            if kind_name in CONTAINER_KINDS:
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
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for candidate in candidates:
        key = (candidate["kind"], candidate["name"])
        prior = unique.get(key)
        if prior is None or candidate.get("completeDefinition", False):
            unique[key] = candidate

    exact = {item["name"]: item for item in unique.values()}
    leaves: dict[str, list[dict[str, Any]]] = {}
    for item in unique.values():
        leaves.setdefault(item["name"].split("::")[-1], []).append(item)

    def type_texts(item: dict[str, Any]) -> list[str]:
        return [
            str(item.get("type", "")),
            str(item.get("returns", "")),
            *(str(parameter.get("type", "")) for parameter in item.get("parameters", [])),
            *(str(member.get("type", "")) for member in item.get("members", [])),
            *(str(base) for base in item.get("bases", [])),
        ]

    def resolve_token(token: str, owner: str) -> dict[str, Any] | None:
        if token in exact:
            return exact[token]
        if "::" not in token:
            scope = owner.split("::")[:-1]
            for length in range(len(scope), 0, -1):
                candidate = exact.get("::".join((*scope[:length], token)))
                if candidate:
                    return candidate
        matches = leaves.get(token.split("::")[-1], [])
        return matches[0] if len(matches) == 1 else None

    selected: dict[tuple[str, str], dict[str, Any]] = {}
    pending = list(declarations)
    token_pattern = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*")
    while pending:
        item = pending.pop()
        for text in type_texts(item):
            for token in token_pattern.findall(text):
                support = resolve_token(token, item.get("name", ""))
                if not support:
                    continue
                key = (support["kind"], support["name"])
                if key in selected:
                    continue
                selected[key] = support
                pending.append(support)
    return sorted(selected.values(), key=lambda item: (item["name"], item["kind"]))


def include_roots() -> list[Path]:
    roots = {path.parent for path in ENGINE.glob("**/dmsdk") if path.is_dir()}
    roots.add(ENGINE / "sdk" / "src")
    # The source checkout deliberately does not carry generated DDF headers or
    # third-party platform headers such as Vulkan.  Parsing a public header
    # without them still yields a partial Clang AST, but Clang recovers the
    # missing names as `int`; treating that recovery value as API ground truth
    # corrupts enum and native-handle bindings.  Resolve declarations against
    # the digest-pinned SDK for this exact engine revision instead.  These are
    # derivation-time support headers only: their resolved facts enter the
    # policy, while consumers continue to materialize from policy + compiler.
    revision = lock_value("DEFOLD_REV")
    sdk_root = ROOT / "upstream" / "extender" / "server" / "app" / "sdk" / revision / "defoldsdk"
    sentinel = sdk_root / ".deherm-sdk-sha256"
    expected = lock_value("DEFOLD_SDK_SHA256")
    observed = sentinel.read_text(encoding="utf-8").strip() if sentinel.is_file() else ""
    if observed != expected:
        raise SystemExit(
            f"the pinned Defold SDK support headers are not present at {relative(sdk_root)} "
            "or do not match upstream.lock; run `pnpm bootstrap:upstreams -- defold-sdk`"
        )
    for relative_root in ("sdk/include", "include", "ext/include"):
        path = sdk_root / relative_root
        if not path.is_dir():
            raise SystemExit(f"the pinned Defold SDK is missing {relative(sdk_root / relative_root)}")
        roots.add(path)
    return sorted(roots)


# The clang target triple each bundle target is parsed under, read from the
# override that already models targets rather than restated here.
#
# Mangling is ABI-specific and NOT derivable. MSVC's scheme was never published,
# and even among Itanium targets an ILP32 architecture spells a 64-bit integer
# differently from an LP64 one - dmEndian::ByteSwap ends `Ey` on armv7 and wasm
# but `Em` on aarch64-linux. Inferring one platform's symbols from another's
# therefore reports absences that are really spelling differences.
#
# Only the MANGLING is taken from these passes; the declarations themselves come
# from the primary parse, so a target whose parse fails costs mangled names
# rather than declarations.
def target_triples() -> dict[str, str]:
    triples = overrides().get("triples") or {}
    if not triples:
        raise SystemExit("dmsdk-target-macros.json declares no target triples")
    return triples


OVERRIDES = ROOT / "packages" / "bindings" / "overrides" / "dmsdk-target-macros.json"
_OVERRIDES_CACHE: dict[str, Any] | None = None


def overrides() -> dict[str, Any]:
    global _OVERRIDES_CACHE
    if _OVERRIDES_CACHE is None:
        _OVERRIDES_CACHE = json.loads(OVERRIDES.read_text(encoding="utf-8"))
    return _OVERRIDES_CACHE


def declaration_parse() -> dict[str, Any]:
    """The declared environment the DECLARATION inventory is taken under.

    Not a bundle target.  It is the assignment in which no platform branch is
    taken, which is what lets one parse stand for every target and what lets any
    machine reproduce it - see the override's own `declarationParseComment`.
    """
    declared = overrides().get("declarationParse")
    if not declared or not declared.get("triple"):
        raise SystemExit(
            f"{relative(OVERRIDES)} declares no declarationParse.triple; the dmSDK parse "
            "refuses to fall back on the host's default target"
        )
    return declared


def lock_value(key: str) -> str:
    match = re.search(rf"^{key}=(.*)$", (ROOT / "upstream.lock").read_text(encoding="utf-8"), re.MULTILINE)
    if not match or not match.group(1).strip():
        raise SystemExit(f"upstream.lock does not pin {key}")
    return match.group(1).strip()


def parse_sysroot() -> Path:
    """The pinned C library headers the dmSDK is resolved against.

    Fetched on demand and verified against the digest `upstream.lock` pins, the
    way every other ground truth here is.  Only the include tree is unpacked:
    nothing is compiled, so the archive's libraries would be dead weight.

    Using the deriving host's libc instead is what made the inventory a function
    of the machine - see the lock's own note.  A missing sysroot is therefore a
    hard failure with a named reason, never a silent parse without one.
    """
    digest = lock_value("DMSDK_PARSE_SYSROOT_SHA256")
    include = lock_value("DMSDK_PARSE_SYSROOT_INCLUDE")
    base = ROOT / "upstream" / "dmsdk-parse-sysroot" / digest[:16]
    target = base / include
    if (target / "stdint.h").is_file():
        return target

    url = lock_value("DMSDK_PARSE_SYSROOT_URL")
    try:
        with urllib.request.urlopen(url, timeout=300) as response:
            payload = response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise SystemExit(
            f"the dmSDK parse sysroot is not present at {relative(base)} and {url} "
            f"could not be fetched ({error}). Run `pnpm bootstrap:upstreams` on a "
            "networked machine; the parse will not fall back on this host's libc."
        )
    observed = hashlib.sha256(payload).hexdigest()
    if observed != digest:
        raise SystemExit(f"{url} served sha256 {observed}, but upstream.lock pins {digest}")

    base.parent.mkdir(parents=True, exist_ok=True)
    staging = base.with_name(f"{base.name}.incoming")
    shutil.rmtree(staging, ignore_errors=True)
    prefix = f"{include}/"
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        members = [item for item in archive.getmembers() if item.name.startswith(prefix)]
        if not members:
            raise SystemExit(f"{url} carries no {include}; DMSDK_PARSE_SYSROOT_INCLUDE is wrong")
        archive.extractall(staging, members=members, filter="data")
    if not (staging / include / "stdint.h").is_file():
        raise SystemExit(f"{url} unpacked without {include}/stdint.h")
    # Rename into place last, so an interrupted fetch leaves no directory that
    # the next run would mistake for a complete sysroot.
    shutil.rmtree(base, ignore_errors=True)
    staging.replace(base)
    return target


# The standard integer type whose SPELLING decides a mangled name, beside the
# clang predefine that answers it for the target being parsed.
#
# The pinned sysroot spells these once, for one ABI: musl derives them from its
# own `_Addr` and `_Int64`, which wasm32 fixes at `long` and `long long`. Used
# unchanged for every target, that is wrong wherever the target disagrees -
# `dmhash_t` is `uint64_t`, which is `unsigned long long` on wasm32 and
# `unsigned long` on LP64 Linux and Android, so `dmDDF::GetDescriptorFromHash`
# was looked up as `...Ey` in archives that define `...Em` and reported absent
# from four targets it is present in. A false absence is worse than no answer.
#
# Clang's own `__UINT64_TYPE__` and friends ARE the target's answer, so they are
# asked instead. musl's `__DEFINED_*` guards exist for exactly this, so the
# sysroot then defers rather than conflicting.
SPELLING_PREDEFINES = {
    "size_t": "__SIZE_TYPE__",
    "ptrdiff_t": "__PTRDIFF_TYPE__",
    "intptr_t": "__INTPTR_TYPE__",
    "uintptr_t": "__UINTPTR_TYPE__",
    "int8_t": "__INT8_TYPE__",
    "int16_t": "__INT16_TYPE__",
    "int32_t": "__INT32_TYPE__",
    "int64_t": "__INT64_TYPE__",
    "uint8_t": "__UINT8_TYPE__",
    "uint16_t": "__UINT16_TYPE__",
    "uint32_t": "__UINT32_TYPE__",
    "uint64_t": "__UINT64_TYPE__",
    "intmax_t": "__INTMAX_TYPE__",
    "uintmax_t": "__UINTMAX_TYPE__",
}


def spelling_prelude() -> Path:
    """Write the header that gives every target its own integer spellings.

    Emitted rather than vendored: there is nothing here to review that clang
    does not already decide, and a checked-in copy would be a restatement of the
    compiler's answer that could fall out of step with it.
    """
    lines = [
        "// Generated by scripts/import-defold-sdk.py. Do not edit.",
        "// Each standard integer type is taken from the compiler's own answer for",
        "// the target being parsed; musl's __DEFINED_* guards make the pinned",
        "// sysroot defer to it instead of spelling it for one ABI.",
    ]
    for name, predefine in SPELLING_PREDEFINES.items():
        lines += [
            f"#if defined({predefine}) && !defined(__DEFINED_{name})",
            f"typedef {predefine} {name};",
            f"#define __DEFINED_{name}",
            "#endif",
        ]
    path = ROOT / "build" / "dmsdk-parse" / "target-spellings.h"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def parse_flags() -> list[str]:
    """Everything the parse environment contributes to every clang invocation.

    `-nostdlibinc` removes the host's own include paths while leaving clang's
    builtin ones, so `<stdint.h>` and `<string.h>` come from the pinned sysroot
    and from nowhere else.  Without it the flags below would be additions to the
    host's libc rather than a replacement for it.
    """
    declared = declaration_parse()
    defines = declared.get("defines") or {}
    return [
        "-nostdlibinc",
        f"-isystem{cli_path(parse_sysroot())}",
        "-include",
        cli_path(spelling_prelude()),
        *(f"-D{name}={value}" for name, value in sorted(defines.items())),
    ]


def assert_platform_neutral() -> list[str]:
    """Ask clang whether the declared triple really takes no platform branch.

    The override claims the triple defines none of these macros.  That claim is
    the whole reason one parse can stand for thirteen targets, so it is asked of
    the compiler rather than asserted in a comment: a clang release that started
    predefining `__linux__` for this triple would silently change which branch
    every platform conditional in the dmSDK takes.
    """
    declared = declaration_parse()
    neutral = declared.get("neutralOf") or []
    if not neutral:
        return []
    process = subprocess.run(
        ["clang++", "-x", "c++", "-std=c++17", "-target", declared["triple"], "-nostdlibinc", "-dM", "-E", "-"],
        input=b"",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0:
        detail = process.stderr.decode("utf-8", errors="replace").strip().splitlines()[-1:]
        raise SystemExit(
            f"clang cannot target {declared['triple']}: {' '.join(detail) or 'no diagnostic'}"
        )
    defined = {
        line.split(" ", 2)[1].split("(", 1)[0]
        for line in process.stdout.decode("utf-8", errors="replace").splitlines()
        if line.startswith("#define ")
    }
    violated = sorted(name for name in neutral if name in defined)
    if violated:
        raise SystemExit(
            f"{declared['triple']} predefines {', '.join(violated)}, so the declaration parse "
            f"would take a platform branch. Update {relative(OVERRIDES)}.declarationParse."
        )
    return sorted(neutral)


def declaration_key(declaration: dict[str, Any]) -> tuple:
    """What identifies a declaration within one header across two parses.

    Name alone is not enough - overloads share it - and the mangled name cannot
    be used because it is the thing being joined. Line plus signature separates
    every overload in practice.
    """
    return (declaration.get("name"), declaration.get("line"), declaration.get("type"))


def merge_target_mangling(
    primary: list[dict[str, Any]],
    triples: dict[str, str],
    per_triple: dict[str, list[dict[str, Any]]],
) -> None:
    """Record, per BUNDLE TARGET, the symbol clang says that target would emit."""
    indexed: dict[str, dict[str, dict[tuple, str]]] = {}
    support_types: dict[str, dict[str, dict[tuple[str, str], str]]] = {}
    for triple, entries in per_triple.items():
        by_header: dict[str, dict[tuple, str]] = {}
        support_by_header: dict[str, dict[tuple[str, str], str]] = {}
        for entry in entries:
            by_header[entry.get("header")] = {
                declaration_key(d): d["mangledName"]
                for d in entry.get("declarations", [])
                if d.get("mangledName")
            }
            support_by_header[entry.get("header")] = {
                (declaration["kind"], declaration["name"]): declaration["type"]
                for declaration in entry.get("typeSupportDeclarations", [])
                if declaration.get("type")
            }
        indexed[triple] = by_header
        support_types[triple] = support_by_header

    for entry in primary:
        header = entry.get("header")
        for declaration in entry.get("declarations", []):
            key = declaration_key(declaration)
            names = {}
            for target, triple in triples.items():
                mangled = indexed.get(triple, {}).get(header, {}).get(key)
                if mangled:
                    names[target] = mangled
            if names:
                declaration["mangledNames"] = names
        for declaration in entry.get("typeSupportDeclarations", []):
            key = (declaration["kind"], declaration["name"])
            types = {
                target: support_types.get(triple, {}).get(header, {}).get(key)
                for target, triple in triples.items()
            }
            types = {target: spelling for target, spelling in types.items() if spelling}
            if types:
                declaration["targetTypes"] = types


def parse_header(header: Path, includes: list[Path], target: str, flags: list[str]) -> dict[str, Any]:
    """Parse one header under one ABI.

    `target` is always explicit.  It used to be optional, and omitting it meant
    "whatever this machine compiles for by default" - which is how the inventory
    came to be labelled `arm64-macos` and how the nightly that derives a policy
    came to be pinned to a macOS runner.
    """
    command = [
        "clang++",
        "-x",
        "c++",
        "-std=c++17",
        "-fsyntax-only",
        "-Wno-everything",
        "-Xclang",
        "-ast-dump=json",
        "-target",
        target,
        *flags,
        *(f"-I{cli_path(path)}" for path in includes),
        cli_path(header),
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
    stderr = strip_checkout_path(process.stderr.decode("utf-8", errors="replace"))
    try:
        ast = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        detail = "\n".join(stderr.strip().splitlines()[-12:])
        return {"header": relative(header), "error": detail or f"invalid Clang JSON: {error}"}
    declarations = declarations_for(ast, header)
    result = {
        "header": relative(header),
        "declarations": declarations,
        "typeSupportDeclarations": referenced_type_support(ast, header, declarations),
    }
    if process.returncode != 0:
        result["diagnostics"] = "\n".join(stderr.strip().splitlines()[-12:])
    return result


def defold_revision() -> str:
    lock = (ROOT / "upstream.lock").read_text(encoding="utf-8")
    match = re.search(r"^DEFOLD_REV=(\w+)$", lock, re.MULTILINE)
    return match.group(1) if match else "unknown"


def inventory() -> dict[str, Any]:
    headers = sorted(
        path
        for path in ENGINE.glob("**/dmsdk/**/*")
        if path.is_file() and path.suffix in {".h", ".hpp"}
    )
    workers = min(8, max(1, os.cpu_count() or 1))
    declared = declaration_parse()
    neutral = assert_platform_neutral()
    flags = parse_flags()
    # A FIXED path, not a temporary one. Clang spells an unresolved include by
    # where it was looking, and those strings are recorded as diagnostics: a
    # per-run temporary directory therefore put a random name into the committed
    # inventory. Under the repository root it is removed by the same rewrite that
    # removes the checkout prefix, so the diagnostic reads the same everywhere.
    temp = ROOT / "build" / "dmsdk-parse" / "vectormath"
    shutil.rmtree(temp, ignore_errors=True)
    vectormath = DEFOLD / "packages" / "vectormathlibrary-r1649-common.tar.gz"
    includes = include_roots()
    if vectormath.exists():
        temp.mkdir(parents=True, exist_ok=True)
        with tarfile.open(vectormath) as archive:
            archive.extractall(temp, filter="data")
        includes.append(temp / "include")
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(
            lambda header: parse_header(header, includes, declared["triple"], flags), headers))
        # One pass per DISTINCT triple; two bundle targets that share an
        # ABI share a parse. Same flags, same headers: only the ABI moves, so a
        # declaration joins back to the primary parse by its own identity.
        triples = target_triples()
        per_triple: dict[str, list[dict[str, Any]]] = {}
        for triple in sorted(set(triples.values())):
            per_triple[triple] = list(executor.map(
                lambda header, t=triple: parse_header(header, includes, t, flags), headers))
    merge_target_mangling(results, triples, per_triple)

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
    type_support: dict[tuple[str, str], dict[str, Any]] = {}
    for item in parsed:
        for declaration in item.get("typeSupportDeclarations", []):
            key = (declaration["kind"], declaration["name"])
            prior = type_support.get(key)
            if prior is None or declaration.get("completeDefinition", False):
                type_support[key] = declaration
            elif declaration.get("targetTypes"):
                prior["targetTypes"] = {
                    **prior.get("targetTypes", {}),
                    **declaration["targetTypes"],
                }
    counts: dict[str, int] = {}
    statuses: dict[str, int] = {}
    for declaration in declarations:
        counts[declaration["kind"]] = counts.get(declaration["kind"], 0) + 1
        statuses[declaration["status"]] = statuses.get(declaration["status"], 0) + 1

    public_type_keys = {
        (declaration["kind"], declaration["name"])
        for declaration in declarations
        if declaration["kind"] in TYPE_SUPPORT_KINDS
    }
    compact_type_support = [
        declaration for key, declaration in type_support.items()
        if key not in public_type_keys
    ]
    return {
        "schemaVersion": 1,
        "defoldRevision": defold_revision(),
        # What this inventory was parsed as, declared rather than observed. It
        # used to say `arm64-macos` whatever the parse actually was, which is a
        # host label rather than a property of the API, and it is the reason the
        # nightly derivation was pinned to a macOS runner.
        "parseEnvironment": {
            "triple": declared["triple"],
            "platformNeutralOf": neutral,
            "sysroot": lock_value("DMSDK_PARSE_SYSROOT_INCLUDE"),
            "sysrootSha256": lock_value("DMSDK_PARSE_SYSROOT_SHA256"),
        },
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
        "typeSupportDeclarations": sorted(
            compact_type_support, key=lambda item: (item["name"], item["kind"])
        ),
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
        f"{data['diagnosticHeaderCount']} headers emitted Clang diagnostics. Most are the "
        "pinned WASI libc guard observing that the deliberately platform-neutral parse triple "
        "does not identify itself as a WASI bundle target; a small remainder are header-local "
        "dependency or declaration-order diagnostics. Clang still produced each target-header "
        "AST, and the exact Defold SDK support headers resolved generated DDF and third-party "
        "signature types before policy emission."
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
Parsed as: `{data['parseEnvironment']['triple']}` against the pinned sysroot
`{data['parseEnvironment']['sysroot']}`
(`sha256:{data['parseEnvironment']['sysrootSha256']}`), an assignment that
defines none of {', '.join(f'`{name}`' for name in data['parseEnvironment']['platformNeutralOf'])}
and therefore takes no platform branch. This is not a bundle target and says
nothing about which targets get which declaration; that is
`packages/bindings/generated/defold-dmsdk-target-conditionals.json`.

Clang parsed **{data['parsedHeaderCount']} of {data['headerCount']}** public
`dmsdk/**/*.h(pp)` headers and accounted for **{data['declarationCount']}**
declarations. A declaration is accounted for when it is either a type-only
dependency, a direct scalar ABI candidate, or explicitly blocked on a lowering
policy. Nothing is silently discarded.

The derivation parse resolves those source headers against the checksum-pinned
Defold SDK for the same revision. It retains only the **{len(data.get('typeSupportDeclarations', []))}**
transitively referenced enum, record, alias, and template facts needed to
interpret public signatures. The SDK archive is derivation input, not a
consumer dependency or a published source snapshot.

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


def serialized_outputs() -> tuple[str, str]:
    # Normalize the structured values before JSON escaping. This is the
    # catch-all for future Clang fields: a newly recorded diagnostic or type
    # cannot make policy bytes depend on the checkout host.
    data = normalize_generated_value(inventory())
    inventory_text = strip_checkout_path(json.dumps(data, indent=2, sort_keys=False) + "\n")
    report_text = strip_checkout_path(markdown(data))
    # Fail closed rather than publish a path. A leak that survives the rewrite
    # means the path was spelled some other way - a symlink, a relative prefix -
    # and silently shipping it is what this whole change exists to stop.
    for name, text in (("inventory", inventory_text), ("report", report_text)):
        if contains_checkout_path(text):
            raise SystemExit(f"generated SDK {name} still contains the checkout path {ROOT}")
    return inventory_text, report_text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--sysroot-only",
        action="store_true",
        help="Fetch and verify the pinned parse sysroot, then stop. The bootstrap "
             "front-loads the download with this; the parse does the same work itself.",
    )
    args = parser.parse_args()
    if args.sysroot_only:
        print(f"dmSDK parse sysroot is ready at {relative(parse_sysroot())}")
        return 0
    inventory_text, report_text = serialized_outputs()
    outputs = ((INVENTORY, inventory_text), (REPORT, report_text))
    if args.check:
        stale = [
            str(path.relative_to(ROOT))
            for path, text in outputs
            if not path.exists() or path.read_text(encoding="utf-8") != text
        ]
        if stale:
            print("stale generated SDK inventory: " + ", ".join(stale), file=sys.stderr)
            return 1
        print("dmSDK coverage inventory is current")
        return 0
    for path, text in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    print(
        f"inventoried {json.loads(inventory_text)['declarationCount']} declarations "
        f"from {json.loads(inventory_text)['parsedHeaderCount']} headers"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
