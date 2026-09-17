import {
  DefoldModules,
  defineDefoldApp
} from "@defold-hermes/sdk";

const iterations = 1_000_000;

defineDefoldApp((api) => ({
  init() {
    const math = DefoldModules.getEnforcing("ExampleMath");

    let nativeResult = 0;
    for (let index = 0; index < 50_000; index += 1) nativeResult = math.add(nativeResult, 1);

    let start = api.now();
    nativeResult = 0;
    for (let index = 0; index < iterations; index += 1) nativeResult = math.add(nativeResult, 1);
    const nativeMs = api.now() - start;

    const add = (left: number, right: number): number => left + right;
    let jsResult = 0;
    start = api.now();
    for (let index = 0; index < iterations; index += 1) jsResult = add(jsResult, 1);
    const jsMs = api.now() - start;

    api.log("info", `benchmark:iterations:${iterations}`);
    api.log("info", `benchmark:js-ms:${jsMs.toFixed(3)}`);
    api.log("info", `benchmark:jsi-cabi-ms:${nativeMs.toFixed(3)}`);
    api.log("info", `benchmark:jsi-cabi-ns-per-call:${(nativeMs * 1_000_000 / iterations).toFixed(1)}`);
    api.log("info", `benchmark:checksum:${nativeResult + jsResult}`);
  }
}));
