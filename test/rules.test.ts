import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, type DraftForRules, type SiteRuleConfig } from "../src/rules.ts";
import { makeXAdapter } from "../src/sites/x.ts";
import { makeLinkedinAdapter } from "../src/sites/linkedin.ts";

const X = makeXAdapter();
const LI = makeLinkedinAdapter();
const on: SiteRuleConfig = { enabled: true, allowMentions: false };
const draft = (o: Partial<DraftForRules> = {}): DraftForRules => ({
  venue: "x", target: { kind: "post", ref: "" }, body: "hello world", media: [], ...o,
});
const rules = (vs: { rule: string }[]) => vs.map((v) => v.rule).sort();
const img = (ref: string, size = 1000, contentType = "image/png") => ({ ref, contentType, size });

test("a plain X post passes", () => {
  assert.deepEqual(checkDraft(draft(), X, on), []);
});

test("venue: unknown, unconfigured or disabled site is refused", () => {
  assert.deepEqual(rules(checkDraft(draft({ venue: "reddit" }), undefined, undefined)), ["venue"]);
  assert.deepEqual(rules(checkDraft(draft(), X, undefined)), ["venue"]);
  assert.deepEqual(rules(checkDraft(draft(), X, { ...on, enabled: false })), ["venue"]);
});

test("target: X reply needs a status id or status URL; post needs empty ref", () => {
  assert.deepEqual(checkDraft(draft({ target: { kind: "reply", ref: "1234567890" } }), X, on), []);
  assert.deepEqual(checkDraft(draft({ target: { kind: "reply", ref: "https://x.com/someone/status/1234567890" } }), X, on), []);
  assert.deepEqual(rules(checkDraft(draft({ target: { kind: "reply", ref: "https://evil.example/status/1" } }), X, on)), ["target"]);
  assert.deepEqual(rules(checkDraft(draft({ target: { kind: "post", ref: "123" } }), X, on)), ["target"]);
  assert.deepEqual(rules(checkDraft(draft({ target: { kind: "quote", ref: "" } }), X, on)), ["target"]);
});

test("target: LinkedIn reply takes an activity id, urn or post URL", () => {
  const li = (ref: string) => checkDraft(draft({ venue: "linkedin", target: { kind: "reply", ref } }), LI, on);
  assert.deepEqual(li("7100000000000000000"), []);
  assert.deepEqual(li("urn:li:activity:7100000000000000000"), []);
  assert.deepEqual(li("https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000000/"), []);
  assert.deepEqual(li("https://www.linkedin.com/posts/someone_title-activity-7100000000000000000-AbCd"), []);
  assert.deepEqual(rules(li("https://www.linkedin.com.evil.example/feed/update/urn:li:activity:1/")), ["target"]);
});

test("length: X weighted 280 (URL = 23), override honoured", () => {
  assert.deepEqual(checkDraft(draft({ body: "a".repeat(280) }), X, on), []);
  assert.deepEqual(rules(checkDraft(draft({ body: "a".repeat(281) }), X, on)), ["length"]);
  assert.deepEqual(rules(checkDraft(draft({ body: "日".repeat(141) }), X, on)), ["length"]);
  assert.deepEqual(checkDraft(draft({ body: "a".repeat(1000) }), X, { ...on, maxLength: 4000 }), []);
});

test("length: LinkedIn post 3000, comment 1250 characters", () => {
  const li = (body: string, kind = "post", ref = "") => checkDraft(draft({ venue: "linkedin", body, target: { kind, ref } }), LI, on);
  assert.deepEqual(li("a".repeat(3000)), []);
  assert.deepEqual(rules(li("a".repeat(3001))), ["length"]);
  assert.deepEqual(li("a".repeat(1250), "reply", "7100000000000000000"), []);
  assert.deepEqual(rules(li("a".repeat(1251), "reply", "7100000000000000000")), ["length"]);
});

test("mention: refused unless allowed", () => {
  assert.deepEqual(rules(checkDraft(draft({ body: "thanks @someone" }), X, on)), ["mention"]);
  assert.deepEqual(rules(checkDraft(draft({ body: "thanks ＠someone" }), X, on)), ["mention"]);
  assert.deepEqual(checkDraft(draft({ body: "thanks @someone" }), X, { ...on, allowMentions: true }), []);
});

test("hidden-char: zero-width characters refused", () => {
  assert.deepEqual(rules(checkDraft(draft({ body: "hello​world" }), X, on)), ["hidden-char"]);
});

test("empty: X allows media-only, LinkedIn does not", () => {
  assert.deepEqual(rules(checkDraft(draft({ body: "  " }), X, on)), ["empty"]);
  assert.deepEqual(checkDraft(draft({ body: "", media: [img("a/b")] }), X, on), []);
  assert.deepEqual(rules(checkDraft(draft({ venue: "linkedin", body: "", media: [img("a/b")] }), LI, on)), ["empty"]);
});

test("media: count, mix, type and size", () => {
  assert.deepEqual(checkDraft(draft({ media: [img("a/1"), img("a/2"), img("a/3"), img("a/4")] }), X, on), []);
  assert.deepEqual(rules(checkDraft(draft({ media: [img("a/1"), img("a/2"), img("a/3"), img("a/4"), img("a/5")] }), X, on)), ["media-count"]);
  assert.deepEqual(rules(checkDraft(draft({ media: [img("a/1"), img("a/v", 10, "video/mp4")] }), X, on)), ["media-mix"]);
  assert.deepEqual(rules(checkDraft(draft({ media: [img("a/1", 6 * 1024 * 1024)] }), X, on)), ["media-size"]);
  assert.deepEqual(rules(checkDraft(draft({ venue: "linkedin", media: [img("a/1", 10, "image/webp")] }), LI, on)), ["media-type"]);
  const liReply = draft({ venue: "linkedin", target: { kind: "reply", ref: "7100000000000000000" }, media: [img("a/v", 10, "video/mp4")] });
  assert.deepEqual(rules(checkDraft(liReply, LI, on)), ["media-count", "media-type"]);
  const liReply2 = draft({ venue: "linkedin", target: { kind: "reply", ref: "7100000000000000000" }, media: [img("a/1"), img("a/2")] });
  assert.deepEqual(rules(checkDraft(liReply2, LI, on)), ["media-count"]);
});
