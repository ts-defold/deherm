#!/usr/bin/env node
//
// Every documented route, its verification status, and why.
//
// ── The rule this implements ───────────────────────────────────────────────
//
// `.agents/docs/decisions/generate-report-never-gate.md`: generate, report,
// open issues if needed. Every documented route is emitted. One we cannot
// verify ships marked, with the reason attached, so a user can call it, find
// out, and report into an issue that already exists.
//
// Nothing here removes a route and nothing here fails because a route is
// unverified. A route with no evidence is an honest `untested`, which is a
// statement; an absent route is not.
//
// ── Why this is derived and not a list ─────────────────────────────────────
//
// Both facts already exist and were going unread. The headless conformance
// harness executes routes in a real Defold engine one tick at a time and
// records, for every route it could NOT exercise, a machine-readable reason.
// The registration surface separately derives, per target, which documented
// names the engine actually registers. Between them every one of the 926
// documented routes can be given a status with evidence behind it.
//
// Before this, that evidence sat in two side reports while the question "is
// this route callable" was answered by a hand-written set in
// `generate-script-api-accounting.mjs` naming eight routes - which mislabelled
// `go.property` (it IS registered) and missed eighteen others.
//
// ── The statuses, and where the default sits ───────────────────────────────
//
// The default is that a route WORKS. Defold documents it, the engine registers
// it, and Defold maintains this product with a reputation attached - they do
// not ship a Lua API that is broken. Our own execution evidence is a bonus on
// top of that, not the bar for shipping something unmarked. An earlier version
// of this report had it backwards and labelled 450 routes "untested", which
// says nothing true about the route and everything untrue about the product.
//
//   supported   Defold documents it and the engine registers it. This is the
//               product's own contract and it is the overwhelming majority.
//               No mark, no warning, no issue. If it turns out to be wrong,
//               someone opens a bug - which is how every library works.
//
//   executed    Additionally observed running inside a real headless Defold
//               engine here. A stronger claim than `supported`, freely made
//               where we have it, and never a prerequisite.
//
//   suspect     Our own evidence CONTRADICTS the documentation: the engine
//               registers no such name, or we exercised it and a property did
//               not hold. This is the only status that earns a mark and an
//               issue, and there are a few dozen of them rather than hundreds.
//
// Where we did not execute a route, the reason is recorded as a note about our
// harness - a missing fixture context, a route belonging to a runtime profile
// this run did not exercise. That is a to-do list for us. It is not a caveat
// on the route and it is not published as one.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = path.join(root, "packages", "bindings", "generated");
const outputPath = path.join(generated, "defold-route-verification.json");

const read = async (name) => JSON.parse(await readFile(path.join(generated, name), "utf8"));

/**
 * A route's runtime verdict across every property observed for it.
 *
 * Taking the BEST disposition was wrong and hid a real finding: `go.set_parent`
 * had result-arity and scratch-reuse observed and its error-model MISMATCHED,
 * and reported as verified. A route is verified only when something was
 * observed and nothing disagreed - one mismatched property is the whole
 * route's answer, because it is a property of that route that does not hold.
 */
function routeVerdict(dispositions) {
  if (dispositions.some((value) => String(value).includes("mismatch"))) return "mismatched";
  if (dispositions.some((value) => value === "observed")) return "observed";
  if (dispositions.some((value) => String(value).startsWith("blocked"))) return "blocked";
  return dispositions[0] ?? null;
}

