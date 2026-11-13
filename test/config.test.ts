import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";

const base = { server_url: "https://muster.example.com", sites: { x: { account: "@example_me" } } };

test("a minimal config takes the defaults", () => {
  const c = parseConfig(base);
  assert.equal(c.server_url, "https://muster.example.com");
  assert.equal(c.sites.x?.account, "example_me", "a leading @ is dropped");
  assert.equal(c.sites.x?.min_gap_seconds, 900);
  assert.equal(c.sites.x?.allow_mentions, false);
  assert.equal(c.browser.mode, "persistent");
  assert.equal(c.claim_wait_seconds, 25);
});

test("unknown keys are refused at every level", () => {
  assert.throws(() => parseConfig({ ...base, sever_url: "x" }), /unknown key sever_url/u);
  assert.throws(() => parseConfig({ ...base, browser: { mdoe: "cdp" } }), /unknown key browser\.mdoe/u);
  assert.throws(() => parseConfig({ ...base, sites: { x: { account: "a", allow_mention: true } } }), /unknown key sites\.x\.allow_mention/u);
  assert.throws(() => parseConfig({ ...base, sites: { reddit: { account: "a" } } }), /unknown site/u);
});

test("an enabled site needs its account", () => {
  assert.throws(() => parseConfig({ ...base, sites: { linkedin: {} } }), /account is required/u);
  assert.equal(parseConfig({ ...base, sites: { linkedin: { enabled: false } } }).sites.linkedin?.enabled, false);
});

test("server_url must be https (or loopback); cdp endpoint must be loopback", () => {
  assert.throws(() => parseConfig({ ...base, server_url: "http://muster.example.com" }), /https/u);
  assert.equal(parseConfig({ ...base, server_url: "http://muster.example.com", allow_insecure_http: true }).server_url, "http://muster.example.com");
  assert.throws(() => parseConfig({ ...base, browser: { mode: "cdp", cdp_endpoint: "http://192.0.2.1:9222" } }), /loopback/u);
  assert.equal(parseConfig({ ...base, browser: { mode: "cdp", cdp_endpoint: "http://127.0.0.1:9222" } }).browser.mode, "cdp");
  assert.throws(() => parseConfig({ ...base, browser: { mode: "cdp" } }), /cdp_endpoint is required/u);
});

test("numbers are range-checked", () => {
  assert.throws(() => parseConfig({ ...base, claim_wait_seconds: 60 }), /claim_wait_seconds/u);
  assert.throws(() => parseConfig({ ...base, sites: { x: { account: "a", min_gap_seconds: -1 } } }), /min_gap_seconds/u);
});
