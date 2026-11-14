// LinkedIn: a post on the signed-in member's own feed, or a comment on one of
// the member's OWN posts (a reply target authored by anyone else is refused).
// Selectors: ./selectors.ts (LINKEDIN_SELECTORS), unverified live.

import { all, parse, plainText, segments, type Doc, type El } from "./dom.ts";
import { DEFAULT_TIMING, idTimeMs, poll, readback, type Timing } from "./common.ts";
import { LINKEDIN_SELECTORS as S, LINKEDIN_SUBMIT_LABELS } from "./selectors.ts";
import { findMentions, normalizeLines, normalizeWs, textMatches, type Segment } from "../text.ts";
import {
  refused, type BrowserDriver, type OutboundTarget, type PostContext, type PostOutcome,
  type SessionState, type SiteAdapter, type SiteLimits,
} from "./types.ts";

const FEED = "https://www.linkedin.com/feed/";

export const LINKEDIN_LIMITS: SiteLimits = Object.freeze({
  maxLength: { post: 3000, reply: 1250 },
  lengthRule: "code-points",
  mediaTypes: { post: ["image/png", "image/jpeg", "video/mp4"], reply: ["image/png", "image/jpeg"] },
  maxImages: { post: 4, reply: 1 },
  maxVideos: { post: 1, reply: 0 },
  mixMedia: false,
  emptyBodyWithMedia: false,
  maxImageBytes: 5 * 1024 * 1024,
  maxVideoBytes: 200 * 1024 * 1024,
}) as SiteLimits;

