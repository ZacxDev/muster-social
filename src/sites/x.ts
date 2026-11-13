// X (x.com): a new post from the home timeline's inline composer, or a reply
// under a status. Selectors: ./selectors.ts (X_SELECTORS), unverified live.

import { all, parse, plainText, segments, type Doc, type El } from "./dom.ts";
import { DEFAULT_TIMING, idTimeMs, poll, readback, type Timing } from "./common.ts";
import { X_SELECTORS as S } from "./selectors.ts";
import { findMentions, normalizeWs, textMatches, type Segment } from "../text.ts";
import {
  refused, type BrowserDriver, type OutboundTarget, type PostContext, type PostOutcome,
  type SessionState, type SiteAdapter, type SiteLimits,
} from "./types.ts";

const X_EPOCH_MS = 1288834974657n;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/u;

export const X_LIMITS: SiteLimits = Object.freeze({
  maxLength: { post: 280, reply: 280 },
  lengthRule: "x-weighted",
  mediaTypes: {
    post: ["image/png", "image/jpeg", "image/webp", "video/mp4"],
    reply: ["image/png", "image/jpeg", "image/webp", "video/mp4"],
  },
  maxImages: { post: 4, reply: 4 },
  maxVideos: { post: 1, reply: 1 },
  mixMedia: false,
  emptyBodyWithMedia: true,
  maxImageBytes: 5 * 1024 * 1024,
  maxVideoBytes: 512 * 1024 * 1024,
}) as SiteLimits;

export interface XArticle {
  author: string | null;
  id: string | null;
  segs: Segment[];
  media: number;
}

