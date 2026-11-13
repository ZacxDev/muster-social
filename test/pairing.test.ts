import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pair } from "../src/pairing.ts";
import { FakeMuster } from "./helpers/fakeMuster.ts";
import { tmp } from "./helpers/env.ts";

let m: FakeMuster;
let dir: { dir: string; done: () => void };
beforeEach(async () => {
  m = new FakeMuster();
  await m.start();
  dir = tmp("pair-");
});
afterEach(async () => {
  await m.stop();
  dir.done();
});

const opts = (lines: string[]) => ({
  baseUrl: m.url, owner: "owner@example.invalid", name: "muster-social", label: "Social posts",
  deliverTo: "officer:marketing:main", tokenFile: join(dir.dir, "cfg", "token"),
  print: (l: string) => lines.push(l), sleep: async () => undefined, pollMs: 1,
});

test("pairing: prints the code, polls, writes the token 0600, asks for messages + draft_checks", async () => {
  m.pair = { code: "ABCD-EFGH", secret: "poll-secret", requestId: "req1", polls: 0, approveAfter: 3, outcome: "approved", token: "mpl_minted" };
  const lines: string[] = [];
  const r = await pair(opts(lines));
  assert.equal(r.pluginName, "muster-social");
  assert.ok(lines.some((l) => l.includes("ABCD-EFGH")));
  assert.ok(!lines.some((l) => l.includes("mpl_minted")), "the token is never printed");
  const tf = join(dir.dir, "cfg", "token");
  assert.equal(readFileSync(tf, "utf8").trim(), "mpl_minted");
  assert.equal(statSync(tf).mode & 0o777, 0o600);
  assert.deepEqual(m.pair.body, {
    owner: "owner@example.invalid", name: "muster-social", label: "Social posts",
    capabilities: ["messages", "draft_checks"], deliver_to: "officer:marketing:main",
  });
});

test("pairing: denied and expired stop with an error and write nothing", async () => {
  for (const outcome of ["denied", "expired"] as const) {
    m.pair = { code: "ABCD-EFGH", secret: "s", requestId: "r", polls: 0, approveAfter: 1, outcome, token: "" };
    await assert.rejects(pair(opts([])), new RegExp(outcome));
  }
});

test("pairing refuses to overwrite an existing token file", async () => {
  const tf = join(dir.dir, "token");
  writeFileSync(tf, "mpl_old\n", { mode: 0o600 });
  await assert.rejects(pair({ ...opts([]), tokenFile: tf }), /already exists/u);
  assert.equal(readFileSync(tf, "utf8"), "mpl_old\n");
});
