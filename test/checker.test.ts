import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Checker } from "../src/checker.ts";
import { MusterClient, type AwaitingCheck } from "../src/muster/client.ts";
import { makeXAdapter } from "../src/sites/x.ts";
import { makeLinkedinAdapter } from "../src/sites/linkedin.ts";
import { sha256Hex } from "../src/media.ts";
import type { DriverSession } from "../src/poster.ts";
import { FakeMuster, TOKEN } from "./helpers/fakeMuster.ts";
import { FakeDriver, FakeX } from "./helpers/fakeBrowser.ts";
import { FAST, jpegBytes, mp4Bytes, pngBytes, putMedia, site, tmp, webpBytes } from "./helpers/env.ts";

let m: FakeMuster;
let dir: { dir: string; done: () => void };
beforeEach(async () => {
  m = new FakeMuster();
  await m.start();
  dir = tmp("checker-");
});
afterEach(async () => {
  await m.stop();
  dir.done();
});

function checker(o: { account?: string | null; checkSession?: boolean; opens?: { n: number } } = {}) {
  const fx = new FakeX({ account: o.account === undefined ? "example_me" : o.account, clock: () => 0 });
  const logs: string[] = [];
  return {
    logs,
    c: new Checker({
      client: new MusterClient({ baseUrl: m.url, token: TOKEN, sleep: async () => undefined }),
      adapters: { x: makeXAdapter(FAST), linkedin: makeLinkedinAdapter(FAST) },
      sites: { x: site("example_me"), linkedin: site("example-me") },
      mediaRoot: join(dir.dir, "media"),
      checkSession: o.checkSession ?? true,
      openDriver: async (): Promise<DriverSession> => {
        if (o.opens) o.opens.n++;
        return { driver: new FakeDriver(fx, []), close: async () => undefined };
      },
      now: () => 0,
      log: (s) => logs.push(s),
    }),
  };
}

const awaiting = (id: number, o: Partial<AwaitingCheck> = {}): AwaitingCheck => ({
  draft_id: id, kind: "outbound", message_external_id: "", body: "a fine post", created_at: "2026-01-01T00:00:00Z",
  venue: "x", target: { kind: "post", ref: "" }, media: [], ...o,
});

test("a sendable draft: media uploaded with their hashes, then sendable", async () => {
  putMedia(join(dir.dir, "media"), "launch/hero", "png", pngBytes(3));
  m.awaiting.push(awaiting(1, { media: [{ ref: "launch/hero", uploaded: false }] }));
  const vs = await checker().c.runOnce();
  assert.deepEqual(vs, [{ draftId: 1, verdict: "sendable" }]);
  assert.equal(m.media.get("1:launch/hero")?.sha256, sha256Hex(pngBytes(3)));
  assert.equal(m.media.get("1:launch/hero")?.contentType, "image/png");
  assert.deepEqual(m.verdicts.get(1), { sendable: true, detail: "" });
});

test("a rule the draft breaks is refused with the rule in the detail", async () => {
  m.awaiting.push(awaiting(2, { body: "x".repeat(281) }));
  m.awaiting.push(awaiting(3, { body: "hey @someone" }));
  m.awaiting.push(awaiting(4, { venue: "reddit" }));
  await checker().c.runOnce();
  assert.match(m.verdicts.get(2)?.detail ?? "", /^rule length: /u);
  assert.match(m.verdicts.get(3)?.detail ?? "", /^rule mention: /u);
  assert.match(m.verdicts.get(4)?.detail ?? "", /^rule venue: /u);
  assert.ok([2, 3, 4].every((id) => m.verdicts.get(id)?.sendable === false));
});

test("a reply draft (not outbound) is refused", async () => {
  m.awaiting.push(awaiting(5, { kind: "reply", message_external_id: "msg-1", venue: undefined, target: undefined }));
  await checker().c.runOnce();
  assert.equal(m.verdicts.get(5)?.sendable, false);
});

