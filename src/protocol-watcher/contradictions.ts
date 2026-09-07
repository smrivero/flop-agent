/**
 * Teaser vs. Yellow Paper contradiction check. Deterministic and narrow on
 * purpose: the teaser page discloses its own non-normative figures in its
 * `.draft-banner` (see extract/metadata.ts) -- e.g. "Two figures on this
 * page LEAD the protocol parameters of record and are not yet ratified:
 * ...". Detecting *that disclosure* (a fixed phrase the page itself uses) is
 * reliable; diffing arbitrary marketing prose against Appendix A numbers
 * would not be, so this never attempts the latter. The Yellow Paper is
 * always treated as normative when the teaser's own banner says its numbers
 * aren't ratified yet -- never the other way round.
 */

import type { ProtocolWatcherDb } from "./database.js";
import { getLatestSnapshot, getExtractions } from "./database.js";

export interface TeaserContradictionNote {
  contradicts: boolean;
  teaserBannerText?: string;
  note?: string;
}

const DISCLOSURE_PHRASES = ["not yet ratified", "leads the protocol parameters", "lead the protocol parameters"];

export function detectTeaserYellowpaperContradiction(db: ProtocolWatcherDb, teaserSourceId = "teaser"): TeaserContradictionNote {
  const latest = getLatestSnapshot(db, teaserSourceId);
  if (!latest) return { contradicts: false };

  const bannerRow = getExtractions(db, latest.id).find((r) => r.category === "metadata" && r.item_key === "draft_banner");
  if (!bannerRow) return { contradicts: false };

  const bannerText = JSON.parse(bannerRow.value_json) as string;
  const lower = bannerText.toLowerCase();
  const contradicts = DISCLOSURE_PHRASES.some((phrase) => lower.includes(phrase));
  if (!contradicts) return { contradicts: false, teaserBannerText: bannerText };

  return {
    contradicts: true,
    teaserBannerText: bannerText,
    note: "The teaser's own banner discloses that some of its figures are not yet ratified against the protocol parameters. The Yellow Paper (Appendix A) is the normative source whenever the two disagree.",
  };
}
