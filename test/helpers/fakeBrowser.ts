// A fake browser driver over fake sites. Each site renders HTML shaped like the
// selector table expects (src/sites/selectors.ts) and changes state on the
// driver's actions, so an adapter runs its real parse/check/read-back code
// against it. Like the real driver, every action first resolves its selector
// to ONE element of the current page, runs the guard on that element
// (src/sites/target.ts, the same function the real driver ships into the
// page), runs beforeAct, and only then acts on that element. The fake sites
// decide what an action does from the ELEMENT (el.matches), never from the
// selector's spelling. No network, no real browser.

import { parse, type El } from "../../src/sites/dom.ts";
import { ForbiddenTarget, type ActionOpts, type BrowserDriver } from "../../src/sites/types.ts";
import { guardArg, targetProblem } from "../../src/sites/target.ts";
import { X_SELECTORS as XS, LINKEDIN_SELECTORS as LS } from "../../src/sites/selectors.ts";
import { findUrls } from "../../src/text.ts";

/** A resolved element, as the fake sites see it. */
export interface FakeEl {
  matches(sel: string): boolean;
  closest(sel: string): FakeEl | null;
  getAttribute(name: string): string | null;
}

export interface FakeSite {
  render(url: string): string;
  goto(url: string): void;
  insertText(url: string, el: FakeEl, text: string): void;
  attach(url: string, el: FakeEl, paths: string[], viaChooser: boolean): void;
  click(url: string, el: FakeEl): void;
}

export class FakeDriver implements BrowserDriver {
  t: number;
  url = "about:blank";
  /** Every element action that reached the site: [kind, selector]. */
  actions: [string, string][] = [];
  clicks: string[] = [];
  submits = 0;
  readonly site: FakeSite;
  readonly submitSelectors: readonly string[];
  /** Throw this from the next click on a submit control instead of clicking. */
  crashOnSubmit: Error | null = null;

  constructor(site: FakeSite, submitSelectors: readonly string[], startMs = Date.UTC(2026, 0, 2, 3, 4, 5)) {
    this.site = site;
    this.submitSelectors = submitSelectors;
    this.t = startMs;
  }

  private async resolve(selector: string, opts?: ActionOpts): Promise<FakeEl> {
    const doc = parse(this.site.render(this.url));
    const el = doc.querySelector(selector) as unknown as (Element & FakeEl) | null;
    if (!el) throw new Error(`no element matches ${selector}`);
    if (opts?.guard) {
      const problem = targetProblem(el, guardArg(opts.guard));
      if (problem) throw new ForbiddenTarget(`${selector}: ${problem}`);
    }
    if (opts?.beforeAct) await opts.beforeAct();
    return el;
  }

  private isSubmit(el: FakeEl): boolean {
    return this.submitSelectors.some((s) => el.matches(s));
  }

