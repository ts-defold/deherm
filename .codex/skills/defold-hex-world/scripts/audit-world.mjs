#!/usr/bin/env node
// Read-only structural diagnostics for the authoritative War Battles island.
const fromExample = (path) => new URL(`../../../../examples/war-battles-online/${path}`, import.meta.url);
const [{ ArenaMap }, planModule, cliffModule] = await Promise.all([
  import(fromExample("core/arena.ts")),
  import(fromExample("core/world-plan.ts")),
  import(fromExample("core/hex-cliffs.ts")),
]);
const { DEFAULT_ARENA_SEED } = await import(fromExample("core/playable.ts"));
const { MAP_WIDTH } = await import(fromExample("core/constants.ts"));
const {
  WORLD_HEX_COUNT,
  WORLD_PLAN_RULES_VERSION,
  WORLD_PLAN_VISIBLE_DEPOT_SLOTS,
  WORLD_PROP_BUILDING,
  WORLD_PROP_DEPOT,
  WORLD_PROP_ROCK,
  WORLD_PROP_TREE,
  worldHexQ,
  worldHexR,
  worldHexNeighbor,
} = planModule;
const { deriveTankDepotPresentationSites } = cliffModule;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= process.argv.length) throw new Error(`${name} needs a value`);
  const raw = process.argv[index + 1];
  const value = name === "--seed" && raw === "default" ? DEFAULT_ARENA_SEED : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} needs an integer`);
  return value;
}

if (process.argv.includes("--help")) {
  console.log("Usage: node audit-world.mjs [--seed default|UINT32] [--count 1..1024] [--json]");
  process.exit(0);
}
for (const option of process.argv.slice(2)) {
  if (option.startsWith("--") && option !== "--seed" && option !== "--count" && option !== "--json") {
    throw new Error(`unknown option ${option}`);
  }
}
const firstSeed = argument("--seed", 0);
const count = argument("--count", 64);
if (firstSeed < 0 || firstSeed > 0xffff_ffff || count < 1 || count > 1024 || firstSeed + count - 1 > 0xffff_ffff) {
  throw new RangeError("seed range must fit uint32 and count must be 1..1024");
}

const rows = [];
for (let seed = firstSeed; seed < firstSeed + count; seed += 1) {
  const map = new ArenaMap(seed);
  const plan = map.plan;
  const visibleDepots = deriveTankDepotPresentationSites(map);
  const visible = new Set(visibleDepots);
  for (const slot of WORLD_PLAN_VISIBLE_DEPOT_SLOTS) {
    if (!visible.has(slot)) throw new Error(`seed ${seed}: protected depot ${slot} is obscured`);
    const facade = plan.depotFacadeCells[slot];
    if (facade < 0 || plan.cellLand[facade] === 0 || plan.propSolid[facade] === 0) {
      throw new Error(`seed ${seed}: depot ${slot} has no grounded collider`);
    }
    if (map.solidAt(facade % MAP_WIDTH, Math.floor(facade / MAP_WIDTH)) === false) {
      throw new Error(`seed ${seed}: depot ${slot} is pass-through in the arena`);
    }
  }

  const biomes = { meadow: 0, earth: 0, basalt: 0, ash: 0 };
  const tiers = [0, 0, 0];
  let coast = 0;
  let land = 0;
  for (let index = 0; index < WORLD_HEX_COUNT; index += 1) {
    if (plan.land[index] === 0) continue;
    land += 1;
    const biome = [undefined, "meadow", "earth", "basalt", "ash"][plan.biome[index]];
    if (biome === undefined) throw new Error(`seed ${seed}: unknown biome at ${index}`);
    biomes[biome] += 1;
    if (tiers[plan.elevation[index]] === undefined) throw new Error(`seed ${seed}: invalid elevation at ${index}`);
    tiers[plan.elevation[index]] += 1;
    const q = worldHexQ(index);
    const r = worldHexR(index);
    let expectedEdges = 0;
    for (let side = 0; side < 6; side += 1) {
      const neighbor = worldHexNeighbor(q, r, side);
      if (neighbor < 0 || plan.land[neighbor] === 0) expectedEdges |= 1 << side;
      else if (Math.abs(plan.elevation[index] - plan.elevation[neighbor]) > 1) {
        throw new Error(`seed ${seed}: elevation jump at ${q},${r}`);
      }
    }
    if (plan.coastEdges[index] !== expectedEdges) throw new Error(`seed ${seed}: stale coast mask at ${q},${r}`);
    if (expectedEdges !== 0) coast += 1;
  }
  if (land !== plan.landCount) throw new Error(`seed ${seed}: land count mismatch`);
  if (biomes.basalt < 10 || biomes.ash < 10) {
    throw new Error(`seed ${seed}: volcanic biome erased (basalt=${biomes.basalt}, ash=${biomes.ash})`);
  }
  const props = { tree: 0, rock: 0, building: 0, depot: 0 };
  for (let index = 0; index < plan.propCount; index += 1) {
    const kind = plan.propKinds[index];
    if (kind === WORLD_PROP_TREE) props.tree += 1;
    else if (kind === WORLD_PROP_ROCK) props.rock += 1;
    else if (kind === WORLD_PROP_BUILDING) props.building += 1;
    else if (kind === WORLD_PROP_DEPOT) props.depot += 1;
    else throw new Error(`seed ${seed}: unknown prop kind ${kind}`);
  }
  if (props.depot !== WORLD_PLAN_VISIBLE_DEPOT_SLOTS.length) {
    throw new Error(`seed ${seed}: expected one collidable prop per visible depot`);
  }
  rows.push({
    seed,
    land,
    coast,
    biomes,
    tiers,
    props,
    visibleDepots: visibleDepots.length,
    starts: plan.playerStartCells.length,
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ rulesVersion: WORLD_PLAN_RULES_VERSION, rows }));
} else {
  const span = (key) => `${Math.min(...rows.map((row) => row[key]))}..${Math.max(...rows.map((row) => row[key]))}`;
  console.log(`world-audit: seeds=${firstSeed}..${firstSeed + count - 1} rules=v${WORLD_PLAN_RULES_VERSION}`);
  console.log(
    `land=${span("land")} coast=${span("coast")} visible-depots=${span("visibleDepots")} starts=${span("starts")}`,
  );
  console.log(
    `props=${Math.min(...rows.map((row) => Object.values(row.props).reduce((a, b) => a + b, 0)))}..${Math.max(...rows.map((row) => Object.values(row.props).reduce((a, b) => a + b, 0)))}`,
  );
  for (const biome of Object.keys(rows[0].biomes)) {
    console.log(
      `biome.${biome}=${Math.min(...rows.map((row) => row.biomes[biome]))}..${Math.max(...rows.map((row) => row.biomes[biome]))}`,
    );
  }
  for (let tier = 0; tier < 3; tier += 1) {
    console.log(
      `tier.${tier}=${Math.min(...rows.map((row) => row.tiers[tier]))}..${Math.max(...rows.map((row) => row.tiers[tier]))}`,
    );
  }
  console.log(
    "All sampled coast masks, shallow elevation edges, biome coverage, and four protected depot sprites are valid.",
  );
}
