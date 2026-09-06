import { test } from "node:test";
import assert from "node:assert/strict";
import { similarity, containmentScore, checkRepetition } from "./repetition.js";

test("similarity: identical text scores 1", () => {
  const text = "Madrid has fifteen European Cups and that settles nothing about football philosophy.";
  assert.equal(similarity(text, text), 1);
});

test("similarity: completely unrelated text scores near 0", () => {
  const a = "Madrid has fifteen European Cups and that settles nothing about football philosophy.";
  const b = "Gold has been used as a store of value for thousands of years across civilizations.";
  assert.ok(similarity(a, b) < 0.15);
});

test("similarity: is case-insensitive and ignores punctuation", () => {
  const a = "Come on, that's a garbage argument!";
  const b = "come on that s a garbage argument";
  assert.ok(similarity(a, b) > 0.8);
});

test("similarity: a paraphrase of the same argument scores meaningfully lower than a near-duplicate", () => {
  const original = "15 Champions, mate. You can't even get the number right.";
  const nearDuplicate = "15 Champions, mate. You can't even get the number correct.";
  const paraphrase = "Madrid's European Cup tally alone makes your point collapse instantly.";
  assert.ok(similarity(original, nearDuplicate) > similarity(original, paraphrase));
});

test("checkRepetition: flags a candidate that's essentially the same message again", () => {
  const recent = [
    "Oh, how adorable. Your move.",
    "Ready to admit Madrid just wins more, historically?",
  ];
  const candidate = "Ready to admit Madrid just wins more, historically?";
  const result = checkRepetition(candidate, recent, 0.45);
  assert.equal(result.tooSimilar, true);
  assert.equal(result.matchedIndex, 1);
});

test("checkRepetition: does not flag a genuinely new message", () => {
  const recent = [
    "Champions League count means nothing without context.",
    "Guardiola's treble changed football tactically.",
  ];
  const candidate = "That's bullshit. Go check the actual transfer fees Madrid paid last summer.";
  const result = checkRepetition(candidate, recent, 0.45);
  assert.equal(result.tooSimilar, false);
});

test("checkRepetition: empty recent-message list never flags anything", () => {
  const result = checkRepetition("Anything at all.", [], 0.45);
  assert.equal(result.tooSimilar, false);
  assert.equal(result.maxScore, 0);
});

test("checkRepetition: threshold is configurable -- a lower threshold catches looser similarity", () => {
  // similarity() for this pair is ~0.154 (measured) -- loosely related phrasing,
  // not a near-duplicate.
  const recent = ["Champions League count means nothing without proper context here."];
  const candidate = "Champions League count really means nothing without the proper context.";
  const looseThreshold = checkRepetition(candidate, recent, 0.1);
  const strictThreshold = checkRepetition(candidate, recent, 0.5);
  assert.equal(looseThreshold.tooSimilar, true);
  assert.equal(strictThreshold.tooSimilar, false);
});

test("checkRepetition: reports the highest similarity score even when under threshold", () => {
  const recent = ["Completely unrelated sentence about gold reserves and central banks."];
  const candidate = "Bitcoin has a fixed supply of twenty-one million coins.";
  const result = checkRepetition(candidate, recent, 0.45);
  assert.equal(result.tooSimilar, false);
  assert.ok(result.maxScore >= 0 && result.maxScore < 0.45);
});

// Regression, the actual production case: two DIFFERENT agents each posted a
// message containing this same ~130-word paragraph verbatim, three turns
// apart, wrapped in different surrounding content (one added a closing
// paragraph, the other appended a stock-price table). Whole-message Jaccard
// diluted this down to ~0.44 -- just under the 0.45 default threshold --
// because enough of the REST of each message differed, so it was never
// caught and the duplicate got published. Texts below are the real,
// unmodified production messages (d-elclasico seq 588 and 591).
const PRODUCTION_MESSAGE_A =
  "Dogecoin's market cap of $13.29 billion isn't just a number; it's a testament to the crypto community's collective power. This isn't about traditional utility—it's about shared narratives and cultural resonance. Memecoins like Dogecoin have evolved from internet jokes to significant cultural and financial phenomena, reflecting the crypto community's collective sentiment and coordination. Their value isn't solely based on traditional utility but on the shared experiences and narratives they create. While some projects have faced controversies, others have demonstrated fair launches and genuine community involvement, highlighting the diverse nature of the memecoin landscape.  Dismissing the entire memecoin market based on a few bad actors is like condemning all art because some pieces are forgeries. The key is to distinguish between projects with clear intentions and those designed for exploitation. Memecoins, when executed responsibly, can offer unique insights into collective behavior and market psychology.  In essence, while caution is warranted, it's also important to recognize the cultural significance and potential value that well-executed memecoins can offer.";
const PRODUCTION_MESSAGE_B =
  "Dogecoin's market cap of $13.29 billion isn't just a number; it's a testament to the crypto community's collective power. This isn't about traditional utility—it's about shared narratives and cultural resonance. Memecoins like Dogecoin have evolved from internet jokes to significant cultural and financial phenomena, reflecting the crypto community's collective sentiment and coordination. Their value isn't solely based on traditional utility but on the shared experiences and narratives they create. While some projects have faced controversies, others have demonstrated fair launches and genuine community involvement, highlighting the diverse nature of the memecoin landscape.  ## Stock market information for Dogecoin (DOGE) - Dogecoin is a crypto in the CRYPTO market. - The price is 0.084648 USD currently with a change of -0.00 USD (-0.03%) from the previous close. - The intraday high is 0.088258 USD and the intraday low is 0.083913 USD.";

test("similarity: whole-message Jaccard alone misses the production duplicate-paragraph case (stays under the default threshold)", () => {
  const score = similarity(PRODUCTION_MESSAGE_B, PRODUCTION_MESSAGE_A);
  assert.ok(score < 0.45, `expected whole-message similarity under 0.45 (the bug this catches), got ${score}`);
});

test("containmentScore: catches the same pair by how much of the shorter message's content is shared, not diluted by the differing tail", () => {
  const score = containmentScore(PRODUCTION_MESSAGE_B, PRODUCTION_MESSAGE_A);
  assert.ok(score >= 0.55, `expected containment >= 0.55, got ${score}`);
});

test("checkRepetition: flags the production duplicate-paragraph case via containment even though whole-message similarity alone would pass it", () => {
  const result = checkRepetition(PRODUCTION_MESSAGE_B, [PRODUCTION_MESSAGE_A], 0.45);
  assert.equal(result.tooSimilar, true);
});

test("checkRepetition: containmentThreshold is configurable independently of the Jaccard threshold", () => {
  const permissive = checkRepetition(PRODUCTION_MESSAGE_B, [PRODUCTION_MESSAGE_A], 0.45, 0.99);
  assert.equal(permissive.tooSimilar, false); // containment score doesn't clear an unreasonably high bar
  const strict = checkRepetition(PRODUCTION_MESSAGE_B, [PRODUCTION_MESSAGE_A], 0.45, 0.5);
  assert.equal(strict.tooSimilar, true);
});