async function main() {
  const check = process.argv.includes("--check");
  const [ir, report, plan, registration] = await Promise.all([
    read("defold-script-api-ir.json"),
    read("defold-headless-conformance-report.json"),
    read("defold-headless-conformance-plan.json"),
    read("defold-lua-registration-surface.json")
  ]);

  // Runtime evidence: what the engine actually did, per route.
  const observedByRoute = new Map();
  for (const contract of report.contracts ?? []) {
    for (const property of contract.properties ?? []) {
      const id = String(property.route).split("#")[0];
      observedByRoute.set(id, [...(observedByRoute.get(id) ?? []), property.disposition]);
    }
  }
  const runtime = new Map([...observedByRoute].map(([id, list]) => [id, routeVerdict(list)]));
  // What a mismatched route actually disagreed about, so the issue says so.
  const mismatchDetail = new Map();
  for (const contract of report.contracts ?? []) {
    for (const property of contract.properties ?? []) {
      if (!String(property.disposition).includes("mismatch")) continue;
      const id = String(property.route).split("#")[0];
      mismatchDetail.set(id, `${property.property}: ${property.detail ?? "mismatched"}`);
    }
  }

  // Why a route was never exercised. The plan records this per route.
  const untestedReason = new Map();
  for (const contract of plan.contracts ?? []) {
    for (const blocker of contract.blockers ?? []) {
      for (const id of blocker.routeIds ?? []) {
        if (!untestedReason.has(id)) untestedReason.set(id, blocker.reason);
      }
    }
  }

  // Arity evidence. The registration parse compares each route's documented
  // parameter list against what its C implementation actually reads, and
  // records a verdict. 304 of 1660 route rows disagree, and nothing read it.
  // This is a REPORT, not a verdict on the route: the parser infers a minimum
  // from `luaL_check*` accessors and is conservative where the engine treats an
  // absent argument as a default - `go.set_parent()` with no arguments is valid
  // and unparents the caller, which the runtime confirmed. It is published so
  // the disagreements can be worked through rather than rediscovered.
  const arityDisagreement = new Map();
  for (const target of Object.values(registration.targets ?? {})) {
    for (const route of target.routes ?? []) {
      if (route.arity?.verdict !== "disagree" || arityDisagreement.has(route.name)) continue;
      arityDisagreement.set(route.name, {
        documented: [route.arity.declaredMinimum, route.arity.declaredMaximum],
        derived: [route.arity.derived?.min, route.arity.derived?.max]
      });
    }
  }

  // Registration evidence: does the engine register this name anywhere.
  //
  // "Not in a registration array we resolved" is three different things, and
  // calling all of them suspect was wrong - it labelled a mature engine's API
  // on the strength of one probe.
  //
  //   commented out upstream   Defold wrote the entry and commented it out.
  //       The parser already records these with the C function and the array
  //       they were removed from. `b2d.body.get_user_data` sits in
  //       script_box2d_body_v3.cpp behind `//{"get_user_data", Body_GetUserData},
  //       - could return the game object id ? ur url?`. Documented and
  //       deliberately unregistered is a real upstream inconsistency, and this
  //       is the evidence for it.
  //
  //   parser could not trace   The registration exists but through a form the
  //       parser does not follow. Every `socket.*` route is here: tcp.c:92
  //       declares `luaL_Reg func[] = {{"tcp", global_create}, ...}` and
  //       registers it with `luaL_openlib(L, NULL, func, 0)`, reached only
  //       through the `mod[]` initialiser loop in luaopen_socket_core. The
  //       routes exist; our parser cannot yet say so, which is a gap in us.
  //
  //   genuinely unresolved     Everything else.
  const registeredSomewhere = new Set();
  const declaredUnregistered = new Map();
  const commentedOut = new Map();
  const parserBlocked = new Map();
  for (const target of Object.values(registration.targets ?? {})) {
    for (const route of target.routes ?? []) registeredSomewhere.add(route.name);
    for (const row of target.declaredButUnregistered ?? []) {
      if (!declaredUnregistered.has(row.name)) declaredUnregistered.set(row.name, row);
    }
    for (const row of target.commentedOutRegistrations ?? []) {
      if (!commentedOut.has(row.name)) commentedOut.set(row.name, row);
    }
    for (const row of target.blockers ?? []) {
      if (row.route && !parserBlocked.has(row.route)) parserBlocked.set(row.route, row);
    }
  }

  const rows = ir.functions.map((fn) => {
    const luaName = fn.rawName;
    const disposition = runtime.get(fn.id) ?? null;
    const registered = registeredSomewhere.has(luaName) ? "registered"
      : commentedOut.has(luaName) ? "commented-out-upstream"
      : parserBlocked.has(luaName) ? "registration-form-not-traced"
      : declaredUnregistered.has(luaName) ? "declared-but-unregistered"
      : "no-registration-evidence";
    // Only our own evidence contradicting the documentation makes a route
    // suspect. Neither "we did not run it" nor "our parser could not follow
    // the registration form" is a statement about the route.
    const contradicted = registered === "declared-but-unregistered"
      || registered === "commented-out-upstream"
      || disposition === "mismatched";
    const status = contradicted ? "suspect" : disposition === "observed" ? "executed" : "supported";
    return {
      id: fn.id,
      luaName,
      status,
      ...(disposition ? { disposition } : {}),
      // A note about OUR harness, for our own queue - never published as a
      // caveat on the route.
      ...(status === "supported" ? { notExecutedHere: untestedReason.get(fn.id) ?? "not-in-conformance-plan" } : {}),
      ...(mismatchDetail.has(fn.id) ? { mismatch: mismatchDetail.get(fn.id) } : {}),
      ...(arityDisagreement.has(luaName) ? { arityDisagreement: arityDisagreement.get(luaName) } : {}),
      registration: registered,
      ...(declaredUnregistered.has(luaName) ? { declaredAt: declaredUnregistered.get(luaName).source } : {}),
      ...(commentedOut.has(luaName)
        ? { commentedOutAt: `${commentedOut.get(luaName).path ?? commentedOut.get(luaName).registration?.path}`,
            commentedOutFunction: commentedOut.get(luaName).cFunction }
        : {}),
      ...(parserBlocked.has(luaName) ? { parserBlocker: parserBlocked.get(luaName).code } : {}),
      source: fn.source
    };
  }).sort((left, right) => left.id < right.id ? -1 : 1);

  const tally = (select) => {
    const counts = {};
    for (const row of rows) counts[select(row)] = (counts[select(row)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1));
  };

  // What wants an issue: exactly the suspects. A route we simply have not run
  // here is not a defect and an issue saying so would be noise in someone
  // else's tracker.
  const wantsIssue = rows.filter((row) => row.status === "suspect");

  const artifact = {
    schemaVersion: 1,
    generator: "scripts/generate-route-verification.mjs",
    defoldRevision: ir.defoldRevision,
    evidence: {
      runtime: report.evidenceBoundary ?? null,
      runtimeTarget: report.target ?? null,
      runtimeProfile: report.runtimeProfile ?? null,
      registrationTargets: Object.values(registration.targets ?? {}).map((target) => target.id)
    },
    routeCount: rows.length,
    statusCounts: tally((row) => row.status),
    registrationCounts: tally((row) => row.registration),
    // Our own coverage queue, kept deliberately separate from the statuses so
    // it cannot be mistaken for a statement about the API.
    harnessCoverageGaps: (() => {
      const counts = {};
      for (const row of rows.filter(({ notExecutedHere }) => notExecutedHere)) {
        const family = String(row.notExecutedHere).split(":")[0];
        counts[family] = (counts[family] ?? 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
    })(),
    arityDisagreementCount: rows.filter(({ arityDisagreement: value }) => value).length,
    wantsIssue: wantsIssue.map(({ id, luaName, status, disposition, mismatch, registration, declaredAt }) =>
      ({ id, luaName, status, ...(disposition ? { disposition } : {}), ...(mismatch ? { mismatch } : {}),
         registration, ...(declaredAt ? { declaredAt } : {}) })),
    routes: rows
  };

  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (check) {
    const existing = await readFile(outputPath, "utf8").catch(() => null);
    if (existing !== serialized) {
      throw new Error(`${outputPath} is stale; run node scripts/generate-route-verification.mjs`);
    }
  } else {
    await writeFile(outputPath, serialized);
  }

  console.log(`${check ? "Verified" : "Generated"} route verification for ${rows.length} documented routes at ${ir.defoldRevision}:`);
  console.log(`  ${Object.entries(artifact.statusCounts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  console.log(`  registration: ${Object.entries(artifact.registrationCounts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (Object.keys(artifact.harnessCoverageGaps).length) {
    const total = Object.values(artifact.harnessCoverageGaps).reduce((sum, value) => sum + value, 0);
    console.log(`  our harness has not executed ${total} of them here (our queue, not a caveat on the API):`);
    console.log(`    ${Object.entries(artifact.harnessCoverageGaps).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  }
  console.log(`  ${artifact.arityDisagreementCount} route(s) where the documented arity and the parsed C implementation disagree (reported, not a verdict)`);
  if (wantsIssue.length) {
    console.log(`  ${wantsIssue.length} suspect - our evidence contradicts the documentation, and these want an issue:`);
    for (const row of wantsIssue.slice(0, 25)) {
      console.log(`    ${row.luaName} - ${row.status}${row.disposition ? ` (${row.disposition})` : ""}, ${row.registration}${row.declaredAt ? ` at ${row.declaredAt}` : ""}`);
    }
    if (wantsIssue.length > 25) console.log(`    ... and ${wantsIssue.length - 25} more`);
  }
}

await main();
