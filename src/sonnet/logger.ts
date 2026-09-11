/**
 * Grep-friendly `[SONNET][CATEGORY]` logging, one category per concern (see
 * README.md "Sonnet Challenge" for the full list). Never logs private key
 * material, seeds, OpenAI keys, or a raw process.env dump -- only the same
 * public values (DIDs, room names, seq numbers, payloads that are about to be
 * or were just posted publicly) this project already treats as safe to print
 * elsewhere (cf. src/identity.ts SECURITY note).
 */

export type SonnetLogCategory =
  | "PREFLIGHT"
  | "IDENTITY"
  | "ELIGIBILITY"
  | "REGISTER"
  | "DISCOVERY"
  | "TEAM"
  | "ROSTER"
  | "POLL"
  | "STATE"
  | "CANDIDATES"
  | "LLM"
  | "VALIDATE"
  | "PROPOSE"
  | "POST"
  | "RECEIPT"
  | "CONFLICT"
  | "SUBMIT"
  | "CAMPAIGN"
  | "VOTE"
  | "ERROR";

function format(category: SonnetLogCategory, message: string): string {
  return `[SONNET][${category}] ${message}`;
}

export function sonnetLog(category: SonnetLogCategory, message: string): void {
  process.stdout.write(format(category, message) + "\n");
}

export function sonnetError(category: SonnetLogCategory, message: string): void {
  process.stderr.write(format(category, message) + "\n");
}
