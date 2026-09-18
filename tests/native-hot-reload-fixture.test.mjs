import assert from "node:assert/strict";
import test from "node:test";

import {
  createRejectedCandidate,
  createValidCandidate,
  rejectedCandidateMarker
} from "../scripts/lib/native-hot-reload-fixture.mjs";

const source = `
defineDefoldApp(() => ({
  init() {
    console.log(add(20, 22));
  }
}));
`;

test("rejected native reload fixture throws at the start of candidate init", () => {
  const candidate = createRejectedCandidate(source);
  assert.match(candidate, new RegExp(`init\\(\\) \\{\\n        throw new Error\\("${rejectedCandidateMarker}"\\);`));
  assert.ok(candidate.indexOf(rejectedCandidateMarker) < candidate.indexOf("console.log"));
  assert.throws(() => createRejectedCandidate("init() {}\ninit() {}"), /multiple application init hook sites/);
  assert.throws(() => createRejectedCandidate("no hook"), /did not find application init hook/);
});

test("valid native reload fixture changes exactly one generated module call", () => {
  assert.match(createValidCandidate(source), /add\(40, 44\)/);
  assert.throws(() => createValidCandidate("add(20, 22); add(20, 22);"), /multiple expected module expression sites/);
  assert.throws(() => createValidCandidate("no expression"), /did not find expected module expression/);
});
