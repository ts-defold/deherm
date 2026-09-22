# déherm for VS Code

This extension is the thin VS Code client for the editor-neutral language and
debug servers shipped by `@ts-defold/deherm`.

Install `@ts-defold/deherm` in the workspace, run `deherm generate`, and start
the development loop with `deherm dev`. The extension starts the local
`deherm language-server` process for project intelligence and contributes the
`deherm` debug type for attaching to the running Hermes or browser inspector.

The extension never downloads or bundles a compiler or runtime. It uses the
workspace-local `node_modules/@ts-defold/deherm/bin/deherm.mjs` so its protocol
servers always match the project toolchain. The package requires Node.js 22.13
or newer; the extension resolves `node` from `PATH`, with a resource-scoped
`deherm.nodePath` override for GUI environments that do not inherit a shell
toolchain path.
