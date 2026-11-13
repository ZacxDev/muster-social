#!/usr/bin/env node
// Mutation check for the safety guards: break each guard on purpose, run the
// test file that should catch it, and require that THE NAMED TEST fails (not
// just any test). Every file is restored from memory afterwards and verified
// byte-for-byte. A no-op control mutant must SURVIVE, proving the harness can
// report a survivor; a known-caught mutant must be KILLED, proving it can
// report a kill.
//
//   node scripts/mutation-check.mjs            all mutants
//   node scripts/mutation-check.mjs M03 M08    some
//
// Exit 0 only when every guard mutant is killed by its named test and both
// controls behave.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** id, file, find (must occur exactly once), replace, test file, killing test name (substring). */
const MUTANTS = [
  ["M00-control-noop", "src/poster.ts", "export class LeaseTooShort extends Error {}", "export class LeaseTooShort extends Error {} // mutation control: no-op", "test/poster.test.ts", null],
  ["M01-body-hash", "src/poster.ts", "if (!c.body_sha256 || sha256Hex(c.body) !== c.body_sha256) {", "if (!c.body_sha256) {", "test/poster.test.ts", "the body must hash to the approved body_sha256"],
  ["M02-media-rehash", "src/poster.ts", "if (r.media.sha256 !== m.sha256 || r.media.contentType !== m.content_type) {", "if (r.media.contentType !== m.content_type) {", "test/poster.test.ts", "media are re-hashed"],
  ["M03-venue-paused", "src/poster.ts", "if (open.length) {", "if (false) {", "test/poster.test.ts", "unknown after the click: NOT reported"],
  ["M04-never-rearm", "src/poster.ts", "if (prior && (prior.open || prior.refused || prior.resolved)) {", "if (prior && (prior.refused || prior.resolved)) {", "test/poster.test.ts", "crash between the journal's open record and the click"],
  ["M05-journal-before-click", "src/poster.ts", "beforeAct: () => {", "afterAct: () => {", "test/poster.test.ts", "crash between the journal's open record and the click"],
  ["M06-gate-once", "src/poster.ts", "if (gateUsed) throw new Error(\"the submit gate opens once per draft\");", "", "test/poster.test.ts", "the gate opens once"],
  ["M07-guarded-driver-element", "src/poster.ts", "const guard: ActionGuard = { forbid: adapter.submitSelectors, labels: adapter.submitLabels };", "const guard: ActionGuard = {};", "test/guard.test.ts", "X: other spellings of the Post button are refused"],
  ["M07b-guard-on-insertText", "src/poster.ts", "insertText: (s, t) => raw.insertText(s, t, { guard }),", "insertText: (s, t) => raw.insertText(s, t),", "test/guard.test.ts", "X: insertText and attachFiles"],
  ["M07c-guard-on-chooser", "src/poster.ts", "attachFiles: (s, p, o) => raw.attachFiles(s, p, { guard, ", "attachFiles: (s, p, o) => raw.attachFiles(s, p, { ", "test/guard.test.ts", "X: insertText and attachFiles"],
  ["M07d-adapter-cannot-pass-guard", "src/poster.ts", "click: (s) => raw.click(s, { guard }),", "click: ((s: string, o?: object) => raw.click(s, o ?? { guard })) as BrowserDriver[\"click\"],", "test/guard.test.ts", "an adapter cannot hand the driver its own guard"],
  ["M08-gate-require", "src/poster.ts", "guard: { require: adapter.submitSelectors },", "guard: { require: [] },", "test/poster.test.ts", "the gate refuses a selector"],
  ["M08b-target-matches", "src/sites/target.ts", "if (test(() => el.matches(sel))) return", "if (false) return", "test/guard.test.ts", "targetProblem: the element itself matches"],
  ["M08c-target-closest", "src/sites/target.ts", "if (test(() => el.closest(sel))) return", "if (false) return", "test/guard.test.ts", "targetProblem: the element sits inside"],
  ["M08d-target-descendant", "src/sites/target.ts", "if (test(() => el.querySelector(sel))) return", "if (false) return", "test/guard.test.ts", "targetProblem: the element contains"],
  ["M08e-target-label", "src/sites/target.ts", "if (t && g.labels.indexOf(t) >= 0) return", "if (false) return", "test/guard.test.ts", "LinkedIn: a button labelled Post is refused"],
  ["M08f-target-submit-type", "src/sites/target.ts", "if ((btn.getAttribute(\"type\") || \"\").toLowerCase() === \"submit\") return", "if (false) return", "test/guard.test.ts", "targetProblem: a submit-type button"],
  ["M08g-target-fail-closed", "src/sites/target.ts", "      return true; // an unparsable selector fails closed", "      return false;", "test/guard.test.ts", "targetProblem: an unparsable forbid selector fails closed"],
  ["M09-after-click-only-posted-or-unknown", "src/poster.ts", "if (armed) {", "if (armed && outcome?.phase === \"clicked\") {", "test/poster.test.ts", "an adapter that throws after the click is unknown"],
  ["M10-pacing", "src/poster.ts", "return Math.max(0, last + site.min_gap_seconds * 1000 - this.d.now());", "return 0;", "test/poster.test.ts", "pacing:"],
  ["M11-x-text-mismatch", "src/sites/x.ts", "if (normalizeLines(st.text) !== normalizeLines(ctx.body)) {", "if (false) {", "test/x.test.ts", "x pre-click: the editor not holding the approved text"],
  ["M12-x-mention-link", "src/sites/x.ts", "if (!ctx.allowMentions && st.mentionLinks > 0) {", "if (false) {", "test/x.test.ts", "x pre-click: an unexpected mention link"],
  ["M13-x-allowed-mentions-bound", "src/sites/x.ts", "if (ctx.allowMentions && st.mentionLinks > findMentions(ctx.body).length) {", "if (false) {", "test/x.test.ts", "only the approved @names may be links"],
  ["M14-x-media-count", "src/sites/x.ts", "if (st.media !== want) return refused(\"media_count\"", "if (false) return refused(\"media_count\"", "test/x.test.ts", "x pre-click: the wrong media count"],
  ["M15-x-button-disabled", "src/sites/x.ts", "if (st.disabled !== false) return refused(\"button_disabled\"", "if (false) return refused(\"button_disabled\"", "test/x.test.ts", "a disabled post button"],
  ["M16-x-wrong-account", "src/sites/x.ts", "if (acct.toLowerCase() !== me.toLowerCase()) {", "if (false) {", "test/x.test.ts", "x refuses another account"],
  ["M17-x-duplicate", "src/sites/x.ts", "if (dup) return refused(\"duplicate_present\", `an identical reply", "if (false) return refused(\"duplicate_present\", `an identical reply", "test/x.test.ts", "never posted twice"],
  ["M18-x-unknown-not-posted", "src/sites/x.ts", "phase: \"clicked\", state: \"unknown\",\n      detail: `clicked once; the post was not found", "phase: \"clicked\", state: \"posted\",\n      detail: `clicked once; the post was not found", "test/x.test.ts", "a post that never appears is unknown"],
  ["M19-x-readback-since", "src/sites/x.ts", "&& (since === null || (idTimeMs(a.id, X_EPOCH_MS) ?? 0) >= since)) ?? null;", "&& true) ?? null;", "test/x.test.ts", "ignores an older identical post"],
  ["M20-li-not-own-post", "src/sites/linkedin.ts", "if (target.author !== me) {", "if (false) {", "test/linkedin.test.ts", "someone else's post is refused"],
  ["M21-li-text-mismatch", "src/sites/linkedin.ts", "if (normalizeLines(st.text) !== normalizeLines(ctx.body)) return refused(\"text_mismatch\"", "if (false) return refused(\"text_mismatch\"", "test/linkedin.test.ts", "editor text mismatch"],
  ["M22-li-wrong-account", "src/sites/linkedin.ts", "if (a.slug !== me) {", "if (false) {", "test/linkedin.test.ts", "another member"],
  ["M23-li-media-count", "src/sites/linkedin.ts", "if (st.media !== want) return refused(\"media_count\"", "if (false) return refused(\"media_count\"", "test/linkedin.test.ts", "linkedin post with media"],
  ["M24-rules-mention", "src/rules.ts", "if (!cfg.allowMentions) {", "if (false) {", "test/rules.test.ts", "mention: refused unless allowed"],
  ["M25-rules-length-boundary", "src/rules.ts", "if (len > max) {", "if (len > max + 1) {", "test/rules.test.ts", "length: X weighted 280"],
  ["M26-rules-hidden", "src/rules.ts", "if (hidden) out.push(", "if (false) out.push(", "test/rules.test.ts", "hidden-char"],
  ["M27-rules-media-mix", "src/rules.ts", "if (!L.mixMedia && images.length && videos.length) {", "if (false) {", "test/rules.test.ts", "media: count, mix, type and size"],
  ["M28-media-outside-root", "src/media.ts", "if (!real.startsWith(root + sep))", "if (false)", "test/media.test.ts", "outside media_root"],
  ["M29-media-sniff", "src/media.ts", "if (sniffed !== declared) return", "if (false) return", "test/checker.test.ts", "a media ref with no file, two files, or the wrong bytes"],
  ["M30-journal-open-is-unresolved", "src/journal.ts", "return p === \"open\" || p === \"unknown\";", "return p === \"unknown\";", "test/journal.test.ts", "crash between the journal's open record and the click"],
  ["M31-journal-unknown-never-reported", "src/journal.ts", "    case \"posted\":\n      return { ok: true, external_ref: s.outcome?.ref", "    case \"posted\":\n    case \"unknown\":\n      return { ok: true, external_ref: s.outcome?.ref", "test/poster.test.ts", "unknown after the click: NOT reported"],
  ["M32-journal-torn-tail", "src/journal.ts", "if (raw.length && !raw.endsWith(\"\\n\")) {", "if (false) {", "test/journal.test.ts", "a torn final line"],
  ["M33-client-retry", "src/muster/client.ts", "if (!(e instanceof MusterError) || !e.retryable || i >= this.attempts) throw e;", "throw e;", "test/client.test.ts", "result: retried through 5xx"],
  ["M34-client-https", "src/muster/client.ts", "if (u.protocol !== \"https:\" && !(u.protocol === \"http:\" && (loopback || allowInsecureHttp))) {", "if (false) {", "test/client.test.ts", "checkBaseUrl"],
  ["M35-pairing-0600", "src/pairing.ts", "const fd = openSync(path, \"wx\", 0o600);", "const fd = openSync(path, \"wx\", 0o644);", "test/pairing.test.ts", "writes the token 0600"],
  ["M36-checker-uploaded-sha", "src/checker.ts", "if (m.sha256 !== l.sha256) {", "if (false) {", "test/checker.test.ts", "bytes muster already holds"],
  ["M37-checker-session-account", "src/checker.ts", "if ((s.account ?? \"\").toLowerCase() !== site.account.toLowerCase()) {", "if (false) {", "test/checker.test.ts", "signed in as another account"],
  ["M38-text-link-prefix", "src/text.ts", "return shown.length >= 4 && want.startsWith(shown);", "return true;", "test/text.test.ts", "linkStandsFor"],
  ["M40-claim-hold-on-unresolved", "src/poster.ts", "if (paused.length) {", "if (false) {", "test/poster.test.ts", "readyToClaim: nothing is claimed while a site has an unresolved attempt"],
  ["M41-claim-hold-on-pacing", "src/poster.ts", "if (worst > this.maxPacingWaitMs) {", "if (false) {", "test/poster.test.ts", "pacing:"],
  ["M42-x-loaded-marker", "src/sites/x.ts", "return doc.querySelector(S.emptyState) ? { a: [] as XArticle[] } : null;", "return { a: [] as XArticle[] };", "test/x.test.ts", "a profile that did not load"],
  ["M43-li-loaded-marker", "src/sites/linkedin.ts", "return doc.querySelector(S.emptyState) ? { u: [] as LiUpdate[] } : null;", "return { u: [] as LiUpdate[] };", "test/linkedin.test.ts", "an activity page that did not load"],
  ["M44-li-comments-polled", "src/sites/linkedin.ts", "const found = await poll(d, T.loadMs, T.stepMs", "const found = await poll(d, 0, T.stepMs", "test/linkedin.test.ts", "comments that load late"],
  ["M45-li-comment-box-scoped", "src/sites/linkedin.ts", "`[data-urn=\"urn:li:activity:${activity}\"] ${p.trim()}`", "p.trim()", "test/linkedin.test.ts", "linkedin reply: a comment on the member's own post"],
  ["M46-tco-shown-url-binds", "src/text.ts", "if (bareUrl(link.href) === want) return true;", "if (bareUrl(link.href) === want || SHORTENER_HOSTS.includes(hostOf(link.href))) return true;", "test/text.test.ts", "post-1 vs post-2"],
  ["M47-x-lines-kept", "src/sites/x.ts", "if (normalizeLines(st.text) !== normalizeLines(ctx.body)) {", "if (normalizeWs(st.text) !== normalizeWs(ctx.body)) {", "test/x.test.ts", "line breaks are kept"],
  ["M48-li-lines-kept", "src/sites/linkedin.ts", "if (normalizeLines(st.text) !== normalizeLines(ctx.body)) return", "if (normalizeWs(st.text) !== normalizeWs(ctx.body)) return", "test/linkedin.test.ts", "an editor that merges lines"],
  ["M49-editor-blocks-are-lines", "src/sites/dom.ts", "if (pendingBreak && s !== \"\" && !s.endsWith(\"\\n\")) s += \"\\n\";", "", "test/x.test.ts", "a multi-line Draft.js composer"],
  ["M50-status-read-only", "src/journal.ts", "if (raw.length && !raw.endsWith(\"\\n\") && this.readOnly) {", "if (false) {", "test/journal.test.ts", "a read-only open"],
  ["M51-x-readback-author", "src/sites/x.ts", "return list.find((a) => (a.author ?? \"\").toLowerCase() === me.toLowerCase()", "return list.find((a) => true", "test/x.test.ts", "another account's identical reply is not ours"],
  ["M52-li-readback-since", "src/sites/linkedin.ts", "&& (since === null || (idTimeMs(u.activity, 0n) ?? 0) >= since)) ?? null;", "&& true) ?? null;", "test/linkedin.test.ts", "an older identical own post is not this one"],
  ["M53-li-comment-post-id", "src/sites/linkedin.ts", "cs.find((c) => c.post === post && c.author === me", "cs.find((c) => true && c.author === me", "test/linkedin.test.ts", "an identical own comment on ANOTHER post"],
  ["M54-lease-deadline", "src/poster.ts", "if (age > this.leaseMs - this.leaseMarginMs) {", "if (false) {", "test/poster.test.ts", "lease:"],
  ["M39-config-unknown-keys", "src/config.ts", "for (const k of Object.keys(obj)) if (!allowed.has(k)) throw", "for (const k of Object.keys(obj)) if (false) throw", "test/config.test.ts", "unknown keys are refused"],
];

