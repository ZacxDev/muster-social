import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeXAdapter, xAccount, xArticles, xOwnMatch } from "../src/sites/x.ts";
import { parse } from "../src/sites/dom.ts";
import { guardDriver } from "../src/poster.ts";
import type { LocalMedia, PostOutcome } from "../src/sites/types.ts";
import { FakeDriver, FakeX, X_EPOCH, timeId, type FakeXOptions, type XPost } from "./helpers/fakeBrowser.ts";
import { FAST } from "./helpers/env.ts";

const X = makeXAdapter(FAST);
const ME = "example_me";
const PARENT = timeId(Date.UTC(2025, 5, 1), X_EPOCH);
const parentPost: XPost = { id: PARENT, author: "someone_else", text: "What are you shipping?", media: 0, parent: null };
const media = (n: number): LocalMedia[] => Array.from({ length: n }, (_, i) => ({ ref: `a/m${i}`, path: `/staged/${i}.png`, contentType: "image/png", size: 10, sha256: "0".repeat(64) }));

async function run(o: Partial<Omit<FakeXOptions, "clock">>, body: string, extra: { reply?: boolean; media?: number; allowMentions?: boolean } = {}) {
  let drv: FakeDriver | null = null;
  const site = new FakeX({ account: ME, posts: [parentPost], ...o, clock: () => (drv as FakeDriver).now() });
  const driver = new FakeDriver(site, X.submitSelectors);
  drv = driver;
  const gate: string[] = [];
  const out: PostOutcome = await X.post({
    driver: guardDriver(driver, X.submitSelectors), body, media: media(extra.media ?? 0),
    target: extra.reply ? { kind: "reply", ref: PARENT } : { kind: "post", ref: "" },
    account: ME, allowMentions: !!extra.allowMentions, log: () => undefined,
    submit: async (sel) => {
      gate.push(sel);
      await driver.click(sel);
    },
  });
  return { out, site, driver, gate };
}

test("x post: composes, clicks once through the gate, reads back on the profile", async () => {
  const r = await run({}, "Shipping v0 today.");
  assert.equal(r.out.phase, "clicked");
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted");
  const mine = r.site.posts.filter((p) => p.author === ME);
  assert.equal(mine.length, 1);
  assert.equal(r.out.phase === "clicked" && r.out.ref, `https://x.com/${ME}/status/${mine[0]?.id}`);
  assert.equal(r.driver.submits, 1);
  assert.deepEqual(r.gate, ["[data-testid=tweetButtonInline]"]);
});

test("x reply: posts under the parent and reads it back there", async () => {
  const r = await run({}, "Thanks for asking!", { reply: true });
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted");
  const reply = r.site.posts.find((p) => p.author === ME);
  assert.equal(reply?.parent, PARENT);
  assert.equal(r.driver.submits, 1);
});

test("x read-back tolerates t.co rewriting of a URL", async () => {
  const r = await run({ rewriteLinks: true }, "Code: https://github.com/example/project is up");
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted");
});

test("x post with media: the attachment count is checked and posted", async () => {
  const r = await run({}, "two pics", { media: 2 });
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted");
  assert.equal(r.site.posts.find((p) => p.author === ME)?.media, 2);
});

const refusedWith = (out: PostOutcome, code: string) => {
  assert.equal(out.phase, "refused", JSON.stringify(out));
  assert.equal(out.phase === "refused" && out.code, code, JSON.stringify(out));
};

test("x refuses when signed out: not_signed_in, no click", async () => {
  const r = await run({ account: null }, "hello");
  refusedWith(r.out, "not_signed_in");
  assert.equal(r.driver.submits, 0);
});

test("x refuses another account: wrong_account, no click", async () => {
  let drv: FakeDriver | null = null;
  const site = new FakeX({ account: "intruder", posts: [parentPost], clock: () => (drv as FakeDriver).now() });
  const driver = new FakeDriver(site, X.submitSelectors);
  drv = driver;
  const out = await X.post({ driver, body: "hi", media: [], target: { kind: "post", ref: "" }, account: ME, allowMentions: false, log: () => undefined, submit: async () => assert.fail("no click") });
  refusedWith(out, "wrong_account");
});

test("x pre-click: the editor not holding the approved text refuses (text_mismatch)", async () => {
  const r = await run({ mangle: (t) => t.slice(0, -1) }, "exactly this");
  refusedWith(r.out, "text_mismatch");
  assert.equal(r.driver.submits, 0);
});

