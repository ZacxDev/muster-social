import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MusterClient, MusterError, checkBaseUrl, truncateBytes } from "../src/muster/client.ts";
import { FakeMuster, TOKEN } from "./helpers/fakeMuster.ts";

let m: FakeMuster;
const noSleep = async () => undefined;
const client = (token = TOKEN) => new MusterClient({ baseUrl: m.url, token, sleep: noSleep, timeoutMs: 5000 });

beforeEach(async () => {
  m = new FakeMuster();
  await m.start();
});
afterEach(async () => {
  await m.stop();
});

const outbound = (id: number) => ({
  draft_id: id, kind: "outbound", message_external_id: "", body: "hi", body_sha256: "x", approved_at: "2000-01-01T00:00:00Z",
  venue: "x", target: { kind: "post", ref: "" }, media: [],
});

test("self answers who the token is; a bad token is an auth error", async () => {
  const s = await client().self();
  assert.equal(s.plugin_name, "muster-social");
  assert.deepEqual(s.capabilities, ["messages", "draft_checks"]);
  await assert.rejects(client("mpl_wrong").self(), (e: unknown) => e instanceof MusterError && e.kind === "auth" && e.status === 401);
});

test("claim: 204 is null, 200 is the draft, the bearer token is sent", async () => {
  assert.equal(await client().claim(0), null);
  m.claims.push(outbound(5));
  const c = await client().claim(0);
  assert.equal(c?.draft_id, 5);
  assert.equal(c?.kind, "outbound");
  assert.ok(m.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
});

test("claim is never retried by the client (a lost claim is still a claim)", async () => {
  m.faults.push({ route: "claim", status: 503, times: 1 });
  m.claims.push(outbound(5));
  await assert.rejects(client().claim(0), (e: unknown) => e instanceof MusterError && e.kind === "server");
  assert.equal(m.requests.filter((r) => r.path.endsWith("/claim")).length, 1);
});

test("result: retried through 5xx until recorded once", async () => {
  m.claimed.add(8);
  m.faults.push({ route: "result", status: 503, times: 2 });
  const r = await client().result(8, { ok: true, external_ref: "https://x.com/me/status/1" });
  assert.equal(r.status, "sent");
  assert.equal(m.resultCalls.length, 1);
  assert.equal(m.results.get(8)?.external_ref, "https://x.com/me/status/1");
});

test("result: a lost answer is retried and muster's repeat is harmless", async () => {
  m.claimed.add(8);
  m.faults.push({ route: "result", dropAfterRecord: true, times: 1 });
  const r = await client().result(8, { ok: true, external_ref: "u" });
  assert.equal(r.status, "sent");
  assert.equal(m.resultCalls.length, 2, "recorded, answer lost, sent again");
  assert.equal(m.results.size, 1);
});

test("result: 409 (the other result) and 404 are not retried", async () => {
  m.claimed.add(8);
  await client().result(8, { ok: false, detail: "no" });
  await assert.rejects(client().result(8, { ok: true }), (e: unknown) => e instanceof MusterError && e.kind === "conflict");
  await assert.rejects(client().result(99, { ok: true }), (e: unknown) => e instanceof MusterError && e.kind === "not_found");
  assert.equal(m.resultCalls.length, 2);
});

test("result: retries stop after the configured attempts", async () => {
  m.claimed.add(8);
  m.faults.push({ route: "result", status: 500, times: 100 });
  const c = new MusterClient({ baseUrl: m.url, token: TOKEN, sleep: noSleep, attempts: 3 });
  await assert.rejects(c.result(8, { ok: true }), (e: unknown) => e instanceof MusterError && e.kind === "server");
  assert.equal(m.requests.filter((r) => r.path.endsWith("/result")).length, 3);
});

test("checks + check: list, verdict, refusal needs detail", async () => {
  m.awaiting.push({ draft_id: 11, kind: "outbound", message_external_id: "", body: "b", created_at: "2000-01-01T00:00:00Z", venue: "x", target: { kind: "post", ref: "" }, media: [] });
  const list = await client().checks();
  assert.deepEqual(list.map((a) => a.draft_id), [11]);
  const r = await client().check(11, { sendable: false, detail: "rule length: too long" });
  assert.equal(r.check, "refused");
  assert.deepEqual(m.verdicts.get(11), { sendable: false, detail: "rule length: too long" });
});

test("checks: a token without draft_checks is a capability error", async () => {
  m.capabilities = ["messages"];
  await assert.rejects(client().checks(), (e: unknown) => e instanceof MusterError && e.kind === "capability" && e.status === 403);
});

test("media upload: raw bytes with Content-Type and X-Content-SHA256; repeat answers 200", async () => {
  m.awaiting.push({ draft_id: 12, kind: "outbound", message_external_id: "", body: "b", created_at: "x", venue: "x", target: { kind: "post", ref: "" }, media: [{ ref: "launch/hero", uploaded: false }] });
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const a = await client().uploadMedia(12, "launch/hero", bytes, "image/png", sha);
  assert.equal(a.status, 201);
  assert.equal(a.sha256, sha);
  assert.deepEqual(m.mediaCalls[0], { id: 12, ref: "launch/hero", contentType: "image/png", sha });
  const b = await client().uploadMedia(12, "launch/hero", bytes, "image/png", sha);
  assert.equal(b.status, 200);
  await assert.rejects(client().uploadMedia(12, "launch/hero", bytes, "image/png", "0".repeat(64)),
    (e: unknown) => e instanceof MusterError && e.kind === "bad_request");
});

test("checkBaseUrl: https required except loopback or explicit opt-in", () => {
  assert.equal(checkBaseUrl("https://muster.example.com/"), "https://muster.example.com");
  assert.equal(checkBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(() => checkBaseUrl("http://muster.example.com"), /https/);
  assert.equal(checkBaseUrl("http://muster.example.com", true), "http://muster.example.com");
  assert.throws(() => checkBaseUrl("https://u:p@muster.example.com"), /no user/);
});

test("truncateBytes keeps detail within muster's 4 KiB without splitting a character", () => {
  const s = "é".repeat(5000);
  const t = truncateBytes(s, 4096);
  assert.ok(Buffer.byteLength(t) <= 4096);
  assert.ok(t.endsWith("..."));
  assert.equal(truncateBytes("short", 4096), "short");
});
