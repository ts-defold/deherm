#!/usr/bin/env bash

# Shared checksum primitive for bootstrap scripts. Node is already a declared
# déherm toolchain dependency and provides one portable SHA-256 implementation
# on macOS, Linux, and Git Bash without probing host-specific checksum tools.
deherm_require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required to verify downloaded déherm bootstrap artifacts; install Node.js 22 or newer and retry." >&2
    return 127
  fi
}

deherm_sha256_file() {
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}
