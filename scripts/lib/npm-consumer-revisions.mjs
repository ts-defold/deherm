const DEFOLD_REVISION = /^[a-f0-9]{40}$/u;

export function parseDefoldRevisionArguments(argv) {
  const remaining = [];
  const revisions = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--defold-sdk") {
      remaining.push(argument);
      continue;
    }
    const revision = argv[++index];
    if (!DEFOLD_REVISION.test(revision ?? "")) {
      throw new Error("--defold-sdk requires an exact 40-character Defold revision");
    }
    if (revisions.includes(revision)) throw new Error(`Defold revision ${revision} was requested more than once`);
    revisions.push(revision);
  }
  return { remaining, revisions };
}

export function parseConsumerProofArguments(argv) {
  const parsedRevisions = parseDefoldRevisionArguments(argv);
  const positional = [];
  let packOnly = false;
  let generateOnly = false;
  let prepareOnly = false;
  let candidate;

  for (let index = 0; index < parsedRevisions.remaining.length; index += 1) {
    const argument = parsedRevisions.remaining[index];
    if (argument === "--pack-only") packOnly = true;
    else if (argument === "--generate-only") generateOnly = true;
    else if (argument === "--prepare-only") prepareOnly = true;
    else if (argument === "--candidate") {
      if (candidate !== undefined) throw new Error("--candidate may be specified only once");
      candidate = parsedRevisions.remaining[index + 1];
      if (!candidate || candidate.startsWith("--")) {
        throw new Error("--candidate requires the retained npm tarball path");
      }
      index += 1;
    } else positional.push(argument);
  }

  const mode = consumerProofMode({ generateOnly, prepareOnly });
  if (packOnly && candidate) throw new Error("--pack-only cannot consume an existing candidate");
  if (packOnly && mode !== "bundle") {
    throw new Error("--pack-only cannot run a consumer generation or preparation stage");
  }
  if (positional.length > 1 || positional.some((argument) => argument.startsWith("--"))) {
    throw new Error(
      "Usage: prove-npm-consumer.mjs [--defold-sdk <sha> ...] [--pack-only | --candidate <tarball>] [--generate-only | --prepare-only] [report.json]",
    );
  }

  return {
    revisions: parsedRevisions.revisions,
    packOnly,
    mode,
    candidate: candidate ?? null,
    outputArgument: positional[0],
  };
}

export function consumerRevisions(requested, fallback) {
  const revisions = requested.length ? requested : [fallback];
  if (!revisions.every((revision) => DEFOLD_REVISION.test(revision ?? ""))) {
    throw new Error("At least one exact Defold revision is required for the npm consumer proof");
  }
  return revisions;
}

export function consumerProofMode({ generateOnly, prepareOnly }) {
  if (generateOnly && prepareOnly) throw new Error("--generate-only and --prepare-only are mutually exclusive");
  if (generateOnly) return "generation-only";
  if (prepareOnly) return "prepare-only";
  return "bundle";
}

export function createProjectArguments({ project, revision }) {
  if (!DEFOLD_REVISION.test(revision ?? "")) {
    throw new Error("Packed consumer project creation requires an exact Defold revision");
  }
  return ["create", project, "--name", "npm consumer proof", "--defold-sdk", revision, "--json"];
}
