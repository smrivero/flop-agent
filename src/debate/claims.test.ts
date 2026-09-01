import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaimRecords, CLAIMS_DELIMITER, splitModelOutput } from "./claims.js";

test("splitModelOutput: no delimiter -- the whole text is the message, zero claims", () => {
  const result = splitModelOutput("Just a normal reply, no trailer.");
  assert.equal(result.message, "Just a normal reply, no trailer.");
  assert.deepEqual(result.claims, []);
});

test("splitModelOutput: splits the natural message from a valid trailer", () => {
  const raw = `Checked it. Correct: Barça were first in 2009.\n\n${CLAIMS_DELIMITER}\n[{"claim":"Barcelona won the first Spanish treble in 2009","status":"verified","sources":["https://uefa.com/x"]}]`;
  const result = splitModelOutput(raw);
  assert.equal(result.message, "Checked it. Correct: Barça were first in 2009.");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].claim, "Barcelona won the first Spanish treble in 2009");
  assert.equal(result.claims[0].status, "verified");
  assert.deepEqual(result.claims[0].sources, ["https://uefa.com/x"]);
});

test("splitModelOutput: malformed JSON after the delimiter -- message still recovered, zero claims", () => {
  const raw = `Fine, you're right about that one.\n\n${CLAIMS_DELIMITER}\nnot valid json at all`;
  const result = splitModelOutput(raw);
  assert.equal(result.message, "Fine, you're right about that one.");
  assert.deepEqual(result.claims, []);
});

test("splitModelOutput: an unknown status is dropped, valid entries in the same array are kept", () => {
  const raw = `Message.\n\n${CLAIMS_DELIMITER}\n[{"claim":"A","status":"maybe"},{"claim":"B","status":"disputed"}]`;
  const result = splitModelOutput(raw);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].claim, "B");
});

test("splitModelOutput: an entry missing 'claim' or with an empty claim is dropped", () => {
  const raw = `Message.\n\n${CLAIMS_DELIMITER}\n[{"status":"verified"},{"claim":"  ","status":"verified"},{"claim":"real one","status":"unverified"}]`;
  const result = splitModelOutput(raw);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].claim, "real one");
});

test("splitModelOutput: sources defaults to an empty array when absent or malformed", () => {
  const raw = `Message.\n\n${CLAIMS_DELIMITER}\n[{"claim":"A","status":"unverified"},{"claim":"B","status":"unverified","sources":"not-an-array"}]`;
  const result = splitModelOutput(raw);
  assert.deepEqual(result.claims[0].sources, []);
  assert.deepEqual(result.claims[1].sources, []);
});

test("buildClaimRecords: an 'unverified' claim is attributed to the speaker (introducing something new)", () => {
  const records = buildClaimRecords([{ claim: "Madrid has 15 European Cups", status: "unverified", sources: [] }], "A", "B");
  assert.equal(records[0].author, "A");
  assert.equal(records[0].verifiedBy, undefined);
  assert.equal(records[0].status, "unverified");
});

test("buildClaimRecords: a 'verified'/'disputed'/'corrected' claim is attributed to the OPPONENT, checked by the speaker", () => {
  const records = buildClaimRecords(
    [
      { claim: "A", status: "verified", sources: ["https://uefa.com"] },
      { claim: "B", status: "disputed", sources: [] },
      { claim: "C", status: "corrected", sources: [] },
    ],
    "B",
    "A",
  );
  for (const r of records) {
    assert.equal(r.author, "A"); // opponent of speaker B
    assert.equal(r.verifiedBy, "B"); // the speaker did the checking
  }
  assert.deepEqual(records[0].sources, ["https://uefa.com"]);
});
