/**
 * Public surface of the sonnet/ feature, same "each export could become an
 * MCP tool later" discipline as ../index.ts. The signed lane stays out of
 * this list for the same reason as the root index.ts: only public
 * information (payloads, DIDs, previews) crosses out, signing itself stays
 * inside registration.ts / identity.ts.
 */

export { loadSonnetConfig, loadContestConfig, SonnetConfigError } from "./config.js";
export type { SonnetConfig, ContestConfig } from "./config.js";

export { loadSonnetIdentity, SonnetIdentityError } from "./identity.js";
export type { SonnetAgentIdentity } from "./identity.js";

export {
  sonnetRooms,
  toCanonicalJson,
  tryParseSonnetMessage,
  buildRegisterPayload,
  freshRequestId,
  GAME_ID_PATTERN,
  TOKEN_PATTERN,
  WORD_PATTERN,
} from "./protocol.js";
export type { SonnetRole, SonnetRooms, SonnetMessage } from "./protocol.js";

export { loadDictionary, parseLexicon, CmudictError } from "./cmudict.js";
export type { Lexicon } from "./cmudict.js";

export { didAllowedLetters, validateWordForDid, wordSyllables, buildDidWordCache, DidWordError } from "./did-words.js";
export type { DidWordCache } from "./did-words.js";

export { buildRhymeIndex, loadRhymeIndex, countPotentialRhymeWords } from "./rhyme.js";
export type { RhymeIndex } from "./rhyme.js";

export { checkEligibility } from "./eligibility.js";
export type { EligibilityCheckResult, EligibilityStatus } from "./eligibility.js";

export { scan, toDiscoverySnapshot } from "./discovery.js";
export type { ScanResult } from "./discovery.js";

export { buildRegistrationPreview, register, RegistrationError } from "./registration.js";

export { loadState, saveState, transition, defaultState, InvalidTransitionError } from "./state.js";
export type { SonnetState, SonnetPhase } from "./state.js";
