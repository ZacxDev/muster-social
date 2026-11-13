// A fake browser driver over fake sites. Each site renders HTML shaped like the
// selector table expects (src/sites/selectors.ts) and changes state on the
// driver's actions, so an adapter runs its real parse/check/read-back code
// against it. No network, no real browser.

import type { BrowserDriver } from "../../src/sites/types.ts";
import { X_SELECTORS as XS, LINKEDIN_SELECTORS as LS } from "../../src/sites/selectors.ts";
import { findUrls } from "../../src/text.ts";

export interface FakeSite {
  render(url: string): string;
  goto(url: string): void;
  insertText(url: string, selector: string, text: string): void;
  attach(url: string, selector: string, paths: string[], viaChooser: boolean): void;
  click(url: string, selector: string): void;
}

export class FakeDriver implements BrowserDriver {
  t: number;
  url = "about:blank";
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
  async goto(url: string): Promise<void> {
    this.url = url;
    this.site.goto(url);
  }
  async html(): Promise<string> {
    return this.site.render(this.url);
  }
  async insertText(selector: string, text: string): Promise<void> {
    this.site.insertText(this.url, selector, text);
  }
  async attachFiles(selector: string, paths: string[], opts?: { viaChooser?: boolean }): Promise<void> {
    this.site.attach(this.url, selector, paths, !!opts?.viaChooser);
  }
  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
    if (this.submitSelectors.includes(selector)) {
      if (this.crashOnSubmit) throw this.crashOnSubmit;
      this.submits++;
    }
    this.site.click(this.url, selector);
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  now(): number {
    return this.t;
  }
}

