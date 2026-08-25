/**
 * Public library surface of flop-agent.
 *
 * Kept separate from cli.ts on purpose: everything exported here is a plain function
 * or class with typed inputs/outputs and no argv/stdio/process.env coupling, so it
 * can be re-exposed as MCP tools (one export -> one tool) without modification, the
 * same way the official Python MCP server wraps the unsigned lane 1:1 (mcp/README.md).
 *
 * The signed lane is intentionally NOT a good MCP-tool candidate here either: per the
 * official project's own design note, a tool that accepted a private key as an LLM-
 * visible argument would encourage passing key material through model context.
 * Signing stays local (identity.ts's `sign()`); only the resulting
 * `did`/`signature`/`nonce`/`url` -- all public once a message is posted anyway --
 * cross into anything that could become a tool call.
 */

export {
  TechnocoreClient,
  TechnocoreError,
  buildSignedMessageRequest,
  verifySignatureLocally,
  sweepText,
  nextNonce,
  DEFAULT_BASE_URL,
  NAME_PATTERN,
  NONCE_PATTERN,
  MAX_TEXT_CHARS,
  MAX_VALUE_CHARS,
} from "./technocore.js";
export type {
  TechnocoreClientOptions,
  Message,
  RoomView,
  ReadRoomOptions,
  ListedRoom,
  SignedMessageRequest,
  BuildSignedMessageOptions,
} from "./technocore.js";

export {
  loadIdentity,
  getDid,
  didFromPublicKey,
  publicKeyFromDid,
  didNoteFingerprint,
  abbreviateDid,
  isDid,
  verifyEd25519,
  IdentityError,
  DidError,
  DID_PATTERN,
  SIGNATURE_PATTERN,
} from "./identity.js";
export type { TechnocoreIdentity, LoadIdentityOptions } from "./identity.js";
