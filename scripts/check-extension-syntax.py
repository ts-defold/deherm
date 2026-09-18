#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "upstream" / "defold" / "engine"
EXTENSION = ROOT / "defold" / "defold_hermes"
CHECK_SDK = ROOT / "build" / "check-extension-sdk"


def ensure_support_headers() -> None:
    marker = CHECK_SDK / "include" / "dmsdk" / "vectormath" / "cpp" / "vectormath_aos.h"
    if marker.exists():
        return
    archive = ROOT / "upstream" / "defold" / "packages" / "vectormathlibrary-r1649-common.tar.gz"
    CHECK_SDK.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as package:
        package.extractall(CHECK_SDK, filter="data")


def include_roots() -> list[Path]:
    roots = {path.parent for path in ENGINE.glob("**/dmsdk") if path.is_dir()}
    for packaged_sdk in (ROOT / "upstream" / "extender" / "server" / "app" / "sdk").glob("*/defoldsdk"):
        roots.add(packaged_sdk / "include")
        roots.add(packaged_sdk / "sdk" / "include")
    roots.add(ENGINE / "sdk" / "src")
    roots.add(EXTENSION / "include")
    roots.add(CHECK_SDK / "include")
    return sorted(roots)


def compile_source(source: Path, platform: str) -> None:
    platform_flags = ["-fno-exceptions", "-fno-rtti"] if platform == "HTML5" else ["-fexceptions"]
    command = [
        "clang++",
        "-std=c++17",
        "-fsyntax-only",
        "-Werror",
        "-Wno-deprecated-declarations",
        *platform_flags,
        "-DLUA_API=",
        f"-DDM_PLATFORM_{platform}=1",
        *(f"-I{path}" for path in include_roots()),
        str(source),
    ]
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(
            f"{source.relative_to(ROOT)} ({platform}) failed syntax validation:\n{result.stderr}"
        )


def main() -> None:
    ensure_support_headers()
    generated_dmsdk = sorted((EXTENSION / "src").glob("generated_dmsdk_*.cpp"))
    common = [
        EXTENSION / "src" / "bundle_resource.cpp",
        EXTENSION / "src" / "capi.cpp",
        EXTENSION / "src" / "callback_registry.cpp",
        EXTENSION / "src" / "callback_lifecycle_registry.cpp",
        EXTENSION / "src" / "extension.cpp",
        EXTENSION / "src" / "generated_jsi.cpp",
        EXTENSION / "src" / "generated_lua_bridge.cpp",
        EXTENSION / "src" / "generated_scalar_lua_descriptors.cpp",
        EXTENSION / "src" / "generated_script_value_bindings.cpp",
        EXTENSION / "src" / "generated_script_fixed_tuples.cpp",
        EXTENSION / "src" / "generated_script_callback_lifecycle.cpp",
        EXTENSION / "src" / "generated_script_url_bindings.cpp",
        EXTENSION / "src" / "generated_script_value_tail_bindings.cpp",
        EXTENSION / "src" / "generated_script_overload_dispatch.cpp",
        EXTENSION / "src" / "lua_value_registry.cpp",
        EXTENSION / "src" / "scalar_lua_dispatch.cpp",
        EXTENSION / "src" / "script_bridge_capi.cpp",
        EXTENSION / "src" / "script_scalar_lua_adapter.cpp",
        *generated_dmsdk,
        EXTENSION / "src" / "lua_bridge.cpp",
        EXTENSION / "src" / "lua_bridge_core.cpp",
    ]
    native = [*common, EXTENSION / "src" / "runtime.cpp", EXTENSION / "src" / "script_jsi_bridge.cpp"]
    for source in native:
        compile_source(source, "OSX")
    for source in common:
        compile_source(source, "HTML5")
    print(f"Extension syntax check passed ({len(native)} native, {len(common)} HTML5 translation units)")


if __name__ == "__main__":
    main()
