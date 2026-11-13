// The seam between the poster and a site: a small browser driver (real one in
// src/browser/playwright.ts, fake one in the tests) and the per-site adapter.

export type Venue = "x" | "linkedin";

export const VENUES: readonly Venue[] = ["x", "linkedin"];

export function isVenue(v: string): v is Venue {
  return (VENUES as readonly string[]).includes(v);
}

/** Checks the driver runs on the RESOLVED element, in the page, immediately
 * before acting on it (src/sites/target.ts). */
export interface ActionGuard {
  /** Refuse an element that matches, sits inside, or contains any of these. */
  forbid?: readonly string[];
  /** Refuse an element inside a button whose text or aria-label is one of these
   * (lower-case, exact), or a submit-type button. */
  labels?: readonly string[];
  /** Refuse an element that does not itself match one of these. */
  require?: readonly string[];
}

export interface ActionOpts {
  guard?: ActionGuard;
  /** Runs after the element is resolved and passed the guard, and before the
   * action: the gate's journal record goes here, so record and click concern
   * the same element. A throw here cancels the action. */
  beforeAct?: () => unknown;
}

/** A driver action refused because of what its target element is. */
export class ForbiddenTarget extends Error {}

/** What a site adapter may do to a page. Every read is html(): the page's
 * serialised DOM, parsed by the adapter (src/sites/dom.ts). Every action
 * resolves its selector to ONE element first and acts on that element. */
export interface BrowserDriver {
  goto(url: string): Promise<void>;
  html(): Promise<string>;
  /** Click the element, then insert `text` as typed input. */
  insertText(selector: string, text: string, opts?: ActionOpts): Promise<void>;
  /** Attach files: set them on a file input, or (viaChooser) click a trigger
   * and answer the file chooser it opens. */
  attachFiles(selector: string, paths: string[], opts?: ActionOpts & { viaChooser?: boolean }): Promise<void>;
  /** One trusted click on the first match. */
  click(selector: string, opts?: ActionOpts): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type TargetKind = "post" | "reply";

export interface OutboundTarget {
  kind: string;
  ref: string;
}

/** A medium ready to attach: the bytes were hashed and written to `path` by the
 * plugin itself, so what is attached is what was approved. */
export interface LocalMedia {
  ref: string;
  path: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface SiteLimits {
  /** Body length limit for a new post and for a reply. */
  maxLength: { post: number; reply: number };
  /** How length is counted. */
  lengthRule: "x-weighted" | "code-points";
  /** Media types accepted for a post and for a reply. */
  mediaTypes: { post: readonly string[]; reply: readonly string[] };
  maxImages: { post: number; reply: number };
  maxVideos: { post: number; reply: number };
  /** May images and a video share one post? */
  mixMedia: boolean;
  /** May a body be empty when there are media? */
  emptyBodyWithMedia: boolean;
  /** Byte caps per medium kind. */
  maxImageBytes: number;
  maxVideoBytes: number;
}

/** The single gate to the irreversible click. The poster builds it: it writes
 * the attempt journal's `open` record (fsync) and then clicks, once. A second
 * call throws. An adapter has no other way to click a submit control. */
export type SubmitGate = (selector: string) => Promise<void>;

export interface PostContext {
  driver: BrowserDriver;
  body: string;
  media: LocalMedia[];
  target: { kind: TargetKind; ref: string };
  /** The account the owner configured for this site. */
  account: string;
  submit: SubmitGate;
  allowMentions: boolean;
  log: (msg: string) => void;
}

/** Why nothing was sent: the click never happened. */
export interface Refused {
  phase: "refused";
  code: RefusalCode;
  detail: string;
}

/** After the click only two outcomes exist. */
export interface Clicked {
  phase: "clicked";
  state: "posted" | "unknown";
  /** For posted: the post's URL (reported as external_ref). */
  ref?: string;
  detail: string;
}

export type PostOutcome = Refused | Clicked;

export type RefusalCode =
  | "not_signed_in"
  | "wrong_account"
  | "bad_target"
  | "not_own_post"
  | "no_composer"
  | "text_mismatch"
  | "mention_link"
  | "media_count"
  | "button_disabled"
  | "duplicate_present"
  | "page_not_loaded"
  | "attach_failed";

export interface SessionState {
  signedIn: boolean;
  account: string | null;
  detail: string;
}

export interface SiteAdapter {
  venue: Venue;
  limits: SiteLimits;
  /** Parse a target's ref into the site's id; null with a reason if malformed. */
  parseTarget(t: OutboundTarget): { ok: true; kind: TargetKind; ref: string } | { ok: false; detail: string };
  /** Load the site and report who is signed in. Never types or clicks. */
  checkSession(driver: BrowserDriver): Promise<SessionState>;
  /** Post one approved draft. Every check before the gate; read-back after. */
  post(ctx: PostContext): Promise<PostOutcome>;
  /** Selectors of the irreversible submit controls. Outside the gate, no driver
   * action may touch an element that is, contains or sits inside one. */
  submitSelectors: readonly string[];
  /** Labels (lower-case, exact) of the site's post/reply/comment buttons: an
   * element inside a button with one of these is refused outside the gate too. */
  submitLabels: readonly string[];
}

export function refused(code: RefusalCode, detail: string): Refused {
  return { phase: "refused", code, detail };
}
