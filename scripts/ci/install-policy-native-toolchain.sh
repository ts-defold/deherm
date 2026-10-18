#!/usr/bin/env bash
set -euo pipefail

# Derivation and engine conformance compile the same generated dmSDK surface.
# Keep their Linux system dependencies and the compile preflight in one place.
if [[ "${1:-}" == --install ]]; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends llvm clang cmake ninja-build lld libgl-dev
elif [[ "${1:-}" != --check ]]; then
  echo 'usage: install-policy-native-toolchain.sh --install|--check' >&2
  exit 2
fi

for executable in llvm-nm llvm-cxxfilt clang clang++ cmake ninja; do
  command -v "$executable" >/dev/null || { echo "missing policy toolchain executable: $executable" >&2; exit 1; }
done

# Generated graphics declarations can include GLX even when the target route
# is only being type-checked. Catch missing libgl-dev before revision work.
printf '#include <GL/glx.h>\nint main() { return 0; }\n' |
  clang++ -x c++ -std=c++17 -fsyntax-only -
echo 'policy native toolchain: ready'
