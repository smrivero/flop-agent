import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProtocolSources, enabledSources, ProtocolSourcesError } from "./sources.js";

function withTempYaml(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "protocol-sources-"));
  const path = join(dir, "sources.yaml");
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sources: loads the real project config/protocol-sources.yaml", () => {
  const sources = loadProtocolSources("config/protocol-sources.yaml");
  assert.equal(sources.length, 9);
  const ids = sources.map((s) => s.id);
  assert.deepEqual(
    ids,
    ["yellowpaper", "verification", "agent", "validator", "revenue", "teaser", "tclk-readme", "tclk-spec", "tclk-changelog"],
  );
  for (const s of sources) {
    assert.ok(s.url.startsWith("https://"), `${s.id} url should be https`);
    assert.ok(["html-flop", "markdown-tclk"].includes(s.kind));
  }
});

test("sources: rejects duplicate ids", () => {
  withTempYaml(
    `sources:\n  - id: a\n    name: A\n    url: https://a.example\n    kind: html-flop\n  - id: a\n    name: A2\n    url: https://a2.example\n    kind: html-flop\n`,
    (path) => {
      assert.throws(() => loadProtocolSources(path), ProtocolSourcesError);
    },
  );
});

test("sources: rejects an invalid kind", () => {
  withTempYaml(`sources:\n  - id: a\n    name: A\n    url: https://a.example\n    kind: pdf\n`, (path) => {
    assert.throws(() => loadProtocolSources(path), ProtocolSourcesError);
  });
});

test("sources: rejects an invalid URL", () => {
  withTempYaml(`sources:\n  - id: a\n    name: A\n    url: "not a url"\n    kind: html-flop\n`, (path) => {
    assert.throws(() => loadProtocolSources(path), ProtocolSourcesError);
  });
});

test("sources: enabledSources filters out enabled:false", () => {
  withTempYaml(
    `sources:\n  - id: a\n    name: A\n    url: https://a.example\n    kind: html-flop\n    enabled: false\n  - id: b\n    name: B\n    url: https://b.example\n    kind: html-flop\n`,
    (path) => {
      const sources = loadProtocolSources(path);
      const enabled = enabledSources(sources);
      assert.deepEqual(enabled.map((s) => s.id), ["b"]);
    },
  );
});

test("sources: missing file throws ProtocolSourcesError", () => {
  assert.throws(() => loadProtocolSources("/nonexistent/path.yaml"), ProtocolSourcesError);
});