  async goto(url: string): Promise<void> {
    this.url = url;
    this.site.goto(url);
  }
  async html(): Promise<string> {
    return this.site.render(this.url);
  }
  async insertText(selector: string, text: string, opts?: ActionOpts): Promise<void> {
    const el = await this.resolve(selector, opts);
    this.actions.push(["insertText", selector]);
    if (this.isSubmit(el)) this.submits++; // insertText clicks its target first
    this.site.click(this.url, el);
    this.site.insertText(this.url, el, text);
  }
  async attachFiles(selector: string, paths: string[], opts?: ActionOpts & { viaChooser?: boolean }): Promise<void> {
    const el = await this.resolve(selector, opts);
    this.actions.push(["attachFiles", selector]);
    if (opts?.viaChooser) {
      if (this.isSubmit(el)) this.submits++; // the chooser trigger is clicked
      this.site.click(this.url, el);
    }
    this.site.attach(this.url, el, paths, !!opts?.viaChooser);
  }
  async click(selector: string, opts?: ActionOpts): Promise<void> {
    const el = await this.resolve(selector, opts);
    this.actions.push(["click", selector]);
    this.clicks.push(selector);
    if (this.isSubmit(el)) {
      if (this.crashOnSubmit) throw this.crashOnSubmit;
      this.submits++;
    }
    this.site.click(this.url, el);
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  now(): number {
    return this.t;
  }
}

export const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

/** Editor markup for text: one block per line, an empty line as a block with a
 * <br>, as Draft.js (`div`) and Quill (`p`) render it. */
export function blocks(text: string, tag: "div" | "p", inline: (line: string) => string = esc): string {
  if (text === "") return `<${tag}><br></${tag}>`;
  return text.split("\n").map((l) => (l === "" ? `<${tag}><br></${tag}>` : `<${tag}><span>${inline(l)}</span></${tag}>`)).join("");
}

/** Time-ordered id: milliseconds since `epoch` shifted left 22. */
export function timeId(ms: number, epoch: number): string {
  return ((BigInt(ms - epoch) << 22n) + 7n).toString();
}

// ---- X ----------------------------------------------------------------------

export const X_EPOCH = 1288834974657;

export interface XPost {
  id: string;
  author: string;
  text: string;
  media: number;
  parent: string | null;
}

export interface FakeXOptions {
  account: string | null;
  posts?: XPost[];
  /** What the submit click does. */
  onSubmit?: "post" | "drop" | "noop";
  /** The editor changes what was typed (autocorrect, a dropped character…). */
  mangle?: (t: string) => string;
  /** The editor merges typed line breaks into spaces. */
  mergeLines?: boolean;
  /** Typed @words become mention links in the composer (X does this). */
  autolinkMentions?: boolean;
  /** A stray profile link appears in the composer (an unexpected tag). */
  injectMentionLink?: boolean;
  /** Only this many attached files show up. */
  attachLimit?: number;
  buttonAlwaysDisabled?: boolean;
  /** Rendered posts show URLs as t.co links with a truncated display. */
  rewriteLinks?: boolean;
  /** Profile pages render nothing (no posts, no empty-state marker). */
  brokenProfile?: boolean;
  clock: () => number;
}

export class FakeX implements FakeSite {
  o: FakeXOptions;
  posts: XPost[];
  composer = "";
  attached = 0;

  constructor(o: FakeXOptions) {
    this.o = o;
    this.posts = [...(o.posts ?? [])];
  }

  goto(): void {
    this.composer = "";
    this.attached = 0;
  }

  private page(url: string): { kind: "home" } | { kind: "status"; id: string } | { kind: "profile"; user: string; replies: boolean } | { kind: "other" } {
    const p = new URL(url).pathname;
    if (p === "/home") return { kind: "home" };
    let m = /^\/(?:i|[A-Za-z0-9_]+)\/status\/(\d+)$/u.exec(p);
    if (m) return { kind: "status", id: m[1] ?? "" };
    m = /^\/([A-Za-z0-9_]+)(\/with_replies)?$/u.exec(p);
    if (m) return { kind: "profile", user: m[1] ?? "", replies: !!m[2] };
    return { kind: "other" };
  }

