// The guarded driver is structural: what is refused is the ELEMENT an action
// resolves to, whatever the selector's spelling and whichever action it is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { guardDriver } from "../src/poster.ts";
import { makeXAdapter } from "../src/sites/x.ts";
import { makeLinkedinAdapter } from "../src/sites/linkedin.ts";
import { ForbiddenTarget, type BrowserDriver } from "../src/sites/types.ts";
import { FakeDriver, FakeLinkedin, FakeX } from "./helpers/fakeBrowser.ts";
import { targetProblem } from "../src/sites/target.ts";
import { parse } from "../src/sites/dom.ts";

const X = makeXAdapter();
const LI = makeLinkedinAdapter();

async function xPage() {
  const site = new FakeX({ account: "example_me", clock: () => 0 });
  const raw = new FakeDriver(site, X.submitSelectors);
  await raw.goto("https://x.com/home");
  return { raw, g: guardDriver(raw, X) };
}

async function liShareBox() {
  const site = new FakeLinkedin({ account: "example-me", clock: () => 0 });
  const raw = new FakeDriver(site, LI.submitSelectors);
  await raw.goto("https://www.linkedin.com/feed/");
  site.shareOpen = true;
  return { raw, site, g: guardDriver(raw, LI) };
}

const refusedAll = async (g: BrowserDriver, raw: FakeDriver, calls: Array<() => Promise<void>>) => {
  for (const c of calls) await assert.rejects(c(), ForbiddenTarget);
  assert.equal(raw.submits, 0);
  assert.deepEqual(raw.actions, [], "no action reached the page");
};

test("X: other spellings of the Post button are refused (attribute quoting, ancestors, a child span, a container)", async () => {
  const { raw, g } = await xPage();
  await refusedAll(g, raw, [
    () => g.click("button[data-testid='tweetButtonInline']"),
    () => g.click("main button[aria-disabled]"),
    () => g.click("[data-testid=tweetButtonInline] span"),
    () => g.click("main"),
  ]);
});

test("X: insertText and attachFiles (a chooser click) on the Post button are refused too", async () => {
  const { raw, g } = await xPage();
  await refusedAll(g, raw, [
    () => g.insertText("[data-testid=tweetButtonInline]", "hello"),
    () => g.attachFiles("[data-testid=tweetButtonInline]", ["/x.png"], { viaChooser: true }),
  ]);
});

test("X: ordinary actions still pass (the composer, the file input)", async () => {
  const { raw, g } = await xPage();
  await g.insertText("[data-testid=tweetTextarea_0]", "hello");
  await g.attachFiles("input[data-testid=fileInput]", ["/x.png"]);
  assert.deepEqual(raw.actions.map((a) => a[0]), ["insertText", "attachFiles"]);
  assert.equal(raw.submits, 0);
});

test("LinkedIn: the share box's Post button, by any spelling or action, is refused", async () => {
  const { raw, g } = await liShareBox();
  await refusedAll(g, raw, [
    () => g.click(".share-actions__primary-action"),
    () => g.click("button.share-actions__primary-action "),
    () => g.click("div.share-box-footer button"),
    () => g.insertText("button.share-actions__primary-action", "x"),
    () => g.attachFiles("button.share-actions__primary-action", ["/x.png"], { viaChooser: true }),
  ]);
});

test("LinkedIn: a button labelled Post is refused even with no known submit class", async () => {
  const { raw, site, g } = await liShareBox();
  site.pendingMedia = 1;
  site.o.mediaNextIsPost = "labelled-post";
  await refusedAll(g, raw, [() => g.click(".share-media-editor .share-box-footer__primary-btn")]);
});

test("an adapter cannot hand the driver its own guard or hook: guardDriver replaces them", async () => {
  const { raw, g } = await xPage();
  let ran = false;
  const sneaky = g.click as unknown as (s: string, o: unknown) => Promise<void>;
  await assert.rejects(sneaky("[data-testid=tweetButtonInline]", { guard: {}, beforeAct: () => { ran = true; } }), ForbiddenTarget);
  assert.equal(ran, false);
  assert.equal(raw.submits, 0);
});

// targetProblem, branch by branch (the same function the real driver runs in the page)
const PAGE = parse(`<main id="m"><form><div class="box"><button class="go" id="go"><span id="in">Send it</span></button>`
  + `<button id="sub" type="submit">Next</button><button id="lab" aria-label="Post">→</button><input id="txt"></div></form></main>`);
const el = (id: string) => PAGE.querySelector("#" + id) as unknown as Element;
const G = (o: { forbid?: string[]; labels?: string[]; require?: string[] }) => ({ forbid: o.forbid ?? [], labels: o.labels ?? [], require: o.require ?? [] });

test("targetProblem: the element itself matches a submit selector", () => {
  assert.match(targetProblem(el("go"), G({ forbid: [".go"] })) ?? "", /is a submit control/u);
});

test("targetProblem: the element sits inside a submit control (closest)", () => {
  assert.match(targetProblem(el("in"), G({ forbid: [".go"] })) ?? "", /sits inside/u);
});

test("targetProblem: the element contains a submit control (descendant)", () => {
  assert.match(targetProblem(el("m"), G({ forbid: [".go"] })) ?? "", /contains/u);
});

test("targetProblem: a submit-type button, and a button labelled like a submit, are refused", () => {
  assert.match(targetProblem(el("sub"), G({ labels: ["post"] })) ?? "", /submit-type/u);
  assert.match(targetProblem(el("lab"), G({ labels: ["post"] })) ?? "", /labelled 'post'/u);
  assert.equal(targetProblem(el("txt"), G({ forbid: [".go"], labels: ["post"] })), null);
});

test("targetProblem: an unparsable forbid selector fails closed; require must match the element itself", () => {
  assert.ok(targetProblem(el("txt"), G({ forbid: ["[[["] })));
  assert.match(targetProblem(el("in"), G({ require: [".go"] })) ?? "", /not one of the site's submit controls/u);
  assert.equal(targetProblem(el("go"), G({ require: [".go"] })), null);
});