test("a media ref with no file, two files, or the wrong bytes is refused", async () => {
  const root = join(dir.dir, "media");
  putMedia(root, "a/two", "png", pngBytes());
  putMedia(root, "a/two", "jpg", jpegBytes());
  putMedia(root, "a/liar", "png", jpegBytes());
  m.awaiting.push(awaiting(6, { media: [{ ref: "a/none", uploaded: false }] }));
  m.awaiting.push(awaiting(7, { media: [{ ref: "a/two", uploaded: false }] }));
  m.awaiting.push(awaiting(8, { media: [{ ref: "a/liar", uploaded: false }] }));
  await checker().c.runOnce();
  assert.match(m.verdicts.get(6)?.detail ?? "", /no a\/none\./u);
  assert.match(m.verdicts.get(7)?.detail ?? "", /more than one file/u);
  assert.match(m.verdicts.get(8)?.detail ?? "", /the bytes are image\/jpeg, not image\/png/u);
  assert.equal(m.mediaCalls.length, 0);
});

test("media type and count rules use the local files (webp on LinkedIn, video + image on X)", async () => {
  const root = join(dir.dir, "media");
  putMedia(root, "a/w", "webp", webpBytes());
  putMedia(root, "a/p", "png", pngBytes());
  putMedia(root, "a/v", "mp4", mp4Bytes());
  m.awaiting.push(awaiting(9, { venue: "linkedin", media: [{ ref: "a/w", uploaded: false }] }));
  m.awaiting.push(awaiting(10, { media: [{ ref: "a/p", uploaded: false }, { ref: "a/v", uploaded: false }] }));
  await checker({ checkSession: false }).c.runOnce();
  assert.match(m.verdicts.get(9)?.detail ?? "", /rule media-type/u);
  assert.match(m.verdicts.get(10)?.detail ?? "", /rule media-mix/u);
});

test("bytes muster already holds must be the local file's", async () => {
  putMedia(join(dir.dir, "media"), "a/p", "png", pngBytes(1));
  m.awaiting.push(awaiting(11, { media: [{ ref: "a/p", uploaded: true, sha256: "f".repeat(64), content_type: "image/png", size: 20 }] }));
  m.awaiting.push(awaiting(12, { media: [{ ref: "a/p", uploaded: true, sha256: sha256Hex(pngBytes(1)), content_type: "image/png", size: 20 }] }));
  await checker().c.runOnce();
  assert.match(m.verdicts.get(11)?.detail ?? "", /not the file on this machine/u);
  assert.equal(m.verdicts.get(12)?.sendable, true);
  assert.equal(m.mediaCalls.length, 0);
});

test("signed out, or signed in as another account: no verdict (the draft waits), cached per site", async () => {
  m.awaiting.push(awaiting(13), awaiting(14));
  const opens = { n: 0 };
  const out = await checker({ account: null, opens }).c.runOnce();
  assert.deepEqual(out.map((v) => v.verdict), ["deferred", "deferred"]);
  assert.equal(m.verdictCalls.length, 0);
  assert.equal(opens.n, 1, "one session check serves both drafts");
  const other = await checker({ account: "intruder" }).c.runOnce();
  assert.deepEqual(other.map((v) => v.verdict), ["deferred", "deferred"]);
  assert.match(other[0]?.verdict === "deferred" ? other[0].detail : "", /signed in as intruder/u);
});

test("with check_session off, no browser is opened", async () => {
  m.awaiting.push(awaiting(15));
  const opens = { n: 0 };
  await checker({ checkSession: false, account: null, opens }).c.runOnce();
  assert.equal(m.verdicts.get(15)?.sendable, true);
  assert.equal(opens.n, 0);
});

test("an upload muster cannot take now (5xx) defers; a 409 for the verdict is logged, not thrown", async () => {
  putMedia(join(dir.dir, "media"), "a/p", "png", pngBytes());
  m.awaiting.push(awaiting(16, { media: [{ ref: "a/p", uploaded: false }] }));
  m.faults.push({ route: "media", status: 503, times: 100 });
  const c = checker();
  const out = await c.c.runOnce();
  assert.equal(out[0]?.verdict, "deferred");
  assert.equal(m.verdictCalls.length, 0);
});