  private textHtml(t: string): string {
    if (!this.o.rewriteLinks) return esc(t);
    let out = "";
    let at = 0;
    for (const u of findUrls(t)) {
      out += esc(t.slice(at, u.start));
      const bare = u.url.replace(/^https?:\/\//u, "");
      const shown = bare.length > 15 ? bare.slice(0, 15) : bare;
      out += `<a href="https://t.co/abc${at}" rel="nofollow"><span aria-hidden="true">https://</span>${esc(shown)}<span aria-hidden="true">${esc(bare.slice(shown.length))}</span>${bare.length > 15 ? "<span>…</span>" : ""}</a>`;
      at = u.end;
    }
    return out + esc(t.slice(at));
  }

  private article(p: XPost): string {
    const media = Array.from({ length: p.media }, () => `<div data-testid="tweetPhoto"><img alt="Image" src="x"></div>`).join("");
    return `<article role="article"><div><a href="/${p.author}">${esc(p.author)}</a>`
      + `<a href="/${p.author}/status/${p.id}"><time datetime="2026-01-01T00:00:00Z">1m</time></a></div>`
      + `<div data-testid="tweetText" lang="en">${this.textHtml(p.text)}</div>${media}</article>`;
  }

  private composerHtml(): string {
    const inline = (l: string) => {
      let h = esc(l);
      if (this.o.autolinkMentions) h = h.replace(/(^|\s)@([A-Za-z0-9_]+)/gu, '$1<a href="/$2">@$2</a>');
      return h;
    };
    let inner = blocks(this.composer, "div", inline);
    if (this.o.injectMentionLink) inner += `<div><a href="/someone">someone</a></div>`;
    const att = this.attached
      ? `<div data-testid="attachments">${Array.from({ length: this.attached }, () => "<img src='blob:x'>").join("")}</div>` : "";
    const disabled = this.o.buttonAlwaysDisabled || (!this.composer && !this.attached);
    return `<div class="DraftEditor-root"><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">`
      + `<div data-contents="true">${inner}</div></div></div>${att}`
      + `<input type="file" data-testid="fileInput" multiple>`
      + `<button type="button" data-testid="tweetButtonInline" aria-disabled="${disabled}"><span>Post</span></button>`;
  }

  render(url: string): string {
    const nav = this.o.account ? `<nav><a data-testid="AppTabBar_Profile_Link" href="/${this.o.account}">Profile</a></nav>` : `<nav><a href="/login">Log in</a></nav>`;
    const pg = this.page(url);
    let main = "";
    if (pg.kind === "home") {
      main = this.o.account ? this.composerHtml() : "";
    } else if (pg.kind === "status") {
      const parent = this.posts.find((p) => p.id === pg.id);
      if (parent) {
        const replies = this.posts.filter((p) => p.parent === pg.id);
        main = this.article(parent) + (this.o.account ? this.composerHtml() : "") + replies.map((r) => this.article(r)).join("");
      }
    } else if (pg.kind === "profile" && !this.o.brokenProfile) {
      const list = this.posts.filter((p) => p.author === pg.user && (pg.replies || p.parent === null)).reverse();
      main = list.length ? list.map((p) => this.article(p)).join("") : `<div data-testid="emptyState">Nothing here yet</div>`;
    }
    return `<!doctype html><html><body>${nav}<main>${main}</main></body></html>`;
  }

  insertText(_url: string, el: FakeEl, text: string): void {
    if (!el.matches(XS.composer)) throw new Error("fake X: typing outside the composer");
    let t = this.o.mangle ? this.o.mangle(text) : text;
    if (this.o.mergeLines) t = t.replace(/\n+/gu, " ");
    this.composer += t;
  }

  attach(_url: string, el: FakeEl, paths: string[]): void {
    if (!el.matches(XS.fileInput)) throw new Error("fake X: attaching outside the file input");
    this.attached += Math.min(paths.length, this.o.attachLimit ?? paths.length);
  }

  click(url: string, el: FakeEl): void {
    if (!el.closest(XS.submit)) return;
    const behaviour = this.o.onSubmit ?? "post";
    if (behaviour === "noop") return;
    const pg = this.page(url);
    const text = this.composer;
    const media = this.attached;
    this.composer = "";
    this.attached = 0;
    if (behaviour === "drop") return;
    this.posts.push({
      id: timeId(this.o.clock(), X_EPOCH), author: this.o.account ?? "?", text, media,
      parent: pg.kind === "status" ? pg.id : null,
    });
  }
}

// ---- LinkedIn -----------------------------------------------------------------

export interface LiPost {
  activity: string;
  author: string;
  text: string;
  media: number;
}

export interface LiCommentRow {
  post: string;
  id: string;
  author: string;
  text: string;
}

export interface FakeLinkedinOptions {
  account: string | null;
  /** Shows the signed-in marker but no profile link (an unreadable account). */
  hideProfileLink?: boolean;
  posts?: LiPost[];
  comments?: LiCommentRow[];
  onSubmit?: "post" | "drop" | "noop";
  mangle?: (t: string) => string;
  mergeLines?: boolean;
  attachLimit?: number;
  /** Posted text shows URLs as lnkd.in links. */
  rewriteLinks?: boolean;
  /** The activity page renders nothing (no posts, no empty-state marker). */
  brokenActivity?: boolean;
  /** Comments appear only after this many renders of the post page. */
  commentsAfterRenders?: number;
  /** The media editor's confirm button is really the share box's Post button. */
  mediaNextIsPost?: "same-class" | "labelled-post";
  clock: () => number;
}

export class FakeLinkedin implements FakeSite {
  o: FakeLinkedinOptions;
  posts: LiPost[];
  comments: LiCommentRow[];
  shareOpen = false;
  editor = "";
  pendingMedia = 0;
  media = 0;
  commentEditor = "";
  commentMedia = 0;
  commentFor = "";
  renders = 0;