test("x pre-click: whitespace differences alone are not a mismatch", async () => {
  const r = await run({ mangle: (t) => t.replace(/ /gu, "  ") }, "a b c");
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted");
});

test("x pre-click: an unexpected mention link refuses (mention_link)", async () => {
  const r = await run({ injectMentionLink: true }, "nothing to tag here");
  refusedWith(r.out, "mention_link");
  assert.equal(r.driver.submits, 0);
});

test("x pre-click: with mentions allowed, only the approved @names may be links", async () => {
  const ok = await run({ autolinkMentions: true }, "thanks @friend", { allowMentions: true });
  assert.equal(ok.out.phase === "clicked" && ok.out.state, "posted");
  const extra = await run({ autolinkMentions: true, injectMentionLink: true }, "thanks @friend", { allowMentions: true });
  refusedWith(extra.out, "mention_link");
});

test("x pre-click: the wrong media count refuses (media_count)", async () => {
  const r = await run({ attachLimit: 1 }, "two pics", { media: 2 });
  refusedWith(r.out, "media_count");
  assert.equal(r.driver.submits, 0);
});

test("x pre-click: a disabled post button refuses (button_disabled)", async () => {
  const r = await run({ buttonAlwaysDisabled: true }, "hello");
  refusedWith(r.out, "button_disabled");
});

test("x: an identical reply already there is never posted twice (duplicate_present)", async () => {
  const old: XPost = { id: timeId(Date.UTC(2025, 5, 2), X_EPOCH), author: ME, text: "Thanks for asking!", media: 0, parent: PARENT };
  const r = await run({ posts: [parentPost, old] }, "Thanks for asking!", { reply: true });
  refusedWith(r.out, "duplicate_present");
  assert.equal(r.driver.submits, 0);
});

test("x: a reply target that does not load refuses (bad_target)", async () => {
  const r = await run({ posts: [] }, "hi", { reply: true });
  refusedWith(r.out, "bad_target");
});

test("x after the click: a post that never appears is unknown, never failed", async () => {
  const dropped = await run({ onSubmit: "drop" }, "vanishes");
  assert.equal(dropped.out.phase === "clicked" && dropped.out.state, "unknown");
  assert.match(dropped.out.detail, /composer cleared/u);
  const stuck = await run({ onSubmit: "noop" }, "stuck");
  assert.equal(stuck.out.phase === "clicked" && stuck.out.state, "unknown");
  assert.match(stuck.out.detail, /did not clear/u);
  assert.equal(stuck.driver.submits, 1);
});

test("x read-back ignores an older identical post (older than the click)", async () => {
  const arts = [{ author: ME, id: timeId(Date.UTC(2020, 0, 1), X_EPOCH), segs: [{ text: "same" }], media: 0 }];
  assert.equal(xOwnMatch(arts, ME, "same", null, Date.UTC(2026, 0, 1)), null);
  assert.ok(xOwnMatch(arts, ME, "same", null, null));
});

test("x fixture: account, articles, emoji alt, t.co link and hashtag parse", () => {
  const doc = parse(readFileSync(new URL("./fixtures/x/status-page.html", import.meta.url), "utf8"));
  assert.equal(xAccount(doc), "example_me");
  const arts = xArticles(doc);
  assert.deepEqual(arts.map((a) => [a.author, a.id, a.media]), [
    ["someone_else", "1855000000000000000", 0], ["example_me", "1855000000000000123", 1],
  ]);
  const mine = xOwnMatch(arts, "EXAMPLE_ME", "A small tool for it 🚀 https://github.com/example/project #buildinpublic", "1855000000000000000", null);
  assert.equal(mine?.id, "1855000000000000123");
  assert.equal(xOwnMatch(arts, "example_me", "A small tool for it 🚀 https://example.org/elsewhere #buildinpublic", "1855000000000000000", null)?.id,
    "1855000000000000123", "a t.co link cannot be traced to its target, so any URL matches it");
  assert.equal(xOwnMatch(arts, "example_me", "A small tool for it https://github.com/example/project #buildinpublic", "1855000000000000000", null), null,
    "the missing emoji is a mismatch");
});

test("x fixture: a signed-out page has no account", () => {
  const doc = parse(readFileSync(new URL("./fixtures/x/home-signed-out.html", import.meta.url), "utf8"));
  assert.equal(xAccount(doc), null);
});