/** The public-profile slug in a /in/<slug> link, lower-cased and decoded. */
export function profileSlug(href: string): string | null {
  const m = /(?:^|linkedin\.com)\/in\/([^/?#]+)/u.exec(href);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? "").toLowerCase();
  } catch {
    return null;
  }
}

export function linkedinAccount(doc: Doc): { signedIn: boolean; slug: string | null } {
  const signedIn = !!doc.querySelector(S.signedInMarker);
  const a = doc.querySelector(S.ownProfileLink);
  return { signedIn, slug: a ? profileSlug(a.getAttribute("href") ?? "") : null };
}

export interface LiUpdate {
  activity: string;
  author: string | null;
  segs: Segment[];
  media: number;
  el: El;
}

export function linkedinUpdates(doc: Doc): LiUpdate[] {
  return all(doc, S.update).map((u) => {
    const m = /^urn:li:activity:(\d{1,20})$/u.exec(u.getAttribute("data-urn") ?? "");
    const actor = u.querySelector(S.updateActorLink);
    const text = u.querySelector(S.updateText);
    return {
      activity: m ? (m[1] ?? "") : "",
      author: actor ? profileSlug(actor.getAttribute("href") ?? "") : null,
      segs: text ? segments(text) : [],
      media: all(u, S.updateMedia).length,
      el: u,
    };
  }).filter((u) => u.activity !== "");
}

export interface LiComment {
  post: string;
  id: string;
  author: string | null;
  segs: Segment[];
}

export function linkedinComments(root: Doc | El): LiComment[] {
  return all(root, S.comment).map((c) => {
    const m = /^urn:li:comment:\(activity:(\d{1,20}),(\d{1,20})\)$/u.exec(c.getAttribute("data-id") ?? "");
    const a = c.querySelector(S.commentAuthorLink);
    const t = c.querySelector(S.commentText);
    return {
      post: m ? (m[1] ?? "") : "",
      id: m ? (m[2] ?? "") : "",
      author: a ? profileSlug(a.getAttribute("href") ?? "") : null,
      segs: t ? segments(t) : [],
    };
  }).filter((c) => c.id !== "");
}

interface EditorState {
  present: boolean;
  text: string;
  mentions: number;
  media: number;
  button: boolean;
  disabled: boolean | null;
}

function editorState(doc: Doc, editorSel: string, mediaSel: string, submitSel: string): EditorState {
  const e = doc.querySelector(editorSel);
  const b = doc.querySelector(submitSel);
  return {
    present: !!e,
    text: e ? plainText(e) : "",
    mentions: e ? all(e, S.editorMentions).length : 0,
    media: all(doc, mediaSel).length,
    button: !!b,
    disabled: b ? b.getAttribute("disabled") !== null || b.getAttribute("aria-disabled") === "true" : null,
  };
}

export function parseLinkedinTarget(t: OutboundTarget): { ok: true; kind: "post" | "reply"; ref: string } | { ok: false; detail: string } {
  if (t.kind === "post") {
    return t.ref === "" ? { ok: true, kind: "post", ref: "" } : { ok: false, detail: "a new post's target ref must be empty" };
  }
  if (t.kind !== "reply") return { ok: false, detail: `target kind ${JSON.stringify(t.kind)} is not post or reply` };
  const r = t.ref;
  const id = /^\d{1,20}$/u.test(r) ? r
    : /^urn:li:activity:(\d{1,20})$/u.exec(r)?.[1]
      ?? /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:(\d{1,20})\/?(?:[?#].*)?$/u.exec(r)?.[1]
      ?? /^https:\/\/www\.linkedin\.com\/posts\/[^/?#]*-activity-(\d{1,20})-[A-Za-z0-9_-]+\/?(?:[?#].*)?$/u.exec(r)?.[1];
  if (!id) return { ok: false, detail: "a LinkedIn reply target is an activity id, urn:li:activity:<id>, or the post's URL" };
  return { ok: true, kind: "reply", ref: id };
}

const postUrl = (activity: string) => `https://www.linkedin.com/feed/update/urn:li:activity:${activity}/`;

/** `sel` inside the post with this activity id (the comment box, its button,
 * its comments): never another post's on the same page. */
export const scoped = (activity: string, sel: string) =>
  sel.split(",").map((p) => `[data-urn="urn:li:activity:${activity}"] ${p.trim()}`).join(", ");

/** Our own update with this text, no older than `since` (ms). */
export function liOwnUpdate(ups: LiUpdate[], me: string, body: string, since: number | null): LiUpdate | null {
  return ups.find((u) => u.author === me && textMatches(body, u.segs)
    && (since === null || (idTimeMs(u.activity, 0n) ?? 0) >= since)) ?? null;
}

/** Our own comment on post `post` with this text, no older than `since` (ms). */
export function liOwnComment(cs: LiComment[], post: string, me: string, body: string, since: number | null): LiComment | null {
  return cs.find((c) => c.post === post && c.author === me && textMatches(body, c.segs)
    && (since === null || (idTimeMs(c.id, 0n) ?? 0) >= since)) ?? null;
}

export function makeLinkedinAdapter(timing: Timing = DEFAULT_TIMING): SiteAdapter {
  const T = timing;
  const html = async (d: BrowserDriver) => parse(await d.html());

  async function signedInAs(d: BrowserDriver): Promise<{ signedIn: boolean; slug: string | null }> {
    await d.goto(FEED);
    const got = await poll(d, T.loadMs, T.stepMs, async () => {
      const a = linkedinAccount(await html(d));
      return a.signedIn && a.slug ? a : null;
    });
    return got ?? linkedinAccount(await html(d));
  }

  async function checkSession(d: BrowserDriver): Promise<SessionState> {
    const a = await signedInAs(d);
    if (!a.signedIn) return { signedIn: false, account: null, detail: "LinkedIn shows no signed-in member" };
    if (!a.slug) return { signedIn: true, account: null, detail: "signed in to LinkedIn, but the profile link was not found" };
    return { signedIn: true, account: a.slug, detail: `signed in to LinkedIn as ${a.slug}` };
  }

  /** The member's own activity, or null when the page did not show it loaded:
   * an empty list counts only beside the empty-state marker. */
  async function ownActivity(d: BrowserDriver, me: string): Promise<LiUpdate[] | null> {
    await d.goto(`https://www.linkedin.com/in/${encodeURIComponent(me)}/recent-activity/all/`);
    const got = await poll(d, T.loadMs, T.stepMs, async () => {
      const doc = await html(d);
      const u = linkedinUpdates(doc);
      if (u.length) return { u };
      return doc.querySelector(S.emptyState) ? { u: [] as LiUpdate[] } : null;
    });
    return got ? got.u : null;
  }

  /** The comments of post `activity`, polled like posts (they load lazily):
   * found ones, or, once the wait is over, none, but only if that post's comment
   * box is on the page (the post loaded). Null when it did not load. */
  async function postComments(d: BrowserDriver, activity: string): Promise<LiComment[] | null> {
    const found = await poll(d, T.loadMs, T.stepMs, async () => {
      const doc = await html(d);
      const u = linkedinUpdates(doc).find((x) => x.activity === activity);
      const cs = u ? linkedinComments(u.el) : [];
      return cs.length ? cs : null;
    });
    if (found) return found;
    const doc = await html(d);
    return doc.querySelector(scoped(activity, S.commentEditor)) ? [] : null;
  }

  function checkEditor(ctx: PostContext, st: EditorState, want: number): PostOutcome | null {
    if (!st.present || !st.button) return refused("no_composer", "no editor or submit button; nothing sent");
    if (!ctx.allowMentions && st.mentions > 0) return refused("mention_link", `the editor holds ${st.mentions} mention(s); nothing sent`);
    if (ctx.allowMentions && st.mentions > findMentions(ctx.body).length) {
      return refused("mention_link", `the editor holds ${st.mentions} mention(s), more than the approved text names; nothing sent`);
    }
    if (normalizeLines(st.text) !== normalizeLines(ctx.body)) return refused("text_mismatch", "the editor does not hold the approved text (line by line); nothing sent");
    if (st.media !== want) return refused("media_count", `the editor shows ${st.media} of ${want} media; nothing sent`);
    if (st.disabled !== false) return refused("button_disabled", "the submit button is disabled; nothing sent");
    return null;
  }

  async function post(ctx: PostContext): Promise<PostOutcome> {
    const d = ctx.driver;
    const me = ctx.account.toLowerCase();
    const want = ctx.media.length;

    const a = await signedInAs(d);
    if (!a.signedIn) return refused("not_signed_in", "LinkedIn shows no signed-in member in this browser profile; nothing sent");
    if (a.slug !== me) {
      return refused("wrong_account", `this browser profile is signed in to LinkedIn as ${a.slug ?? "an unreadable profile"}, not ${me}; nothing sent`);
    }

    if (ctx.target.kind === "post") {
      const ups = await ownActivity(d, me);
      if (!ups) return refused("page_not_loaded", "the profile's activity showed neither posts nor its empty-state marker, so the duplicate check cannot run; nothing sent");
      const dup = liOwnUpdate(ups, me, ctx.body, null);
      if (dup) return refused("duplicate_present", `an identical post by ${me} is already on the profile (activity ${dup.activity}); nothing sent`);
      await d.goto(FEED);
      if (!await poll(d, T.loadMs, T.stepMs, async () => !!(await html(d)).querySelector(S.startPost))) {
        return refused("no_composer", "no 'Start a post' control on the feed; nothing sent");
      }
      await d.click(S.startPost);
      if (!await poll(d, T.loadMs, T.stepMs, async () => !!(await html(d)).querySelector(S.postEditor))) {
        return refused("no_composer", "the share box did not open; nothing sent");
      }
      await d.insertText(S.postEditor, ctx.body);
      if (want) {
        await d.attachFiles(S.addMedia, ctx.media.map((m) => m.path), { viaChooser: true });
        // The media editor asks for a confirm step; it is not the post's submit
        // (the guarded driver refuses it if it ever resolves to one).
        if (await poll(d, T.mediaWaitMs, T.stepMs, async () => !!(await html(d)).querySelector(S.mediaNext))) {
          await d.click(S.mediaNext);
        }
      }
      const st = (await poll(d, want ? T.mediaWaitMs : T.loadMs, T.stepMs, async () => {
        const s = editorState(await html(d), S.postEditor, S.postMediaPreview, S.postSubmit);
        return s.media === want && s.disabled === false ? s : null;
      })) ?? editorState(await html(d), S.postEditor, S.postMediaPreview, S.postSubmit);
      const bad = checkEditor(ctx, st, want);
      if (bad) return bad;

      const since = d.now() - T.sinceSlackMs;
      await ctx.submit(S.postSubmit);
      const closed = !!await poll(d, T.clearWaitMs, T.stepMs, async () => !(await html(d)).querySelector(S.postEditor));
      const rb = await readback(d, T.readbackTries, T.readbackStepMs, async () => {
        const ups = await ownActivity(d, me);
        if (!ups) throw new Error("the profile's activity did not load");
        return liOwnUpdate(ups, me, ctx.body, since);
      }, []);
      if (rb.hit) return { phase: "clicked", state: "posted", ref: postUrl(rb.hit.activity), detail: "read back on the profile's activity" };
      return {
        phase: "clicked", state: "unknown",
        detail: `clicked once; the post was not found on read-back (share box ${closed ? "closed" : "still open"})`
          + (rb.errors.length ? `; read errors: ${rb.errors.join("; ")}` : ""),
      };
    }

    // A comment on one of the member's own posts. Every comment-box selector is
    // scoped to THIS post, whose author is checked below.
    const activity = ctx.target.ref;
    const editorSel = scoped(activity, S.commentEditor);
    const fileSel = scoped(activity, S.commentFileInput);
    const previewSel = scoped(activity, S.commentMediaPreview);
    const submitSel = scoped(activity, S.commentSubmit);
    await d.goto(postUrl(activity));
    const target = await poll(d, T.loadMs, T.stepMs, async () =>
      linkedinUpdates(await html(d)).find((u) => u.activity === activity) ?? null);
    if (!target) return refused("bad_target", `post ${activity} did not load; nothing sent`);
    if (target.author !== me) {
      return refused("not_own_post", `post ${activity} is by ${target.author ?? "an unreadable author"}, not ${me}: v0 comments only on your own posts; nothing sent`);
    }
    const comments = await postComments(d, activity);
    if (!comments) return refused("page_not_loaded", `post ${activity} showed neither comments nor its comment box, so the duplicate check cannot run; nothing sent`);
    const dup = liOwnComment(comments, activity, me, ctx.body, null);
    if (dup) return refused("duplicate_present", `an identical comment by ${me} is already there (comment ${dup.id}); nothing sent`);
    if (!(await html(d)).querySelector(editorSel)) return refused("no_composer", `no comment box under post ${activity}; nothing sent`);
    await d.insertText(editorSel, ctx.body);
    if (want) await d.attachFiles(fileSel, ctx.media.map((m) => m.path));
    const st = (await poll(d, want ? T.mediaWaitMs : T.loadMs, T.stepMs, async () => {
      const s = editorState(await html(d), editorSel, previewSel, submitSel);
      return s.media === want && s.disabled === false ? s : null;
    })) ?? editorState(await html(d), editorSel, previewSel, submitSel);
    const bad = checkEditor(ctx, st, want);
    if (bad) return bad;

    const since = d.now() - T.sinceSlackMs;
    await ctx.submit(submitSel);
    const cleared = !!await poll(d, T.clearWaitMs, T.stepMs, async () => {
      const s = editorState(await html(d), editorSel, previewSel, submitSel);
      return s.present && normalizeWs(s.text) === "" ? s : null;
    });
    const rb = await readback(d, T.readbackTries, T.readbackStepMs, async () => {
      await d.goto(postUrl(activity));
      const cs = await postComments(d, activity);
      if (!cs) throw new Error(`post ${activity} did not load`);
      return liOwnComment(cs, activity, me, ctx.body, since);
    }, []);
    if (rb.hit) {
      const urn = `urn:li:comment:(activity:${activity},${rb.hit.id})`;
      return { phase: "clicked", state: "posted", ref: `${postUrl(activity)}?commentUrn=${encodeURIComponent(urn)}`, detail: "read back under the post" };
    }
    return {
      phase: "clicked", state: "unknown",
      detail: `clicked once; the comment was not found on read-back (comment box ${cleared ? "cleared" : "did not clear"})`
        + (rb.errors.length ? `; read errors: ${rb.errors.join("; ")}` : ""),
    };
  }

  return {
    venue: "linkedin",
    limits: LINKEDIN_LIMITS,
    parseTarget: parseLinkedinTarget,
    checkSession,
    post,
    submitSelectors: [S.postSubmit, S.commentSubmit],
    submitLabels: LINKEDIN_SUBMIT_LABELS,
  };
}