  constructor(o: FakeLinkedinOptions) {
    this.o = o;
    this.posts = [...(o.posts ?? [])];
    this.comments = [...(o.comments ?? [])];
  }

  goto(): void {
    this.shareOpen = false;
    this.editor = "";
    this.media = 0;
    this.pendingMedia = 0;
    this.commentEditor = "";
    this.commentMedia = 0;
    this.renders = 0;
  }

  private textHtml(t: string): string {
    if (!this.o.rewriteLinks) return esc(t);
    let out = "";
    let at = 0;
    for (const u of findUrls(t)) {
      out += esc(t.slice(at, u.start)) + `<a href="https://lnkd.in/g${at}x">lnkd.in/g${at}x</a>`;
      at = u.end;
    }
    return out + esc(t.slice(at));
  }

  private update(p: LiPost, inner = ""): string {
    const media = Array.from({ length: p.media }, () => `<div class="update-components-image"><img src="x"></div>`).join("");
    return `<div class="feed-shared-update-v2" data-urn="urn:li:activity:${p.activity}">`
      + `<a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/${p.author}?miniProfileUrn=x">${esc(p.author)}</a>`
      + `<div class="update-components-text"><span dir="ltr">${this.textHtml(p.text)}</span></div>${media}${inner}</div>`;
  }

  private comment(c: LiCommentRow): string {
    return `<article class="comments-comment-entity" data-id="urn:li:comment:(activity:${c.post},${c.id})">`
      + `<a class="comments-comment-meta__description-container" href="/in/${c.author}/">${esc(c.author)}</a>`
      + `<div class="comments-comment-item__main-content"><span dir="ltr">${this.textHtml(c.text)}</span></div></article>`;
  }

  private shareBox(): string {
    const preview = `<div class="share-creation-state__media-preview">${Array.from({ length: this.media }, () => "<img src='blob:x'>").join("")}</div>`;
    let mediaEditor = "";
    if (this.pendingMedia) {
      const next = this.o.mediaNextIsPost === "same-class"
        ? `<button class="share-box-footer__primary-btn share-actions__primary-action">Post</button>`
        : this.o.mediaNextIsPost === "labelled-post"
          ? `<button class="share-box-footer__primary-btn">Post</button>`
          : `<button class="share-box-footer__primary-btn">Next</button>`;
      mediaEditor = `<div class="share-media-editor">${next}</div>`;
    }
    const disabled = !this.editor.trim() || this.pendingMedia > 0;
    return `<div role="dialog"><div class="share-creation-state__text-editor"><div class="ql-editor" contenteditable="true">${blocks(this.editor, "p")}</div></div>`
      + `${preview}<button aria-label="Add media">Add media</button>${mediaEditor}`
      + `<div class="share-box-footer"><button class="share-actions__primary-action"${disabled ? " disabled" : ""}>Post</button></div></div>`;
  }