export const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

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
  /** Typed @words become mention links in the composer (X does this). */
  autolinkMentions?: boolean;
  /** Typed bare URLs become profile links (simulates an unexpected tag). */
  injectMentionLink?: boolean;
  /** Only this many attached files show up. */
  attachLimit?: number;
  buttonAlwaysDisabled?: boolean;
  /** Rendered posts show URLs as t.co links with a truncated display. */
  rewriteLinks?: boolean;
  /** Pages show their articles only after this many renders (slow load). */
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
    let inner = esc(this.composer);
    if (this.o.autolinkMentions) inner = inner.replace(/(^|\s)@([A-Za-z0-9_]+)/gu, '$1<a href="/$2">@$2</a>');
    if (this.o.injectMentionLink) inner += ` <a href="/someone">someone</a>`;
    const att = this.attached
      ? `<div data-testid="attachments">${Array.from({ length: this.attached }, () => "<img src='blob:x'>").join("")}</div>` : "";
    const disabled = this.o.buttonAlwaysDisabled || (!this.composer && !this.attached);
    return `<div class="DraftEditor-root"><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">`
      + `<div data-contents="true"><div><span data-text="true">${inner}</span></div></div></div></div>${att}`
      + `<input type="file" data-testid="fileInput" multiple>`
      + `<button type="button" data-testid="tweetButtonInline" aria-disabled="${disabled}">Post</button>`;
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
    } else if (pg.kind === "profile") {
      const list = this.posts.filter((p) => p.author === pg.user && (pg.replies || p.parent === null)).reverse();
      main = list.map((p) => this.article(p)).join("");
    }
    return `<!doctype html><html><body>${nav}<main>${main}</main></body></html>`;
  }

  insertText(_url: string, selector: string, text: string): void {
    if (selector !== XS.composer) throw new Error(`fake X: insertText into ${selector}`);
    this.composer += this.o.mangle ? this.o.mangle(text) : text;
  }

  attach(_url: string, selector: string, paths: string[]): void {
    if (selector !== XS.fileInput) throw new Error(`fake X: attach to ${selector}`);
    this.attached += Math.min(paths.length, this.o.attachLimit ?? paths.length);
  }

  click(url: string, selector: string): void {
    if (selector !== XS.submit) return;
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
  attachLimit?: number;
  /** Posted text shows URLs as lnkd.in links. */
  rewriteLinks?: boolean;
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

  private update(p: LiPost): string {
    const media = Array.from({ length: p.media }, () => `<div class="update-components-image"><img src="x"></div>`).join("");
    return `<div class="feed-shared-update-v2" data-urn="urn:li:activity:${p.activity}">`
      + `<a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/${p.author}?miniProfileUrn=x">${esc(p.author)}</a>`
      + `<div class="update-components-text"><span dir="ltr">${this.textHtml(p.text)}</span></div>${media}</div>`;
  }

  private comment(c: LiCommentRow): string {
    return `<article class="comments-comment-entity" data-id="urn:li:comment:(activity:${c.post},${c.id})">`
      + `<a class="comments-comment-meta__description-container" href="/in/${c.author}/">${esc(c.author)}</a>`
      + `<div class="comments-comment-item__main-content"><span dir="ltr">${this.textHtml(c.text)}</span></div></article>`;
  }

  render(url: string): string {
    const p = new URL(url).pathname;
    const me = this.o.account;
    const nav = me ? `<header><div class="global-nav__me"><img alt="Me"></div></header>` : `<header><a href="/login">Sign in</a></header>`;
    let main = "";
    if (p === "/feed/" && me) {
      main = (this.o.hideProfileLink ? "" : `<div class="feed-identity-module"><a href="https://www.linkedin.com/in/${me}/">Me</a></div>`)
        + `<button class="share-box-feed-entry__trigger">Start a post</button>`;
      if (this.shareOpen) {
        const preview = `<div class="share-creation-state__media-preview">${Array.from({ length: this.media }, () => "<img src='blob:x'>").join("")}</div>`;
        const next = this.pendingMedia ? `<button class="share-box-footer__primary-btn">Next</button>` : "";
        const disabled = !this.editor.trim() || this.pendingMedia > 0;
        main += `<div role="dialog"><div class="share-creation-state__text-editor"><div class="ql-editor" contenteditable="true"><p>${esc(this.editor)}</p></div></div>`
          + `${preview}<button aria-label="Add media">Add media</button>${next}`
          + `<button class="share-actions__primary-action"${disabled ? " disabled" : ""}>Post</button></div>`;
      }
    } else if (/^\/in\/[^/]+\/recent-activity\/all\/$/u.test(p) && me) {
      const slug = p.split("/")[2];
      main = this.posts.filter((x) => x.author === slug).reverse().map((x) => this.update(x)).join("");
    } else {
      const m = /^\/feed\/update\/urn:li:activity:(\d+)\/$/u.exec(p);
      const post = m ? this.posts.find((x) => x.activity === m[1]) : undefined;
      if (post && me) {
        const cs = this.comments.filter((c) => c.post === post.activity).map((c) => this.comment(c)).join("");
        const preview = this.commentMedia ? `<img class="comments-comment-box__image-preview" src="blob:x">` : "";
        main = this.update(post) + `<div class="comments-comment-box"><div class="comments-comment-texteditor"><div class="ql-editor" contenteditable="true"><p>${esc(this.commentEditor)}</p></div></div>`
          + `<input type="file" accept="image/*">${preview}`
          + `<button class="comments-comment-box__submit-button"${this.commentEditor.trim() ? "" : " disabled"}>Comment</button></div>` + cs;
      }
    }
    return `<!doctype html><html><body>${nav}<main>${main}</main></body></html>`;
  }

  insertText(_url: string, selector: string, text: string): void {
    const t = this.o.mangle ? this.o.mangle(text) : text;
    if (selector === LS.postEditor) this.editor += t;
    else if (selector === LS.commentEditor) this.commentEditor += t;
    else throw new Error(`fake LinkedIn: insertText into ${selector}`);
  }

  attach(_url: string, selector: string, paths: string[], viaChooser: boolean): void {
    const n = Math.min(paths.length, this.o.attachLimit ?? paths.length);
    if (selector === LS.addMedia && viaChooser) this.pendingMedia = n;
    else if (selector === LS.commentFileInput && !viaChooser) this.commentMedia = n;
    else throw new Error(`fake LinkedIn: attach to ${selector} (chooser ${viaChooser})`);
  }

  click(url: string, selector: string): void {
    const p = new URL(url).pathname;
    if (selector === LS.startPost) {
      this.shareOpen = true;
      return;
    }
    if (selector === LS.mediaNext) {
      this.media = this.pendingMedia;
      this.pendingMedia = 0;
      return;
    }
    const behaviour = this.o.onSubmit ?? "post";
    const me = this.o.account ?? "?";
    if (selector === LS.postSubmit) {
      if (behaviour === "noop") return;
      const text = this.editor;
      const media = this.media;
      this.shareOpen = false;
      this.editor = "";
      this.media = 0;
      if (behaviour === "post") this.posts.push({ activity: timeId(this.o.clock(), 0), author: me, text, media });
      return;
    }
    if (selector === LS.commentSubmit) {
      if (behaviour === "noop") return;
      const m = /urn:li:activity:(\d+)/u.exec(p);
      const text = this.commentEditor;
      this.commentEditor = "";
      this.commentMedia = 0;
      if (behaviour === "post" && m) this.comments.push({ post: m[1] ?? "", id: timeId(this.o.clock(), 0), author: me, text });
    }
  }
}
