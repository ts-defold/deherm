# Runtime smoke example

This is the smallest TypeScript program used to prove the shared déherm build
against dynamic Hermes and the browser-host path. It is an example/build
fixture, not a separately published npm package, so it is intentionally not a
pnpm workspace project.

From the repository root:

```sh
pnpm build:js
pnpm run:native
pnpm run:web
```

`src/generated/` is generator-owned conformance input. Do not edit it by hand.
