import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkedinAccount, linkedinComments, linkedinUpdates, liOwnComment, liOwnUpdate, makeLinkedinAdapter, profileSlug } from "../src/sites/linkedin.ts";
import { parse } from "../src/sites/dom.ts";
import { guardDriver } from "../src/poster.ts";
import { normalizeLines, textMatches } from "../src/text.ts";
import { plainText } from "../src/sites/dom.ts";
import { ForbiddenTarget, type LocalMedia, type PostOutcome } from "../src/sites/types.ts";
import { FakeDriver, FakeLinkedin, timeId, type FakeLinkedinOptions, type LiPost } from "./helpers/fakeBrowser.ts";
import { FAST } from "./helpers/env.ts";

const LI = makeLinkedinAdapter(FAST);
const ME = "example-me";
const OWN = timeId(Date.UTC(2025, 5, 1), 0);
const OTHERS = timeId(Date.UTC(2025, 5, 2), 0);
const posts: LiPost[] = [
  { activity: OWN, author: ME, text: "We shipped v0.", media: 0 },
  { activity: OTHERS, author: "someone-else", text: "Hiring!", media: 0 },
];
const media = (n: number): LocalMedia[] => Array.from({ length: n }, (_, i) => ({ ref: `a/m${i}`, path: `/staged/${i}.png`, contentType: "image/png", size: 10, sha256: "0".repeat(64) }));

async function run(o: Partial<Omit<FakeLinkedinOptions, "clock">>, body: string, extra: { reply?: string; media?: number } = {}) {
  let drv: FakeDriver | null = null;
  const site = new FakeLinkedin({ account: ME, posts, ...o, clock: () => (drv as FakeDriver).now() });
  const driver = new FakeDriver(site, LI.submitSelectors);
  drv = driver;
  const gate: string[] = [];
  const out: PostOutcome = await LI.post({
    driver: guardDriver(driver, LI), body, media: media(extra.media ?? 0),
    target: extra.reply ? { kind: "reply", ref: extra.reply } : { kind: "post", ref: "" },
    account: ME, allowMentions: false, log: () => undefined,
    submit: async (sel) => {
      gate.push(sel);
      await driver.click(sel);
    },
  });
  return { out, site, driver, gate };
}

const refusedWith = (out: PostOutcome, code: string) => {
  assert.equal(out.phase, "refused", JSON.stringify(out));
  assert.equal(out.phase === "refused" && out.code, code, JSON.stringify(out));
};

test("linkedin post: opens the share box, clicks Post once via the gate, reads back on own activity", async () => {
  const r = await run({}, "A new post about v0.");
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted", JSON.stringify(r.out));
  const mine = r.site.posts.filter((p) => p.author === ME && p.text === "A new post about v0.");
  assert.equal(mine.length, 1);
  assert.equal(r.out.phase === "clicked" && r.out.ref, `https://www.linkedin.com/feed/update/urn:li:activity:${mine[0]?.activity}/`);
  assert.deepEqual(r.gate, ["button.share-actions__primary-action"]);
  assert.equal(r.driver.submits, 1);
});

test("linkedin post with media: chooser, confirm step, preview count checked", async () => {
  const r = await run({}, "with pictures", { media: 2 });
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted", JSON.stringify(r.out));
  assert.equal(r.site.posts.at(-1)?.media, 2);
  const mis = await run({ attachLimit: 1 }, "with pictures", { media: 2 });
  refusedWith(mis.out, "media_count");
  assert.equal(mis.driver.submits, 0);
});

test("linkedin read-back tolerates lnkd.in rewriting", async () => {
  const r = await run({ rewriteLinks: true }, "Read it: https://example.com/blog/v0 today");
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted", JSON.stringify(r.out));
});

test("linkedin reply: a comment on the member's own post", async () => {
  const r = await run({}, "More details soon.", { reply: OWN });
  assert.equal(r.out.phase === "clicked" && r.out.state, "posted", JSON.stringify(r.out));
  assert.equal(r.site.comments.length, 1);
  assert.equal(r.site.comments[0]?.post, OWN, "the comment went to the checked post, not the other post's box on the page");
  assert.equal(r.site.comments[0]?.text, "More details soon.");
  assert.deepEqual(r.gate, [`[data-urn="urn:li:activity:${OWN}"] button.comments-comment-box__submit-button`], "the gate gets the box of the checked post");
  assert.match(r.out.phase === "clicked" ? r.out.ref ?? "" : "", /commentUrn=urn%3Ali%3Acomment%3A\(activity%3A\d+%2C\d+\)/u);
});

test("linkedin reply on someone else's post is refused (not_own_post)", async () => {
  const r = await run({}, "Nice!", { reply: OTHERS });
  refusedWith(r.out, "not_own_post");
  assert.equal(r.driver.submits, 0);
});

test("linkedin refuses signed-out, another member, and an unreadable profile", async () => {
  refusedWith((await run({ account: null }, "x")).out, "not_signed_in");
  refusedWith((await run({ account: "someone-else" }, "x")).out, "wrong_account");
  refusedWith((await run({ hideProfileLink: true }, "x")).out, "wrong_account");
});

