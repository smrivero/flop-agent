import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, hashCanonicalUrl, extractDomain, UrlCanonicalizeError } from "./canonicalize.js";

test("canonicalize: strips known tracking parameters", () => {
  const url = canonicalizeUrl(
    "https://example.com/article?utm_source=x&utm_medium=y&utm_campaign=z&utm_content=a&utm_term=b&fbclid=1&gclid=2&ref=3&source=4&real=keep",
  );
  assert.equal(url, "https://example.com/article?real=keep");
});

test("canonicalize: two URLs differing only by tracking params are identical", () => {
  const a = canonicalizeUrl("https://example.com/post?utm_source=twitter");
  const b = canonicalizeUrl("https://example.com/post?utm_source=newsletter");
  assert.equal(a, b);
});

test("canonicalize: trailing slash is normalized, root path is untouched", () => {
  assert.equal(canonicalizeUrl("https://example.com/post/"), "https://example.com/post");
  assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
});

test("canonicalize: hostname is lowercased, path case is preserved", () => {
  assert.equal(canonicalizeUrl("https://EXAMPLE.com/Path"), "https://example.com/Path");
});

test("canonicalize: fragment is dropped", () => {
  assert.equal(canonicalizeUrl("https://example.com/post#section-2"), "https://example.com/post");
});

test("canonicalize: default ports are stripped", () => {
  assert.equal(canonicalizeUrl("https://example.com:443/post"), "https://example.com/post");
  assert.equal(canonicalizeUrl("http://example.com:80/post"), "http://example.com/post");
});

test("canonicalize: non-default ports are preserved", () => {
  assert.equal(canonicalizeUrl("https://example.com:8443/post"), "https://example.com:8443/post");
});

test("canonicalize: remaining query params are sorted for determinism", () => {
  const a = canonicalizeUrl("https://example.com/post?b=2&a=1");
  const b = canonicalizeUrl("https://example.com/post?a=1&b=2");
  assert.equal(a, b);
});

test("canonicalize: rejects malformed or non-http(s) URLs", () => {
  assert.throws(() => canonicalizeUrl("not a url"), UrlCanonicalizeError);
  assert.throws(() => canonicalizeUrl("ftp://example.com/file"), UrlCanonicalizeError);
});

test("hashCanonicalUrl: deterministic and sensitive to the exact string", () => {
  const url = canonicalizeUrl("https://example.com/post");
  assert.equal(hashCanonicalUrl(url), hashCanonicalUrl(url));
  assert.notEqual(hashCanonicalUrl(url), hashCanonicalUrl(url + "x"));
  assert.match(hashCanonicalUrl(url), /^[0-9a-f]{64}$/);
});

test("extractDomain: returns the hostname of a canonical URL", () => {
  assert.equal(extractDomain(canonicalizeUrl("https://Example.com/post")), "example.com");
});
