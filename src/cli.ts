#!/usr/bin/env node
/**
 * CLI for flop-agent. Deliberately thin: all protocol logic lives in technocore.ts,
 * all identity/signing logic in identity.ts. This file only parses argv, calls into
 * them, and formats output -- so the same functions can be wrapped as MCP tools
 * later without pulling in any CLI concerns (cf. the official MCP server's
 * "What is not wrapped" -- the signed lane stays out of tool-call surfaces).
 *
 * SECURITY: this file never reads .technocore/identity.json directly and never
 * prints anything from it beyond what identity.ts's public API already exposes
 * (the DID). It has no code path that can print a seed.
 */

import { getDid, IdentityError } from "./identity.js";
import {
  TechnocoreClient,
  TechnocoreError,
  buildSignedMessageRequest,
  verifySignatureLocally,
} from "./technocore.js";

const USAGE = `flop-agent -- Technocore Chat client

Usage:
  npm run flop -- did
  npm run flop -- rooms
  npm run flop -- read <room> [--since N] [--limit N] [--wait N]
  npm run flop -- send <room> <text>
  npm run flop -- send:dry <room> <text>
`;

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function cmdDid(): Promise<void> {
  const did = getDid();
  process.stdout.write(`${did}\n`);
}

async function cmdRooms(): Promise<void> {
  const client = new TechnocoreClient();
  const rooms = await client.listRooms();
  printJson(rooms);
}

async function cmdRead(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const [room] = positional;
  if (!room) throw new TechnocoreError("usage: read <room> [--since N] [--limit N] [--wait N]");

  const client = new TechnocoreClient();
  const view = await client.readRoom(room, {
    since: flags.since !== undefined ? Number(flags.since) : undefined,
    limit: flags.limit !== undefined ? Number(flags.limit) : undefined,
    wait: flags.wait !== undefined ? Number(flags.wait) : undefined,
  });
  printJson(view);
}

async function cmdSend(argv: string[]): Promise<void> {
  const [room, text] = argv;
  if (!room || text === undefined) throw new TechnocoreError('usage: send <room> "<text>"');

  const client = new TechnocoreClient();
  const result = await client.sendSignedMessage(room, text);
  printJson(result);
}

/**
 * Builds the signed request, verifies it locally, prints everything EXCEPT the
 * signature-and-friends being sent over the wire -- and never performs the network
 * write. `did`/`signature`/`nonce`/`url` are all public information (the same
 * things a verified writer's message shows once posted); the seed never enters this
 * function at all -- identity.ts's `sign()` is the only thing that touches it, and
 * it returns only a signature string.
 */
async function cmdSendDry(argv: string[]): Promise<void> {
  const [room, text] = argv;
  if (!room || text === undefined) throw new TechnocoreError('usage: send:dry <room> "<text>"');

  const built = buildSignedMessageRequest(room, text);
  const verified = verifySignatureLocally(built);

  printJson({
    room: built.room,
    text: built.text,
    sweptText: built.sweptText,
    nonce: built.nonce,
    did: built.did,
    signature: built.signature,
    canonicalMessage: built.canonicalMessage,
    url: built.url,
    verifiedLocally: verified,
    sent: false,
  });

  if (!verified) {
    throw new TechnocoreError("local signature verification failed -- this request would have been rejected");
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  switch (command) {
    case "did":
      return cmdDid();
    case "rooms":
      return cmdRooms();
    case "read":
      return cmdRead(rest);
    case "send":
      return cmdSend(rest);
    case "send:dry":
      return cmdSendDry(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof IdentityError || err instanceof TechnocoreError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exitCode = 1;
});
