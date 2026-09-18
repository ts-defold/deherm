# Runtime smoke example

This is the smallest TypeScript consumer used to prove the shared déherm build
against dynamic Hermes and the browser-host path. It is a private pnpm
workspace package and consumes the public `@ts-defold/deherm` package through
`workspace:*`; it is never published with the package.

From this directory:

```sh
pnpm typecheck
pnpm build
pnpm run:native
pnpm run:web
```

`src/generated/` is generator-owned conformance input. Do not edit it by hand.
