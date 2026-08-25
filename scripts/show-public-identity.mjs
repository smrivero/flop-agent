#!/usr/bin/env node
/**
 * Print the public parts of the local Technocore identity: the DID and the file
 * it lives in. Never reads the seed into anything that gets printed, logged, or
 * returned -- it is parsed only to confirm the file is well-formed.
 *
 * Does not connect to technocore.chat.
 *
 * Run manually:
 *   node scripts/show-public-identity.mjs
 *   node scripts/show-public-identity.mjs --path .technocore/identity.json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/; // src/didkey.py DID_PATTERN

function abbreviate(did) {
  // Matches src/didkey.py `abbreviate()`: first 4 / last 4 chars of the multibase
  // segment, for a display form that doesn't spell out the whole identifier.
  const mb = did.slice("did:key:".length);
  return `${mb.slice(0, 4)}…${mb.slice(-4)}`;
}

function parseArgs(argv) {
  const args = { path: ".technocore/identity.json" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path") args.path = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/show-public-identity.mjs [--path .technocore/identity.json]\n");
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exit(1);
    }
  }
  return args;
}

function main() {
  const { path: relativePath } = parseArgs(process.argv.slice(2));
  const identityPath = resolve(process.cwd(), relativePath);

  if (!existsSync(identityPath)) {
    process.stderr.write(
      `No identity file at ${identityPath}.\n` +
        "Generate one first: node scripts/generate-identity.mjs\n",
    );
    process.exit(1);
  }

  /** @type {{ did?: unknown }} */
  let identity;
  try {
    identity = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch (err) {
    process.stderr.write(`${identityPath} is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }

  const did = identity.did;
  if (typeof did !== "string" || !DID_RE.test(did)) {
    process.stderr.write(`${identityPath} does not contain a valid did:key in its "did" field.\n`);
    process.exit(1);
  }

  // Public information only -- the seed, if present in this file, is never read
  // into a variable here beyond the untouched `identity` object, and is never
  // printed.
  process.stdout.write(`DID: ${did}\n`);
  process.stdout.write(`Public identifier: ${abbreviate(did)}\n`);
  process.stdout.write(`Identity file: ${identityPath}\n`);
}

main();
