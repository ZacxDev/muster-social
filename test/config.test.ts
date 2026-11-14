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
  assert.equal(c.browser.headless, false);
  assert.equal(c.claim_wait_seconds, 25);
});

test("unknown keys are refused at every level", () => {
  assert.throws(() => parseConfig({ ...base, sever_url: "x" }), /unknown key sever_url/u);
  assert.throws(() => parseConfig({ ...base, browser: { user_dta_dir: "/x" } }), /unknown key browser\.user_dta_dir/u);
  assert.throws(() => parseConfig({ ...base, sites: { x: { account: "a", allow_mention: true } } }), /unknown key sites\.x\.allow_mention/u);
  assert.throws(() => parseConfig({ ...base, sites: { reddit: { account: "a" } } }), /unknown site/u);
});

test("an enabled site needs its account", () => {
  assert.throws(() => parseConfig({ ...base, sites: { linkedin: {} } }), /account is required/u);
  assert.equal(parseConfig({ ...base, sites: { linkedin: { enabled: false } } }).sites.linkedin?.enabled, false);
});

test("server_url must be https (or loopback); there is no attach-to-browser mode", () => {
  assert.throws(() => parseConfig({ ...base, server_url: "http://muster.example.com" }), /https/u);
  assert.equal(parseConfig({ ...base, server_url: "http://muster.example.com", allow_insecure_http: true }).server_url, "http://muster.example.com");
  assert.throws(() => parseConfig({ ...base, browser: { cdp_endpoint: "http://127.0.0.1:9222" } }), /unknown key browser\.cdp_endpoint/u);
  assert.throws(() => parseConfig({ ...base, browser: { mode: "persistent" } }), /unknown key browser\.mode/u);
});

test("numbers are range-checked", () => {
  assert.throws(() => parseConfig({ ...base, claim_wait_seconds: 60 }), /claim_wait_seconds/u);
  assert.throws(() => parseConfig({ ...base, sites: { x: { account: "a", min_gap_seconds: -1 } } }), /min_gap_seconds/u);
});
