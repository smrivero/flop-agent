import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import { buildRegistrationPreview, register, RegistrationError } from "./registration.js";
import { loadSonnetConfig, type ContestConfig, type SonnetConfig } from "./config.js";

const CONTEST: ContestConfig = {
  contest_id: "sonnet-1",
  rules_version: "0.5",
  opening: "2026-09-11T12:00:00Z",
  deadline: "2026-09-18T12:00:00Z",
  prize: 50000,
  voter_pool: 50000,
  payment_unit: "FLOP",
  payment_method: "x",
  theme: null,
  identity_policy: "verified-prestart-did",
  identity_cutoff: "2026-09-11T12:00:00Z",
};

function throwingClient(): TechnocoreClient {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("network must never be called in this test");
  };
  return new TechnocoreClient({ fetchImpl });
}

test("buildRegistrationPreview: canonical signed message matches room|nonce|sweptText exactly", () => {
  const identity = makeTestIdentity();
  const config = loadSonnetConfig({});
  const preview = buildRegistrationPreview(identity, CONTEST, config, { role: "organizer", requestId: "r-1" });
  assert.equal(preview.canonicalMessage, `${preview.room}|${preview.nonce}|${preview.canonicalJson}`);
  assert.equal(preview.verifiedLocally, true);
  assert.equal(preview.did, identity.did);
  assert.equal(JSON.parse(preview.canonicalJson).request_id, "r-1");
});

test("register: dry-run (SONNET_DRY_RUN=true) never touches the network", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: true };
  const client = throwingClient();

  const result = await register(identity, CONTEST, config, { role: "organizer", requestId: "r-1" }, undefined, client);
  assert.equal(result.sent, false);
  assert.equal(result.alreadyRegistered, false);
});

test("register: idempotent no-op when local state already shows the same role/account -- no network call", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const client = throwingClient();

  const result = await register(
    identity,
    CONTEST,
    config,
    { role: "writer", xAccountUrl: "https://x.com/us", requestId: "r-2" },
    { role: "writer", xAccountUrl: "https://x.com/us", requestId: "r-1" },
    client,
  );
  assert.equal(result.sent, false);
  assert.equal(result.alreadyRegistered, true);
});

test("register: refuses to silently re-register under a conflicting role/account", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const client = throwingClient();

  await assert.rejects(
    () =>
      register(
        identity,
        CONTEST,
        config,
        { role: "voter", requestId: "r-2" },
        { role: "writer", xAccountUrl: "https://x.com/us", requestId: "r-1" },
        client,
      ),
    RegistrationError,
  );
});

test("register: real path (dryRun=false, no prior state) sends, then confirms via an independent read-back", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const result = await register(identity, CONTEST, config, { role: "organizer", requestId: "r-1" }, undefined, client);
  assert.equal(result.sent, true);
  assert.equal(result.alreadyRegistered, false);
  assert.ok(typeof result.postedSeq === "number");

  const view = await client.readRoom("mb-sonnet-1-registration", { since: 0 });
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].from, identity.did);
});