/** The handle the page is signed in as, from the side bar's profile link. */
export function xAccount(doc: Doc): string | null {
  const a = doc.querySelector(S.accountLink);
  const m = /^\/([^/?#]+)$/u.exec(a?.getAttribute("href") ?? "");
  return m && HANDLE_RE.test(m[1] ?? "") ? (m[1] ?? null) : null;
}

export function xArticles(doc: Doc): XArticle[] {
  return all(doc, S.article).map((a: El) => {
    const time = a.querySelector(S.articlePermalinkTime);
    const link = time ? time.closest("a") : null;
    const m = /^\/([^/]+)\/status\/(\d+)/u.exec(link?.getAttribute("href") ?? "");
    const text = a.querySelector(S.articleText);
    return {
      author: m ? (m[1] ?? null) : null,
      id: m ? (m[2] ?? null) : null,
      segs: text ? segments(text) : [],
      media: all(a, S.articleMedia).length,
    };
  });
}

export interface XComposerState {
  present: boolean;
  text: string;
  mentionLinks: number;
  media: number;
  busy: number;
  button: boolean;
  disabled: boolean | null;
}

/** A link in the composer that tags an account: shown as @name, or pointing at
 * a bare profile path. */
function isMentionLink(a: El): boolean {
  const t = normalizeWs(plainText(a));
  const href = a.getAttribute("href") ?? "";
  return /^[@＠]/u.test(t) || /^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com)?\/[A-Za-z0-9_]{1,15}\/?$/u.test(href);
}

export function xComposer(doc: Doc): XComposerState {
  const c = doc.querySelector(S.composer);
  const b = doc.querySelector(S.submit);
  return {
    present: !!c,
    text: c ? plainText(c) : "",
    mentionLinks: all(doc, S.composerLinks).filter(isMentionLink).length,
    media: all(doc, S.attachmentMedia).length,
    busy: all(doc, S.attachmentBusy).length,
    button: !!b,
    disabled: b ? b.getAttribute("aria-disabled") === "true" || b.getAttribute("disabled") !== null : null,
  };
}

/** Our own post in `arts` (after the parent `afterId`, when given) whose text
 * matches and whose id is no older than `since`. */
export function xOwnMatch(arts: XArticle[], me: string, body: string, afterId: string | null,
  since: number | null): XArticle | null {
  let list = arts;
  if (afterId) {
    const i = arts.findIndex((a) => a.id === afterId);
    if (i < 0) throw new Error("the parent status is not on its page");
    list = arts.slice(i + 1);
  }
  return list.find((a) => (a.author ?? "").toLowerCase() === me.toLowerCase()
    && a.id !== null
    && textMatches(body, a.segs)
    && (since === null || (idTimeMs(a.id, X_EPOCH_MS) ?? 0) >= since)) ?? null;
}

export function parseXTarget(t: OutboundTarget): { ok: true; kind: "post" | "reply"; ref: string } | { ok: false; detail: string } {
  if (t.kind === "post") {
    return t.ref === "" ? { ok: true, kind: "post", ref: "" } : { ok: false, detail: "a new post's target ref must be empty" };
  }
  if (t.kind !== "reply") return { ok: false, detail: `target kind ${JSON.stringify(t.kind)} is not post or reply` };
  const id = /^\d{1,20}$/u.test(t.ref) ? t.ref
    : /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,20})(?:[/?#].*)?$/u.exec(t.ref)?.[1];
  if (!id) return { ok: false, detail: "an X reply target is a status id or a https://x.com/<user>/status/<id> URL" };
  return { ok: true, kind: "reply", ref: id };
}

export function makeXAdapter(timing: Timing = DEFAULT_TIMING): SiteAdapter {
  const T = timing;

  async function readArticles(d: BrowserDriver, url: string): Promise<XArticle[]> {
    await d.goto(url);
    const arts = await poll(d, T.loadMs, T.stepMs, async () => {
      const a = xArticles(parse(await d.html()));
      return a.length ? a : null;
    });
    return arts ?? [];
  }

  async function checkSession(d: BrowserDriver): Promise<SessionState> {
    await d.goto("https://x.com/home");
    const acct = await poll(d, T.loadMs, T.stepMs, async () => xAccount(parse(await d.html())));
    return acct
      ? { signedIn: true, account: acct, detail: `signed in to X as ${acct}` }
      : { signedIn: false, account: null, detail: "X shows no signed-in account" };
  }

  async function post(ctx: PostContext): Promise<PostOutcome> {
    const d = ctx.driver;
    const me = ctx.account;
    const reply = ctx.target.kind === "reply";
    const start = reply ? `https://x.com/i/status/${ctx.target.ref}` : "https://x.com/home";

    await d.goto(start);
    const acct = await poll(d, T.loadMs, T.stepMs, async () => xAccount(parse(await d.html())));
    if (!acct) return refused("not_signed_in", "X shows no signed-in account in this browser profile; nothing sent");
    if (acct.toLowerCase() !== me.toLowerCase()) {
      return refused("wrong_account", `this browser profile is signed in to X as ${acct}, not ${me}; nothing sent`);
    }

    // An identical post of ours already there is never posted twice.
    if (reply) {
      const arts = await poll(d, T.loadMs, T.stepMs, async () => {
        const a = xArticles(parse(await d.html()));
        return a.some((x) => x.id === ctx.target.ref) ? a : null;
      });
      if (!arts) return refused("bad_target", `status ${ctx.target.ref} did not load; nothing sent`);
      const dup = xOwnMatch(arts, me, ctx.body, ctx.target.ref, null);
      if (dup) return refused("duplicate_present", `an identical reply by ${me} is already there (status ${dup.id}); nothing sent`);
    } else {
      const dup = xOwnMatch(await readArticles(d, `https://x.com/${me}`), me, ctx.body, null, null);
      if (dup) return refused("duplicate_present", `an identical post by ${me} is already on the profile (status ${dup.id}); nothing sent`);
      await d.goto(start);
    }

    const ready = await poll(d, T.loadMs, T.stepMs, async () => xComposer(parse(await d.html())).present);
    if (!ready) return refused("no_composer", "no composer on the page; nothing sent");
    await d.insertText(S.composer, ctx.body);
    if (ctx.media.length) await d.attachFiles(S.fileInput, ctx.media.map((m) => m.path));

    const want = ctx.media.length;
    const settled = await poll(d, want ? T.mediaWaitMs : T.loadMs, T.stepMs, async () => {
      const s = xComposer(parse(await d.html()));
      return s.media === want && s.busy === 0 && s.disabled === false ? s : null;
    });
    const st = settled ?? xComposer(parse(await d.html()));

    // Pre-click checks, each its own refusal.
    if (!st.present || !st.button) return refused("no_composer", "no composer or post button; nothing sent");
    if (!ctx.allowMentions && st.mentionLinks > 0) {
      return refused("mention_link", `the composer holds ${st.mentionLinks} mention link(s); nothing sent`);
    }
    if (ctx.allowMentions && st.mentionLinks > findMentions(ctx.body).length) {
      return refused("mention_link", `the composer holds ${st.mentionLinks} mention link(s), more than the approved text names; nothing sent`);
    }
    if (normalizeWs(st.text) !== normalizeWs(ctx.body)) {
      return refused("text_mismatch", "the composer does not hold the approved text; nothing sent");
    }
    if (st.media !== want) return refused("media_count", `the composer shows ${st.media} of ${want} media; nothing sent`);
    if (st.disabled !== false) return refused("button_disabled", "the post button is disabled; nothing sent");

    const since = d.now() - T.sinceSlackMs;
    await ctx.submit(S.submit);

    // Leave the page only once the composer cleared (or the wait ran out):
    // navigating away mid-request could cut the post.
    const cleared = !!await poll(d, T.clearWaitMs, T.stepMs, async () => {
      const s = xComposer(parse(await d.html()));
      return s.present && normalizeWs(s.text) === "" ? s : null;
    });

    const first = reply
      ? async () => xOwnMatch(await readArticles(d, `https://x.com/i/status/${ctx.target.ref}`), me, ctx.body, ctx.target.ref, since)
      : async () => xOwnMatch(await readArticles(d, `https://x.com/${me}`), me, ctx.body, null, since);
    const rest = [async () => xOwnMatch(await readArticles(d, `https://x.com/${me}/with_replies`), me, ctx.body, null, since)];
    const rb = await readback(d, T.readbackTries, T.readbackStepMs, first, rest);
    if (rb.hit && rb.hit.id) {
      const media = rb.hit.media === want ? "" : `; read back with ${rb.hit.media} of ${want} media`;
      return { phase: "clicked", state: "posted", ref: `https://x.com/${me}/status/${rb.hit.id}`, detail: `read back${media}` };
    }
    const why = rb.errors.length ? `; read errors: ${rb.errors.join("; ")}` : "";
    return {
      phase: "clicked", state: "unknown",
      detail: `clicked once; the post was not found on read-back (composer ${cleared ? "cleared" : "did not clear"})${why}`,
    };
  }

  return {
    venue: "x",
    limits: X_LIMITS,
    parseTarget: parseXTarget,
    checkSession,
    post,
    submitSelectors: [S.submit],
  };
}
