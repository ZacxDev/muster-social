// The poster end to end: a fake muster, the real journal on disk, real media
// files, the X adapter on the fake X site.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { Journal, phaseOf } from "../src/journal.ts";
import { MusterClient, type Claim } from "../src/muster/client.ts";
import { Poster, guardDriver, UngatedSubmit, type DriverSession } from "../src/poster.ts";
import { makeXAdapter } from "../src/sites/x.ts";
import { sha256Hex } from "../src/media.ts";
import { X_SELECTORS } from "../src/sites/selectors.ts";
import type { SiteConfig } from "../src/config.ts";
import type { PostContext, PostOutcome, SiteAdapter } from "../src/sites/types.ts";
import { FakeMuster, TOKEN } from "./helpers/fakeMuster.ts";
import { FakeDriver, FakeX, type FakeXOptions } from "./helpers/fakeBrowser.ts";
import { FAST, pngBytes, putMedia, site, tmp } from "./helpers/env.ts";

const ME = "example_me";
let m: FakeMuster;
let dir: { dir: string; done: () => void };

beforeEach(async () => {
  m = new FakeMuster();
  await m.start();
  dir = tmp("poster-");
});
afterEach(async () => {
  await m.stop();
  dir.done();
});

interface World {
  poster: Poster;
  journal: Journal;
  site: FakeX;
  drivers: FakeDriver[];
  clock: { t: number };
  logs: string[];
}

function world(o: { site?: Partial<Omit<FakeXOptions, "clock">>; x?: Partial<SiteConfig>; journal?: Journal; fakeX?: FakeX; crash?: Error; adapter?: SiteAdapter } = {}): World {
  const clock = { t: Date.UTC(2026, 0, 2) };
  const fx = o.fakeX ?? new FakeX({ account: ME, ...o.site, clock: () => clock.t });
  const drivers: FakeDriver[] = [];
  const adapter = o.adapter ?? makeXAdapter(FAST);
  const logs: string[] = [];
  const journal = o.journal ?? new Journal(join(dir.dir, "state", "journal.jsonl"));
  const poster = new Poster({
    client: new MusterClient({ baseUrl: m.url, token: TOKEN, sleep: async () => undefined, attempts: 4 }),
    journal,
    adapters: { x: adapter },
    sites: { x: site(ME, o.x) },
    mediaRoot: join(dir.dir, "media"),
    stateDir: join(dir.dir, "state"),
    openDriver: async (): Promise<DriverSession> => {
      const d = new FakeDriver(fx, adapter.submitSelectors, clock.t);
      if (o.crash) d.crashOnSubmit = o.crash;
      // keep the world's clock in step with the driver's virtual time
      const origSleep = d.sleep.bind(d);
      d.sleep = async (ms: number) => {
        await origSleep(ms);
        clock.t = d.t;
      };
      drivers.push(d);
      return { driver: d, close: async () => undefined };
    },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    log: (s) => logs.push(s),
  });
  return { poster, journal, site: fx, drivers, clock, logs };
}

function claim(id: number, body: string, o: Partial<Claim> = {}): Claim {
  const c: Claim = {
    draft_id: id, kind: "outbound", message_external_id: "", body, body_sha256: sha256Hex(body),
    approved_at: "2026-01-01T00:00:00Z", venue: "x", target: { kind: "post", ref: "" }, media: [], ...o,
  };
  m.claimed.add(id);
  return c;
}

const submits = (w: World) => w.drivers.reduce((n, d) => n + d.submits, 0);

test("posted: one click, journal open before click, result ok:true reported once", async () => {
  const w = world();
  const out = await w.poster.handle(claim(1, "hello from v0"));
  assert.equal(out.action, "posted");
  assert.equal(submits(w), 1);
  const r = m.results.get(1);
  assert.equal(r?.ok, true);
  assert.match(r?.external_ref ?? "", /^https:\/\/x\.com\/example_me\/status\/\d+$/u);
  assert.equal(m.resultCalls.length, 1);
  const s = w.journal.get(1);
  assert.ok(s?.open && s.outcome && s.reported);
  assert.ok((s?.open?.at ?? Infinity) <= (s?.outcome?.at ?? -1));
});

