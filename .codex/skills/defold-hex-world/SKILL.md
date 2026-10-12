---
name: defold-hex-world
description: Design, generate, and verify deterministic isometric hex worlds in this Defold repository, especially War Battles. Use for terrain topology, biome/elevation layers, coastlines, prop placement, spawn clearance, collision/render parity, or seeded world visual QA. Not for standalone sprite generation or atlas cleanup.
---

# Deterministic Defold hex worlds

Make one seed-derived world plan authoritative. Floor art, coast, collision,
scenery, starts, and Defold resources are projections of that plan, not
independent random passes. For the current implementation, start with
`examples/war-battles-online/core/world-plan.ts` and its consumers; use the
project's existing generators rather than copying their algorithms into this
skill.

## Design invariants

- Keep natural land/biome/elevation separate from sparse manufactured surfaces.
  Shape the island at a broad scale, then add local variation; derive coast
  edge masks from actual six-neighbor land adjacency. Do not crop a square
  tilemap and call it an irregular island.
- Give each hex a logical floor anchor. Draw tall cliffs, buildings, trees,
  and tanks relative to their ground-contact point; sort objects by that foot,
  not by the uppermost sprite pixel. Elevation remains shallow and drivable;
  adjacent land tiers cannot jump beyond the movement/rendering contract.
- Reserve tank-clear starts and depot aprons before placing scenery. Accept
  whole prop footprints only on land, away from reserved space and other
  props. Check projected sprite overlap separately from simulation collision.
- Project immutable collision and visible prop ownership from the same plan
  record. Mutable cover is a separate bounded layer; its placement must not
  disconnect the traversable island or create orphaned cover-table entries.
- Keep generation deterministic and versioned. The seed and rules version
  identify layout; generation must not depend on wall-clock time, iteration
  races, remote art requests, or graphics-device state.
- Check that seeded Voronoi sites actually survive classification over many
  seeds. A small edge perturbation may make a narrow biome vanish entirely;
  use bounded, interior site placement and audit nonzero material coverage
  rather than fixing a single attractive default seed.

## Run the workflow

1. Inspect the relevant world-plan rules and the current [research record](../../../.agents/docs/research/war-battles-procedural-hex-world.md). Change the authoritative plan or its projection, not a derived PNG or `.tilemap`.
2. Audit the **shipped default seed** with `node .codex/skills/defold-hex-world/scripts/audit-world.mjs --seed default --count 1`, then sweep representative ranges (for example, `--seed 0 --count 64`; use multiple nonadjacent ranges when changing biome placement). Use `--json` for per-seed data. A sweep excluding the default seed does not validate the map players actually see. Biome/tier counts and prop density diagnose composition; they are not aesthetic scores or a reason to silently swap showcase seeds.
3. Run `node .codex/skills/defold-hex-world/scripts/verify-world.mjs` for read-only owner checks and focused tests. After intentional source changes, use `--write` to regenerate through the owning commands, then rerun the checks. Use `--preview` to create contact images under `build/evidence/`.
4. Inspect the default-seed preview and a real packaged HTML5/native gameplay capture at the intended camera scale. If comparing another seed, run `node examples/war-battles-online/tools/preview-world-plan-art.mjs --seed <uint32>` and label/save the resulting image before running it again; the preview path is reused. Look for broad dead-color regions, natural/built-surface confusion, repeated motifs, clipped/stacked hex edges, seams, alpha bleed, foot sorting, prop/collider mismatch, nearest-neighbor scaling, and 16–32-player driving/readability space. A contact sheet or structural test cannot certify appearance, and a still image cannot certify movement or collision. If native UI access is unavailable, state that limit rather than claiming parity.
5. Update the relevant OKF document with the rules version, seed sample, checks, screenshots, and unresolved visual or playability limits. Run `pnpm check:knowledge`.

When source imagery, Sprite Fusion, atlas extraction, or tileset cleanup is
needed, read `.codex/skills/sprite-fusion-defold-art/SKILL.md` first. This
world skill owns procedural arrangement and verification, not paid image
generation. The seed audit and focused tests cannot establish that the result
looks good; visual judgment remains an explicit acceptance step.
