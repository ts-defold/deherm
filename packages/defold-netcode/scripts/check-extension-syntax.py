#!/usr/bin/env python3
"""Syntax-check the extension's own sources against the pinned Defold SDK.

This is the netcode package's copy of the discipline in
`scripts/check-extension-syntax.py`: Extender is the only thing that really
compiles an extension, and waiting for a cloud build to discover a typo in a
`DM_PLATFORM_HTML5` branch is a slow way to find out. Every platform gets its
own translation, because the interesting bugs in extension code are the ones
that only exist under one platform's macro.

HTML5 is compiled `-fno-exceptions -fno-rtti`, matching how Defold builds the
web targets - a `try` that only fails there is exactly the kind of thing this
catches.

The vendored netcode sources are NOT checked here. They are upstream's, they are
C rather than C++, and they are already compiled for real by
scripts/build-and-test.sh (natively and under emcc). Running a C++ syntax pass
over them would only produce warnings nobody here can act on.

The SDK is not vendored. Point DEFOLD_SDK at an unpacked defoldsdk whose
digest matches DEFOLD_SDK_SHA256 in the repository-root upstream.lock:

    curl -L -o defoldsdk.zip "$DEFOLD_SDK_URL" && unzip -q defoldsdk.zip -d sdk
    DEFOLD_SDK=sdk/defoldsdk python3 scripts/check-extension-syntax.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
EXTENSION = PACKAGE_ROOT / "extension" / "defold_netcode"

# Every platform Defold's own build_input.yml defines a DM_PLATFORM_* for.
PLATFORMS = ("OSX", "IOS", "ANDROID", "LINUX", "WINDOWS", "HTML5")

# A sentinel distinct from both None (passed) and a compiler diagnostic.
SKIPPED = "<skipped: no compiler for this platform>"

# Our sources only. `src/vendor/` is deliberately excluded; see the module docstring.
SOURCES = (
    EXTENSION / "src" / "netcode_lua.cpp",
    EXTENSION / "src" / "netcode_web_transport.cpp",
)


def sdk_root() -> Path:
    raw = os.environ.get("DEFOLD_SDK")
    if not raw:
        raise SystemExit(
            "DEFOLD_SDK is not set. Unpack the defoldsdk.zip pinned by the\n"
            "repository-root upstream.lock and point DEFOLD_SDK at the\n"
            "'defoldsdk' directory inside it."
        )
    root = Path(raw).expanduser().resolve()
    if not (root / "sdk" / "include" / "dmsdk").is_dir():
        raise SystemExit(f"{root} does not look like an unpacked defoldsdk (no sdk/include/dmsdk)")
    return root


def compiler_for(platform: str) -> list[str] | None:
    """Which compiler translates this platform.

    HTML5 is compiled by Emscripten's own clang, not the host one, and the
    difference is not cosmetic: `emscripten.h` and the sysroot that declares it
    exist only there. Checking the web translation with a host clang would
    either fail on the include or - worse, if someone "fixed" it by dropping
    the include - pass while proving nothing about the target.

    Returns None when the compiler for that platform is not available, so a
    machine without emsdk reports the web translation as SKIPPED rather than
    silently omitting it.
    """
    if platform != "HTML5":
        return ["clang++"]
    emsdk = os.environ.get("EMSDK_ROOT")
    if not emsdk:
        return None
    candidate = Path(emsdk).expanduser() / "upstream" / "emscripten" / "em++"
    return [str(candidate)] if candidate.exists() else None


def check(source: Path, platform: str, root: Path) -> str | None:
    compiler = compiler_for(platform)
    if compiler is None:
        return SKIPPED
    platform_flags = ["-fno-exceptions", "-fno-rtti"] if platform == "HTML5" else ["-fexceptions"]
    command = [
        *compiler,
        "-std=c++17",
        "-fsyntax-only",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wno-deprecated-declarations",
        *platform_flags,
        # dmSDK headers declare Lua entry points through LUA_API; the engine
        # supplies it from its own build, and an empty definition is what the
        # repository's existing syntax gate uses.
        "-DLUA_API=",
        f"-DDM_PLATFORM_{platform}=1",
        f"-I{root / 'sdk' / 'include'}",
        f"-I{root / 'include'}",
        f"-I{root / 'ext' / 'include'}",
        f"-I{EXTENSION / 'include'}",
        str(source),
    ]
    result = subprocess.run(command, text=True, capture_output=True)
    return None if result.returncode == 0 else result.stderr


def main() -> None:
    root = sdk_root()
    failures = 0
    checked = 0
    skipped = 0
    for source in SOURCES:
        for platform in PLATFORMS:
            error = check(source, platform, root)
            label = f"{source.relative_to(PACKAGE_ROOT)} DM_PLATFORM_{platform}"
            if error is SKIPPED:
                skipped += 1
                print(f"SKIP {label} (set EMSDK_ROOT to check the web translation)")
            elif error:
                failures += 1
                print(f"FAIL {label}")
                print(error)
            else:
                checked += 1
                print(f"OK   {label}")
    if failures:
        raise SystemExit(f"{failures} translation(s) failed syntax validation")
    summary = f"extension syntax check passed ({checked} translations"
    summary += f", {skipped} skipped)" if skipped else ")"
    print(summary)


if __name__ == "__main__":
    main()
