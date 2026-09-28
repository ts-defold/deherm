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

## Debugging and profiling

Start `deherm dev`, then use the generated **déherm: Attach to running game**
configuration. The adapter maps breakpoints, stacks, scopes, evaluation, and
hot-reload generations back to authored TypeScript source maps for native and
HTML5 sessions.

Run **déherm: Capture Hermes CPU Profile** or **déherm: Capture Hermes Heap
Snapshot** from the command palette while a development game is running. The
commands invoke the matching workspace-local CLI, write canonical Chrome
DevTools `.cpuprofile` and `.heapsnapshot` files under `.deherm/profiles/`, and
open the result in VS Code. CPU profiles use VS Code's built-in table viewer;
the extension pack installs Microsoft's flame-chart visualizer for flame and
left-heavy views. Heap snapshots open in Microsoft's bundled table visualizer.
The files remain portable to Chrome DevTools and other tools that read the
standard formats. Release runtimes intentionally omit the debugger and profiler
transport.
