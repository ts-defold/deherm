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
// ── The statuses ───────────────────────────────────────────────────────────
//
//   verified    Observed executing inside a real headless Defold engine.
//               Nothing further happens. This is the steady state.
//
//   unverified  Exercised and did not behave: blocked at runtime, or a
//               property mismatched. The route still ships. It carries the
//               disposition and wants an issue.
//
//   untested    No runtime evidence, with the derived reason - a missing
//               fixture context, a route unavailable in the runtime profile
//               that was exercised, an unmodelled parameter shape. Not a
//               judgement about the route, a statement about our harness.
//
// The registration axis is recorded beside it and answers a different
// question - does the engine register this name at all - which is how
// `sys.set_render_enable` is visible as a route that cannot dispatch.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = path.join(root, "packages", "bindings", "generated");
const outputPath = path.join(generated, "defold-route-verification.json");

const read = async (name) => JSON.parse(await readFile(path.join(generated, name), "utf8"));

/** Runtime dispositions the conformance report can record, best first. */
const RANK = { observed: 3, mismatched: 2, blocked: 1 };

function bestDisposition(left, right) {
  return (RANK[right] ?? 0) > (RANK[left] ?? 0) ? right : left;
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
  const runtime = new Map();
  for (const contract of report.contracts ?? []) {
    for (const property of contract.properties ?? []) {
      const id = String(property.route).split("#")[0];
      runtime.set(id, bestDisposition(runtime.get(id) ?? "", property.disposition));
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

  // Registration evidence: does the engine register this name anywhere.
  const registeredSomewhere = new Set();
  const declaredUnregistered = new Map();
  for (const target of Object.values(registration.targets ?? {})) {
    for (const route of target.routes ?? []) registeredSomewhere.add(route.name);
    for (const row of target.declaredButUnregistered ?? []) {
      if (!declaredUnregistered.has(row.name)) declaredUnregistered.set(row.name, row);
    }
  }

  const rows = ir.functions.map((fn) => {
    const luaName = fn.rawName;
    const disposition = runtime.get(fn.id) ?? null;
    const status = disposition === "observed" ? "verified"
      : disposition ? "unverified"
      : "untested";
    const registered = registeredSomewhere.has(luaName)
      ? "registered"
      : declaredUnregistered.has(luaName) ? "declared-but-unregistered" : "no-registration-evidence";
    return {
      id: fn.id,
      luaName,
      status,
      ...(disposition ? { disposition } : {}),
      ...(status === "untested" ? { reason: untestedReason.get(fn.id) ?? "not-in-conformance-plan" } : {}),
      registration: registered,
      ...(registered === "declared-but-unregistered"
        ? { declaredAt: declaredUnregistered.get(luaName).source }
        : {}),
      source: fn.source
    };
  }).sort((left, right) => left.id < right.id ? -1 : 1);

  const tally = (select) => {
    const counts = {};
    for (const row of rows) counts[select(row)] = (counts[select(row)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1));
  };

  // What wants an issue: a route that ships but whose own evidence says it
  // cannot work. Everything else is either fine or merely untested by us, and
  // an issue for "we have not got round to testing it" is noise.
  const wantsIssue = rows.filter((row) =>
    row.status === "unverified" || row.registration === "declared-but-unregistered");

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
    untestedReasonCounts: (() => {
      const counts = {};
      for (const row of rows.filter(({ status }) => status === "untested")) {
        const family = String(row.reason).split(":")[0];
        counts[family] = (counts[family] ?? 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
    })(),
    wantsIssue: wantsIssue.map(({ id, luaName, status, disposition, registration, declaredAt }) =>
      ({ id, luaName, status, ...(disposition ? { disposition } : {}), registration, ...(declaredAt ? { declaredAt } : {}) })),
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
  if (Object.keys(artifact.untestedReasonCounts).length) {
    console.log(`  untested because: ${Object.entries(artifact.untestedReasonCounts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  }
  if (wantsIssue.length) {
    console.log(`  ${wantsIssue.length} route(s) ship with evidence against them and want an issue:`);
    for (const row of wantsIssue.slice(0, 25)) {
      console.log(`    ${row.luaName} - ${row.status}${row.disposition ? ` (${row.disposition})` : ""}, ${row.registration}${row.declaredAt ? ` at ${row.declaredAt}` : ""}`);
    }
    if (wantsIssue.length > 25) console.log(`    ... and ${wantsIssue.length - 25} more`);
  }
}

await main();