function sha(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function srcTree() {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = sha(p);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

function runTests(file) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" }, timeout: 120_000,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  // top-level TAP result lines: "ok 3 - name" / "not ok 3 - name"
  const failed = [];
  let okCount = 0;
  for (const line of out.split("\n")) {
    const m = /^(not ok|ok) \d+ - (.*)$/u.exec(line);
    if (!m) continue;
    if (m[1] === "not ok") failed.push(m[2]);
    else okCount++;
  }
  return { failed, okCount, status: r.status, raw: out };
}

const pick = process.argv.slice(2);
const list = pick.length ? MUTANTS.filter(([id]) => pick.some((p) => id.startsWith(p))) : MUTANTS;
const before = srcTree();
const rows = [];
let bad = 0;

// Baseline: every test file used must be green and must report results.
const files = [...new Set(list.map((m) => m[4]))];
for (const f of files) {
  const b = runTests(f);
  if (b.failed.length || b.okCount === 0) {
    console.error(`baseline ${f} is not green (${b.okCount} ok, failed: ${b.failed.join(" | ")})`);
    process.exit(2);
  }
}

for (const [id, file, find, replace, testFile, killer] of list) {
  const path = join(ROOT, file);
  const orig = readFileSync(path, "utf8");
  const n = orig.split(find).length - 1;
  if (n !== 1) {
    rows.push([id, "HARNESS-ERROR", `pattern occurs ${n} times in ${file}`]);
    bad++;
    continue;
  }
  let res;
  try {
    writeFileSync(path, orig.replace(find, replace));
    res = runTests(testFile);
  } finally {
    writeFileSync(path, orig);
  }
  if (sha(path) !== createHash("sha256").update(orig).digest("hex")) {
    console.error(`RESTORE FAILED for ${file}`);
    process.exit(3);
  }
  if (killer === null) {
    const ok = res.failed.length === 0 && res.okCount > 0;
    rows.push([id, ok ? "SURVIVED (control: expected)" : "KILLED (control: UNEXPECTED)", res.failed.join(" | ")]);
    if (!ok) bad++;
    continue;
  }
  const byNamed = res.failed.filter((t) => t.includes(killer));
  if (byNamed.length) {
    const others = res.failed.length - byNamed.length;
    rows.push([id, "KILLED", `by "${byNamed[0]}"${others ? ` (+${others} other)` : ""}`]);
  } else {
    rows.push([id, res.failed.length ? "KILLED-BY-OTHER" : "SURVIVED", res.failed.join(" | ") || `${res.okCount} ok`]);
    bad++;
  }
}

const after = srcTree();
for (const [p, h] of Object.entries(before)) {
  if (after[p] !== h) {
    console.error(`source tree changed: ${p}`);
    process.exit(3);
  }
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const [id, verdict, why] of rows) console.log(`${id.padEnd(w)}  ${verdict.padEnd(28)}  ${why}`);
console.log(`\n${rows.length} mutants, ${bad} problem(s); source tree verified unchanged`);
process.exit(bad ? 1 : 0);
