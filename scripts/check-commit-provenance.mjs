#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowed = Object.freeze({
  name: "Justin Walsh",
  email: "contact.me@thejustinwalsh.com",
});

const ref = process.argv[2] ?? "HEAD";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedSigners = path.join(repositoryRoot, ".github", "allowed_signers");
const forbiddenAttribution = /^(?:co-authored-by|signed-off-by|authored-by|contributed-by|co-developed-by):/gim;

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function identity(raw, field) {
  const match = raw.match(new RegExp(`^${field} (.+) <([^>]+)> \\d+ [+-]\\d{4}$`, "m"));
  if (!match) return null;
  return { name: match[1], email: match[2] };
}

const commits = git(["rev-list", ref]).trim().split("\n").filter(Boolean);
if (commits.length === 0) throw new Error(`No commits are reachable from ${ref}`);

const failures = [];
for (const commit of commits) {
  const raw = git(["cat-file", "commit", commit]);
  const separator = raw.indexOf("\n\n");
  const headers = separator === -1 ? raw : raw.slice(0, separator);
  const message = separator === -1 ? "" : raw.slice(separator + 2);
  const author = identity(headers, "author");
  const committer = identity(headers, "committer");

  for (const [role, value] of [["author", author], ["committer", committer]]) {
    if (!value || value.name !== allowed.name || value.email !== allowed.email) {
      failures.push(`${commit}: ${role} must be ${allowed.name} <${allowed.email}>`);
    }
  }
  if (!/^gpgsig(?:-sha256)? /m.test(headers)) {
    failures.push(`${commit}: missing Git commit signature`);
  } else {
    try {
      execFileSync("git", ["-c", `gpg.ssh.allowedSignersFile=${allowedSigners}`, "verify-commit", commit], {
        stdio: "ignore",
      });
    } catch {
      failures.push(`${commit}: Git commit signature does not verify against .github/allowed_signers`);
    }
  }
  forbiddenAttribution.lastIndex = 0;
  if (forbiddenAttribution.test(message)) {
    failures.push(`${commit}: secondary authorship/contribution trailers are forbidden`);
  }
}

if (failures.length) {
  throw new Error(`Commit provenance check failed:\n  ${failures.join("\n  ")}`);
}

console.log(
  `Verified ${commits.length} commit(s) reachable from ${ref}: ` +
  `${allowed.name} <${allowed.email}>, signed, with no secondary authorship/contribution trailers.`,
);