test("the body must hash to the approved body_sha256, else nothing is opened", async () => {
  const w = world();
  const out = await w.poster.handle(claim(2, "approved text", { body_sha256: sha256Hex("other text") }));
  assert.deepEqual([out.action, out.action === "refused" && out.code], ["refused", "body_hash"]);
  assert.equal(w.drivers.length, 0, "no browser was opened");
  assert.equal(m.results.get(2)?.ok, false);
});

test("a reply draft (not outbound) is refused", async () => {
  const w = world();
  const out = await w.poster.handle(claim(3, "x", { kind: "reply", message_external_id: "msg-1" }));
  assert.equal(out.action === "refused" && out.code, "not_outbound");
  assert.equal(w.drivers.length, 0);
});

test("the sending rules run again on the claim (a disabled or unknown venue, a mention)", async () => {
  const w = world();
  assert.equal((await w.poster.handle(claim(4, "x", { venue: "reddit" }))).action, "refused");
  const out = await w.poster.handle(claim(5, "hi @stranger"));
  assert.equal(out.action === "refused" && out.code, "rules");
  assert.equal(w.drivers.length, 0);
});

test("media are re-hashed: a changed file posts nothing ('media changed since approval')", async () => {
  const w = world();
  const root = join(dir.dir, "media");
  const p = putMedia(root, "launch/hero", "png", pngBytes(1));
  const approved = sha256Hex(pngBytes(1));
  writeFileSync(p, pngBytes(2)); // edited after approval
  const out = await w.poster.handle(claim(6, "with a picture", { media: [{ ref: "launch/hero", sha256: approved, content_type: "image/png", size: 20 }] }));
  assert.equal(out.action === "refused" && out.code, "media_changed");
  assert.equal(m.results.get(6)?.detail, "not sent: media changed since approval");
  assert.equal(w.drivers.length, 0);
});

test("media that match are staged, attached, and the staging copy is removed", async () => {
  const w = world();
  putMedia(join(dir.dir, "media"), "launch/hero", "png", pngBytes(1));
  const out = await w.poster.handle(claim(7, "with a picture", { media: [{ ref: "launch/hero", sha256: sha256Hex(pngBytes(1)), content_type: "image/png", size: 20 }] }));
  assert.equal(out.action, "posted");
  assert.equal(w.site.posts.at(-1)?.media, 1);
  const staging = join(dir.dir, "state", "staging");
  assert.ok(!existsSync(staging) || readdirSync(staging).length === 0);
});

test("a pre-click refusal reports ok:false and records no click", async () => {
  const w = world({ site: { mangle: (t) => t + "!" } });
  const out = await w.poster.handle(claim(8, "exact"));
  assert.equal(out.action === "refused" && out.code, "text_mismatch");
  assert.equal(submits(w), 0);
  assert.equal(w.journal.everOpened(8), false);
  assert.equal(m.results.get(8)?.ok, false);
});

test("unknown after the click: NOT reported, the site pauses, the next draft there is refused without a click", async () => {
  const w = world({ site: { onSubmit: "drop" } });
  const out = await w.poster.handle(claim(9, "maybe posted"));
  assert.equal(out.action, "unknown");
  assert.equal(m.results.has(9), false, "an unknown outcome is never reported as failed (it may have posted)");
  await w.poster.reconcile();
  assert.equal(m.results.has(9), false, "nor by the reconcile sweep");
  assert.equal(submits(w), 1);
  w.site.o.onSubmit = "post";
  const next = await w.poster.handle(claim(10, "another one"));
  assert.equal(next.action === "refused" && next.code, "venue_paused");
  assert.equal(submits(w), 1, "no second click while the first is unresolved");
  assert.equal(m.results.get(10)?.ok, false);
});

test("the owner resolves an unknown attempt; the result is reported and the site unpauses", async () => {
  const w = world({ site: { onSubmit: "drop" } });
  await w.poster.handle(claim(11, "maybe posted"));
  await w.poster.resolve(11, "posted", "https://x.com/example_me/status/1");
  assert.deepEqual(m.results.get(11), { ok: true, external_ref: "https://x.com/example_me/status/1", detail: "the owner confirmed it was posted" });
  assert.equal(w.journal.unresolved("x").length, 0);
  w.site.o.onSubmit = "post";
  assert.equal((await w.poster.handle(claim(12, "next"))).action, "posted");
});

