/**
 * `sonnet.register.v1` -- dry-run and real registration. Real registration is
 * idempotent (sonnet-game.md: "an identical registration retry is harmless")
 * by checking local state first; the authoritative idempotency guarantee is
 * still the protocol's own `(contest_id, signer, request_id)` retry rule, not
 * anything this module invents.
 *
 * Mirrors the existing `send:dry` / `send` pattern in ../cli.ts: a dry run
 * builds and locally verifies the exact signed request that would be sent,
 * using the same buildSignedMessageRequest/verifySignatureLocally helpers
 * every other feature in this project already uses, and never performs the
 * network call.
 */

import { TechnocoreClient, buildSignedMessageRequest, verifySignatureLocally } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";
import { buildRegisterPayload, freshRequestId, sonnetRooms, toCanonicalJson, type SonnetRole } from "./protocol.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import { sonnetLog } from "./logger.js";
import type { RegistrationState } from "./state.js";

export class RegistrationError extends Error {}

export interface RegisterOptions {
  role: SonnetRole;
  xAccountUrl?: string;
  requestId?: string;
}

export interface RegistrationPreview {
  room: string;
  payload: ReturnType<typeof buildRegisterPayload>;
  canonicalJson: string;
  did: string;
  signature: string;
  nonce: string;
  canonicalMessage: string;
  verifiedLocally: boolean;
  url: string;
}

/** Builds and locally verifies the signed registration request -- never sends
 * it. Used by both `sonnet:register -- --dry-run` and as the first step of
 * the real path (so the real path can log the exact same preview before it
 * publishes anything). */
export function buildRegistrationPreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  options: RegisterOptions,
): RegistrationPreview {
  const rooms = sonnetRooms(contest);
  const requestId = options.requestId ?? freshRequestId("register");
  const payload = buildRegisterPayload({
    role: options.role,
    xAccountUrl: options.xAccountUrl,
    requestId,
    contestId: contest.contest_id,
  });
  const canonicalJson = toCanonicalJson(payload);

  const built = buildSignedMessageRequest(rooms.registration, canonicalJson, {
    identity,
    baseUrl: config.technocoreBaseUrl,
  });
  const verifiedLocally = verifySignatureLocally(built);

  return {
    room: rooms.registration,
    payload,
    canonicalJson,
    did: built.did,
    signature: built.signature,
    nonce: built.nonce,
    canonicalMessage: built.canonicalMessage,
    verifiedLocally,
    url: built.url,
  };
}

export interface RegisterResult {
  preview: RegistrationPreview;
  sent: boolean;
  alreadyRegistered: boolean;
  postedSeq?: number;
}

/**
 * The real path. Refuses to send when `config.dryRun` is true (the safety
 * master switch, SONNET_DRY_RUN, defaults true) -- callers must not bypass
 * this by calling sendSignedMessagePost directly. Idempotent against local
 * state: if `existingRegistration` already has the same role (and, for
 * writers, the same x_account_url), this returns without sending, per
 * sonnet-game.md's own retry-safety guarantee.
 */
export async function register(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  options: RegisterOptions,
  existingRegistration: RegistrationState | undefined,
  client: TechnocoreClient = new TechnocoreClient({ baseUrl: config.technocoreBaseUrl }),
): Promise<RegisterResult> {
  if (existingRegistration) {
    const sameRole = existingRegistration.role === options.role;
    const sameAccount = (existingRegistration.xAccountUrl ?? undefined) === (options.xAccountUrl ?? undefined);
    if (sameRole && sameAccount) {
      sonnetLog("REGISTER", `already registered as ${existingRegistration.role} (request_id=${existingRegistration.requestId}) -- skipping, idempotent no-op`);
      const preview = buildRegistrationPreview(identity, contest, config, {
        role: existingRegistration.role,
        xAccountUrl: existingRegistration.xAccountUrl,
        requestId: existingRegistration.requestId,
      });
      return { preview, sent: false, alreadyRegistered: true };
    }
    throw new RegistrationError(
      `local state already shows a registration as ${existingRegistration.role}` +
        (existingRegistration.xAccountUrl ? ` (${existingRegistration.xAccountUrl})` : "") +
        `, which conflicts with the requested ${options.role}` +
        (options.xAccountUrl ? ` (${options.xAccountUrl})` : "") +
        ". The protocol fixes role/account on first acceptance -- run sonnet:scan to check what the registry actually shows before retrying with a new identity.",
    );
  }

  const preview = buildRegistrationPreview(identity, contest, config, options);
  sonnetLog("REGISTER", `[PREPARE] room=${preview.room} payload=${preview.canonicalJson}`);

  if (config.dryRun) {
    sonnetLog("REGISTER", "[DRY-RUN] SONNET_DRY_RUN is true -- not publishing. Set SONNET_DRY_RUN=false to send for real.");
    return { preview, sent: false, alreadyRegistered: false };
  }

  if (!preview.verifiedLocally) {
    throw new RegistrationError("local signature verification failed -- refusing to send");
  }

  sonnetLog("REGISTER", `[SIGNED] did=${preview.did} nonce=${preview.nonce}`);
  const result = await client.sendSignedMessagePost(preview.room, preview.canonicalJson, { identity, baseUrl: config.technocoreBaseUrl });
  sonnetLog("REGISTER", `[SENT] seq=${result.posted.seq}`);

  // Independent read-back, not just trusting the POST response body -- see
  // SIGNED MESSAGES in the module header. A confirmation failure is logged,
  // never thrown: the write already happened (retrying it would risk a
  // duplicate-looking request), so the caller should re-run sonnet:scan
  // rather than have this throw and look like nothing was sent.
  try {
    const readBack = await client.readRoom(preview.room, { since: Math.max(0, result.posted.seq - 1), limit: 5 });
    const echoed = readBack.messages.find((m) => m.seq === result.posted.seq);
    if (echoed && echoed.from === preview.did && echoed.text === preview.canonicalJson) {
      sonnetLog("REGISTER", `[CONFIRMED] seq=${echoed.seq} from=${echoed.from}`);
    } else {
      sonnetLog("REGISTER", `[CONFIRMED] could not verify seq=${result.posted.seq} on read-back -- run sonnet:scan to check`);
    }
  } catch (err) {
    sonnetLog("REGISTER", `[CONFIRMED] read-back failed (${(err as Error).message}) -- run sonnet:scan to check`);
  }

  return { preview, sent: true, alreadyRegistered: false, postedSeq: result.posted.seq };
}
