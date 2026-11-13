// The seam between the poster and a site: a small browser driver (real one in
// src/browser/playwright.ts, fake one in the tests) and the per-site adapter.

export type Venue = "x" | "linkedin";

export const VENUES: readonly Venue[] = ["x", "linkedin"];

export function isVenue(v: string): v is Venue {
  return (VENUES as readonly string[]).includes(v);
}

/** What a site adapter may do to a page. Every read is html(): the page's
 * serialised DOM, parsed by the adapter (src/sites/dom.ts). */
export interface BrowserDriver {
  goto(url: string): Promise<void>;
  html(): Promise<string>;
  /** Focus the element and insert `text` as typed input. */
  insertText(selector: string, text: string): Promise<void>;
  /** Attach files: set them on a file input, or (viaChooser) click a trigger
   * and answer the file chooser it opens. */
  attachFiles(selector: string, paths: string[], opts?: { viaChooser?: boolean }): Promise<void>;
  /** One trusted click on the first visible match. */
  click(selector: string): Promise<void>;
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
  /** Selectors of the irreversible submit controls (the guarded driver refuses
   * a plain click on any of them). */
  submitSelectors: readonly string[];
}

export function refused(code: RefusalCode, detail: string): Refused {
  return { phase: "refused", code, detail };
}