test("readyToClaim: nothing is claimed while a site has an unresolved attempt, until the owner resolves it", async () => {
  const w = world({ site: { onSubmit: "drop" } });
  assert.deepEqual(w.poster.readyToClaim(), { ready: true, waitMs: 0, reason: "" });
  await w.poster.handle(claim(40, "maybe posted"));
  const held = w.poster.readyToClaim();
  assert.equal(held.ready, false);
  assert.match(held.reason, /unresolved attempt on x \(draft 40\)/u);
  await w.poster.resolve(40, "not_posted");
  assert.equal(w.poster.readyToClaim().ready, true);
});

test("readyToClaim: a hard crash's open record (no outcome) also holds claims after restart", async () => {
  const p = join(dir.dir, "state", "journal.jsonl");
  const j = new Journal(p);
  j.append({ t: "open", draft_id: 41, venue: "x", at: 1 });
  const w = world({ journal: new Journal(p) });
  assert.equal(w.poster.readyToClaim().ready, false);
});

test("resolve --not-posted reports ok:false; resolve refuses a draft with nothing unresolved", async () => {
  const w = world({ site: { onSubmit: "drop" } });
  await w.poster.handle(claim(13, "maybe"));
  await w.poster.resolve(13, "not_posted");
  assert.equal(m.results.get(13)?.ok, false);
  await assert.rejects(w.poster.resolve(13, "posted", "u"), /no unresolved attempt/u);
  await assert.rejects(w.poster.resolve(999, "not_posted"), /no unresolved attempt/u);
});

test("crash between the journal's open record and the click: after restart nothing is clicked or reported", async () => {
  const w1 = world({ crash: new Error("process died") });
  const out = await w1.poster.handle(claim(14, "crashy"));
  // the gate wrote `open`, then the click threw: the outcome is unknown
  assert.equal(out.action, "unknown");
  assert.equal(submits(w1), 0);
  // restart: a fresh journal from disk and a fresh poster
  const j2 = new Journal(join(dir.dir, "state", "journal.jsonl"));
  const w2 = world({ journal: j2 });
  await w2.poster.reconcile();
  assert.equal(m.results.has(14), false);
  assert.equal(phaseOf(j2.get(14) as never), "unknown");
  // even if muster offered the same draft again, it is not attempted
  const again = await w2.poster.handle(claim(14, "crashy"));
  assert.equal(again.action, "already-attempted");
  assert.equal(submits(w2), 0);
  assert.equal(m.results.has(14), false);
});

test("a hard crash with only the open record on disk (no outcome) is also unknown on restart", async () => {
  const p = join(dir.dir, "state", "journal.jsonl");
  const j = new Journal(p);
  j.append({ t: "claimed", draft_id: 15, venue: "x", target_kind: "post", target_ref: "", body_sha256: "h", at: 1 });
  j.append({ t: "open", draft_id: 15, venue: "x", at: 2 });
  const w = world({ journal: new Journal(p) });
  await w.poster.reconcile();
  assert.equal(m.results.has(15), false);
  m.claimed.add(16);
  const out = await w.poster.handle(claim(16, "next on x"));
  assert.equal(out.action === "refused" && out.code, "venue_paused");
  assert.equal(submits(w), 0);
});

test("a restart after a claim but before arming reports ok:false (nothing was clicked)", async () => {
  const p = join(dir.dir, "state", "journal.jsonl");
  const j = new Journal(p);
  j.append({ t: "claimed", draft_id: 17, venue: "x", target_kind: "post", target_ref: "", body_sha256: "h", at: 1 });
  m.claimed.add(17);
  const w = world({ journal: new Journal(p) });
  await w.poster.reconcile();
  assert.equal(m.results.get(17)?.ok, false);
  assert.match(m.results.get(17)?.detail ?? "", /stopped before posting/u);
});

test("result delivery fails, then is retried by reconcile without posting again", async () => {
  const w = world();
  m.faults.push({ route: "result", status: 503, times: 4 });
  const out = await w.poster.handle(claim(18, "posted but unreported"));
  assert.equal(out.action, "posted");
  assert.equal(m.results.has(18), false);
  assert.equal(w.journal.get(18)?.reported, undefined);
  await w.poster.reconcile();
  assert.equal(m.results.get(18)?.ok, true);
  assert.equal(submits(w), 1);
});