test("linkedin pre-click: editor text mismatch refuses", async () => {
  const r = await run({ mangle: (t) => t.toUpperCase() }, "lower case only");
  refusedWith(r.out, "text_mismatch");
  assert.equal(r.driver.submits, 0);
});

test("linkedin: an identical own post is never posted twice", async () => {
  refusedWith((await run({}, "We shipped v0.")).out, "duplicate_present");
});

test("linkedin after the click: not found is unknown", async () => {
  const r = await run({ onSubmit: "drop" }, "gone");
  assert.equal(r.out.phase === "clicked" && r.out.state, "unknown");
  assert.equal(r.driver.submits, 1);
});

test("linkedin fixture: signed-in marker, post, comments, lnkd.in text", () => {
  const doc = parse(readFileSync(new URL("./fixtures/linkedin/post-page.html", import.meta.url), "utf8"));
  assert.equal(linkedinAccount(doc).signedIn, true);
  const ups = linkedinUpdates(doc);
  assert.deepEqual(ups.map((u) => [u.activity, u.author]), [["7260000000000000000", "example-me"]]);
  assert.ok(textMatches("We just shipped v0. Details: https://example.com/v0", ups[0]?.segs ?? []));
  const cs = linkedinComments(doc);
  assert.deepEqual(cs.map((c) => [c.id, c.author]), [["7260000000000000999", "someone-else"], ["7260000000000001234", "example-me"]]);
});

test("profileSlug reads /in/<slug> in relative and absolute links, decoded and lower-cased", () => {
  assert.equal(profileSlug("/in/Example-Me/"), "example-me");
  assert.equal(profileSlug("https://www.linkedin.com/in/j%C3%B6rg?x=1"), "jörg");
  assert.equal(profileSlug("https://www.linkedin.com/company/acme"), null);
});

test("linkedin: a media confirm button that is really Post is refused before any click (both shapes)", async () => {
  for (const shape of ["same-class", "labelled-post"] as const) {
    let drv: FakeDriver | null = null;
    const site = new FakeLinkedin({ account: ME, posts, mediaNextIsPost: shape, clock: () => (drv as FakeDriver).now() });
    const driver = new FakeDriver(site, LI.submitSelectors);
    drv = driver;
    let gate = 0;
    await assert.rejects(LI.post({
      driver: guardDriver(driver, LI), body: "with a picture", media: media(1), target: { kind: "post", ref: "" },
      account: ME, allowMentions: false, log: () => undefined, submit: async () => { gate++; },
    }), ForbiddenTarget);
    assert.equal(driver.submits, 0, shape);
    assert.equal(gate, 0, shape);
    assert.equal(site.posts.length, posts.length, `${shape}: nothing was posted`);
  }
});

test("linkedin: an activity page that did not load refuses (page_not_loaded); an empty one with its marker does not", async () => {
  const broken = await run({ brokenActivity: true }, "first post ever");
  refusedWith(broken.out, "page_not_loaded");
  assert.equal(broken.driver.submits, 0);
  const fresh = await run({ posts: [] }, "first post ever");
  assert.equal(fresh.out.phase === "clicked" && fresh.out.state, "posted", JSON.stringify(fresh.out));
});

test("linkedin: comments that load late are still seen by the duplicate check", async () => {
  const old = { post: OWN, id: timeId(Date.UTC(2025, 6, 1), 0), author: ME, text: "More details soon." };
  const r = await run({ comments: [old], commentsAfterRenders: 3 }, "More details soon.", { reply: OWN });
  refusedWith(r.out, "duplicate_present");
  assert.equal(r.driver.submits, 0);
});

test("linkedin pre-click: an editor that merges lines refuses", async () => {
  refusedWith((await run({ mergeLines: true }, "line one\nline two")).out, "text_mismatch");
  const ok = await run({}, "line one\n\nline three");
  assert.equal(ok.out.phase === "clicked" && ok.out.state, "posted");
});

test("linkedin read-back: an older identical own post is not this one (since)", () => {
  const ups = [{ activity: timeId(Date.UTC(2025, 0, 1), 0), author: ME, segs: [{ text: "same" }], media: 0, el: null as never }];
  assert.equal(liOwnUpdate(ups, ME, "same", Date.UTC(2026, 0, 1)), null);
  assert.ok(liOwnUpdate(ups, ME, "same", null));
});

test("linkedin read-back: an identical own comment on ANOTHER post is not this one", () => {
  const cs = [{ post: OTHERS, id: timeId(Date.UTC(2026, 0, 3), 0), author: ME, segs: [{ text: "same" }] }];
  assert.equal(liOwnComment(cs, OWN, ME, "same", null), null);
  assert.ok(liOwnComment(cs, OTHERS, ME, "same", null));
});

test("linkedin fixture: a multi-line Quill editor reads back line by line", () => {
  const doc = parse(readFileSync(new URL("./fixtures/linkedin/editor-multiline.html", import.meta.url), "utf8"));
  const ed = doc.querySelector(".share-creation-state__text-editor .ql-editor");
  assert.ok(ed);
  assert.equal(normalizeLines(plainText(ed)), "Three things:\n1. ship\n\n2. test");
});
