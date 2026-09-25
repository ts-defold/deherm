#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE = ROOT / "upstream" / "defold" / "engine"
EXTENSION = ROOT / "defold" / "defold_hermes"
WEBTRANSPORT_EXTENSION = ROOT / "extensions" / "defold-webtransport" / "defold_webtransport"
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
    roots.add(WEBTRANSPORT_EXTENSION / "include")
    roots.add(CHECK_SDK / "include")
    return sorted(roots)


def compile_source(source: Path, platform: str, extra_flags: list[str] | None = None) -> None:
    platform_flags = ["-fno-exceptions", "-fno-rtti"] if platform == "HTML5" else ["-fexceptions"]
    runtime_variant = [] if platform == "HTML5" else ["-DDEHERM_HERMES_DEBUGGER=0"]
    if extra_flags and any(flag.startswith("-DDEHERM_HERMES_DEBUGGER=") for flag in extra_flags):
        runtime_variant = []
    command = [
        "clang++",
        "-std=c++17",
        "-fsyntax-only",
        "-Werror",
        "-Wno-deprecated-declarations",
        *platform_flags,
        "-DLUA_API=",
        f"-DDM_PLATFORM_{platform}=1",
        *runtime_variant,
        *(extra_flags or []),
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
    webtransport_only = "--webtransport-only" in sys.argv[1:]
    unknown = [argument for argument in sys.argv[1:] if argument != "--webtransport-only"]
    if unknown:
        raise SystemExit(f"unknown arguments: {', '.join(unknown)}")
    webtransport_source = WEBTRANSPORT_EXTENSION / "src" / "extension.cpp"
    compile_source(webtransport_source, "OSX")
    compile_source(webtransport_source, "HTML5")
    if webtransport_only:
        print("Defold WebTransport extension syntax check passed (native + HTML5)")
        return
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
    native = [
        *common,
        EXTENSION / "src" / "generated_native_module_jsi.cpp",
        EXTENSION / "src" / "generated_native_module_registry.cpp",
        EXTENSION / "src" / "component_hermes_backend.cpp",
        EXTENSION / "src" / "runtime.cpp",
        EXTENSION / "src" / "script_jsi_bridge.cpp",
    ]
    for source in native:
        compile_source(source, "OSX")
    # The package skeleton selects release Hermes. Compile the extension once
    # more with the install-time debug selection so its loopback CDP client is
    # not left outside the native syntax gate.
    compile_source(
        EXTENSION / "src" / "extension.cpp",
        "OSX",
        ["-DDEHERM_HERMES_DEBUGGER=1"],
    )
    for source in common:
        compile_source(source, "HTML5")
    print(f"Extension syntax check passed ({len(native)} native + debug inspector, {len(common)} HTML5, 2 WebTransport translation units)")


if __name__ == "__main__":
    main()