test("a lost result answer is re-sent and recorded once; still one click", async () => {
  const w = world();
  m.faults.push({ route: "result", dropAfterRecord: true, times: 1 });
  await w.poster.handle(claim(19, "lossy network"));
  assert.equal(m.results.get(19)?.ok, true);
  assert.equal(submits(w), 1);
});

test("pacing: a second post inside the gap waits in-process; past the in-lease wait it is refused", async () => {
  const w = world({ x: { min_gap_seconds: 30 } });
  await w.poster.handle(claim(20, "first"));
  assert.equal((await w.poster.handle(claim(21, "second"))).action, "posted");
  const gap = (w.journal.get(21)?.open?.at ?? 0) - (w.journal.get(20)?.open?.at ?? 0);
  assert.ok(gap >= 30_000, `opens ${gap}ms apart`);

  const slow = world({ x: { min_gap_seconds: 3600 }, journal: w.journal });
  slow.clock.t = w.clock.t;
  const out = await slow.poster.handle(claim(22, "third"));
  assert.equal(out.action === "refused" && out.code, "paced");
  assert.equal(slow.poster.readyToClaim().ready, false);
});

test("guardDriver refuses a plain click on a submit control (only the gate may click)", async () => {
  const fx = new FakeX({ account: ME, clock: () => 0 });
  const d = new FakeDriver(fx, [X_SELECTORS.submit]);
  const g = guardDriver(d, [X_SELECTORS.submit]);
  await assert.rejects(g.click(X_SELECTORS.submit), UngatedSubmit);
  assert.equal(d.submits, 0);
  await g.click("button.something-else");
  assert.equal(d.clicks.length, 1);
});

// A misbehaving adapter, to prove the gate and the guarded driver hold even
// when site code is wrong.
function rogueWorld(post: (ctx: PostContext) => Promise<PostOutcome>): World {
  return world({ adapter: { ...makeXAdapter(FAST), post } });
}

test("the gate opens once: an adapter calling submit twice gets one click, and the outcome is unknown", async () => {
  const w = rogueWorld(async (ctx) => {
    await ctx.submit(X_SELECTORS.submit);
    await ctx.submit(X_SELECTORS.submit);
    return { phase: "clicked", state: "posted", ref: "https://x.com/example_me/status/1", detail: "" };
  });
  const out = await w.poster.handle(claim(30, "twice?"));
  assert.equal(submits(w), 1);
  assert.equal(out.action, "unknown");
  assert.match(out.action === "unknown" ? out.detail : "", /opens once/u);
  assert.equal(m.results.has(30), false);
});

test("an adapter clicking submit directly (not through the gate) is stopped: no click, not sent", async () => {
  const w = rogueWorld(async (ctx) => {
    await ctx.driver.click(X_SELECTORS.submit);
    return { phase: "clicked", state: "posted", ref: "u", detail: "" };
  });
  const out = await w.poster.handle(claim(31, "sneaky"));
  assert.equal(submits(w), 0);
  assert.equal(out.action === "refused" && out.code, "error");
  assert.equal(w.journal.everOpened(31), false);
});

test("an adapter claiming 'clicked' without using the gate is treated as not sent", async () => {
  const w = rogueWorld(async () => ({ phase: "clicked", state: "posted", ref: "u", detail: "" }));
  const out = await w.poster.handle(claim(32, "liar"));
  assert.equal(out.action === "refused" && out.code, "error");
  assert.equal(m.results.get(32)?.ok, false);
});

test("an adapter that throws after the click is unknown, never refused", async () => {
  const w = rogueWorld(async (ctx) => {
    await ctx.submit(X_SELECTORS.submit);
    throw new Error("page crashed during read-back");
  });
  const out = await w.poster.handle(claim(33, "boom"));
  assert.equal(out.action, "unknown");
  assert.equal(m.results.has(33), false);
});

test("the gate refuses a selector that is not one of the site's submit controls", async () => {
  const w = rogueWorld(async (ctx) => {
    await ctx.submit("button.not-a-submit");
    return { phase: "clicked", state: "posted", ref: "u", detail: "" };
  });
  const out = await w.poster.handle(claim(34, "wrong button"));
  assert.equal(out.action === "refused" && out.code, "error");
  assert.equal(w.journal.everOpened(34), false);
  assert.equal(w.drivers[0]?.clicks.length, 0);
});