  render(url: string): string {
    const p = new URL(url).pathname;
    const me = this.o.account;
    const nav = me ? `<header><div class="global-nav__me"><img alt="Me"></div></header>` : `<header><a href="/login">Sign in</a></header>`;
    let main = "";
    if (p === "/feed/" && me) {
      main = (this.o.hideProfileLink ? "" : `<div class="feed-identity-module"><a href="https://www.linkedin.com/in/${me}/">Me</a></div>`)
        + `<button class="share-box-feed-entry__trigger">Start a post</button>`;
      if (this.shareOpen) main += this.shareBox();
    } else if (/^\/in\/[^/]+\/recent-activity\/all\/$/u.test(p) && me && !this.o.brokenActivity) {
      const slug = p.split("/")[2];
      const list = this.posts.filter((x) => x.author === slug).reverse();
      main = list.length ? list.map((x) => this.update(x)).join("") : `<div class="artdeco-empty-state">No activity yet</div>`;
    } else {
      const m = /^\/feed\/update\/urn:li:activity:(\d+)\/$/u.exec(p);
      const post = m ? this.posts.find((x) => x.activity === m[1]) : undefined;
      if (post && me) {
        this.renders++;
        const showComments = this.renders > (this.o.commentsAfterRenders ?? 0);
        const cs = showComments ? this.comments.filter((c) => c.post === post.activity).map((c) => this.comment(c)).join("") : "";
        const mine = this.commentFor === post.activity;
        const preview = mine && this.commentMedia ? `<img class="comments-comment-box__image-preview" src="blob:x">` : "";
        const text = mine ? this.commentEditor : "";
        const box = `<div class="comments-comment-box"><div class="comments-comment-texteditor"><div class="ql-editor" contenteditable="true">${blocks(text, "p")}</div></div>`
          + `<input type="file" accept="image/*">${preview}`
          + `<button class="comments-comment-box__submit-button"${text.trim() ? "" : " disabled"}>Comment</button></div>`;
        // A second post on the page, with its own comment box first in the
        // document: a comment-box selector not scoped to the target post would
        // reach this one instead.
        const decoy = this.posts.find((x) => x.activity !== post.activity && x.author !== post.author);
        const decoyHtml = decoy ? this.update(decoy, `<div class="comments-comment-box"><div class="comments-comment-texteditor"><div class="ql-editor" contenteditable="true"><p><br></p></div></div><button class="comments-comment-box__submit-button" disabled>Comment</button></div>`) : "";
        main = decoyHtml + this.update(post, box + cs);
      }
    }
    return `<!doctype html><html><body>${nav}<main>${main}</main></body></html>`;
  }

  private activityOf(el: FakeEl): string {
    const u = el.closest("[data-urn]");
    return /urn:li:activity:(\d+)/u.exec(u?.getAttribute("data-urn") ?? "")?.[1] ?? "";
  }

  insertText(_url: string, el: FakeEl, text: string): void {
    let t = this.o.mangle ? this.o.mangle(text) : text;
    if (this.o.mergeLines) t = t.replace(/\n+/gu, " ");
    if (el.matches(LS.postEditor)) this.editor += t;
    else if (el.matches(LS.commentEditor)) {
      this.commentFor = this.activityOf(el);
      this.commentEditor += t;
    } else throw new Error("fake LinkedIn: typing outside an editor");
  }

  attach(_url: string, el: FakeEl, paths: string[], viaChooser: boolean): void {
    const n = Math.min(paths.length, this.o.attachLimit ?? paths.length);
    if (el.matches(LS.addMedia) && viaChooser) this.pendingMedia = n;
    else if (el.matches(LS.commentFileInput) && !viaChooser) {
      this.commentFor = this.activityOf(el);
      this.commentMedia = n;
    } else throw new Error("fake LinkedIn: attaching to the wrong element");
  }

  click(url: string, el: FakeEl): void {
    const p = new URL(url).pathname;
    if (el.matches(LS.startPost)) {
      this.shareOpen = true;
      return;
    }
    const behaviour = this.o.onSubmit ?? "post";
    const me = this.o.account ?? "?";
    if (el.closest(LS.postSubmit)) {
      if (behaviour === "noop") return;
      const text = this.editor;
      const media = this.media;
      this.shareOpen = false;
      this.editor = "";
      this.media = 0;
      if (behaviour === "post") this.posts.push({ activity: timeId(this.o.clock(), 0), author: me, text, media });
      return;
    }
    if (el.matches(LS.mediaNext)) {
      this.media = this.pendingMedia;
      this.pendingMedia = 0;
      return;
    }
    if (el.closest(LS.commentSubmit)) {
      if (behaviour === "noop") return;
      const m = /urn:li:activity:(\d+)/u.exec(p);
      const post = this.activityOf(el) || (m?.[1] ?? "");
      const text = this.commentFor === post ? this.commentEditor : "";
      this.commentEditor = "";
      this.commentMedia = 0;
      if (behaviour === "post") this.comments.push({ post, id: timeId(this.o.clock(), 0), author: me, text });
    }
  }
}
