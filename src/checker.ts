// draft_checks: before the owner can approve a pending draft, say whether this
// plugin can send it. A rule the draft breaks is a refusal (its detail goes
// back to the officer to fix). A condition only the owner can fix (the browser
// is signed out, or not reachable) is NOT a refusal: the verdict waits, and the
// draft waits with it (an outbound draft's check never lapses).

import { resolveRef, type ResolvedMedia } from "./media.ts";
import { checkDraft, describe } from "./rules.ts";
import type { AwaitingCheck } from "./muster/client.ts";
import { MusterError } from "./muster/client.ts";
import type { DriverSession } from "./poster.ts";
import type { SiteConfig } from "./config.ts";
import { isVenue, type SessionState, type SiteAdapter, type Venue } from "./sites/types.ts";

export interface CheckClient {
  checks(): Promise<AwaitingCheck[]>;
  check(id: number, v: { sendable: boolean; detail?: string }): Promise<{ status: string; check: string }>;
  uploadMedia(id: number, ref: string, bytes: Uint8Array, contentType: string, sha256: string): Promise<{ status: number; sha256: string }>;
}

export interface CheckerDeps {
  client: CheckClient;
  adapters: Partial<Record<Venue, SiteAdapter>>;
  sites: Partial<Record<Venue, SiteConfig>>;
  mediaRoot: string;
  checkSession: boolean;
  openDriver: (venue: Venue) => Promise<DriverSession>;
  now: () => number;
  log: (msg: string) => void;
  /** How long a session check result is reused. */
  sessionTtlMs?: number;
}

export type Verdict =
  | { draftId: number; verdict: "sendable" }
  | { draftId: number; verdict: "refused"; detail: string }
  | { draftId: number; verdict: "deferred"; detail: string };

export class Checker {
  private readonly d: CheckerDeps;
  private readonly sessions = new Map<Venue, { at: number; state: SessionState }>();

  constructor(deps: CheckerDeps) {
    this.d = deps;
  }

  async runOnce(): Promise<Verdict[]> {
    const list = await this.d.client.checks();
    const out: Verdict[] = [];
    for (const a of list) {
      const v = await this.evaluate(a);
      if (v.verdict === "deferred") {
        this.d.log(`draft ${a.draft_id}: check deferred: ${v.detail}`);
      } else {
        try {
          await this.d.client.check(a.draft_id, v.verdict === "sendable" ? { sendable: true } : { sendable: false, detail: v.detail });
          this.d.log(`draft ${a.draft_id}: check ${v.verdict}${v.verdict === "refused" ? `: ${v.detail}` : ""}`);
        } catch (e) {
          if (e instanceof MusterError && e.kind === "conflict") this.d.log(`draft ${a.draft_id}: verdict not taken: ${e.message}`);
          else throw e;
        }
      }
      out.push(v);
    }
    return out;
  }

  async evaluate(a: AwaitingCheck): Promise<Verdict> {
    const id = a.draft_id;
    if (a.kind !== "outbound") {
      return { draftId: id, verdict: "refused", detail: "this plugin sends only outbound drafts (a post or a reply an officer filed), not replies to messages" };
    }
    const venue = String(a.venue ?? "");
    const adapter = isVenue(venue) ? this.d.adapters[venue] : undefined;
    const site = isVenue(venue) ? this.d.sites[venue] : undefined;
    const refs = a.media ?? [];

    // Resolve every ref on this machine first: the rules need each medium's type and size.
    const local: ResolvedMedia[] = [];
    for (const m of refs) {
      const r = resolveRef(this.d.mediaRoot, m.ref);
      if (!r.ok) return { draftId: id, verdict: "refused", detail: r.detail };
      local.push(r.media);
    }
    const vs = checkDraft(
      { venue, target: a.target ?? { kind: "", ref: "" }, body: a.body, media: local.map((m) => ({ ref: m.ref, contentType: m.contentType, size: m.size })) },
      adapter, site && { enabled: site.enabled, allowMentions: site.allow_mentions, ...(site.max_length ? { maxLength: site.max_length } : {}) },
    );
    if (vs.length) return { draftId: id, verdict: "refused", detail: describe(vs) };

    // Upload each medium's bytes (muster shows them to the owner and binds the
    // approval to their hashes). Bytes already uploaded must be ours.
    for (let i = 0; i < refs.length; i++) {
      const m = refs[i] as NonNullable<AwaitingCheck["media"]>[number];
      const l = local[i] as ResolvedMedia;
      if (m.uploaded) {
        if (m.sha256 !== l.sha256) {
          return { draftId: id, verdict: "refused", detail: `${m.ref}: the bytes muster holds are not the file on this machine (sha256 ${m.sha256} vs ${l.sha256})` };
        }
        continue;
      }
      try {
        await this.d.client.uploadMedia(id, m.ref, l.bytes, l.contentType, l.sha256);
      } catch (e) {
        if (e instanceof MusterError && (e.kind === "bad_request" || e.kind === "too_large" || e.kind === "conflict")) {
          return { draftId: id, verdict: "refused", detail: `${m.ref}: muster refused the upload: ${e.message}` };
        }
        return { draftId: id, verdict: "deferred", detail: `${m.ref}: upload failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    if (this.d.checkSession && adapter && site && isVenue(venue)) {
      const s = await this.session(venue, adapter);
      if (!s.signedIn) return { draftId: id, verdict: "deferred", detail: `${venue}: ${s.detail}; sign in in the plugin's browser profile` };
      if ((s.account ?? "").toLowerCase() !== site.account.toLowerCase()) {
        return { draftId: id, verdict: "deferred", detail: `${venue}: the browser is signed in as ${s.account ?? "an unreadable account"}, not ${site.account}` };
      }
    }
    return { draftId: id, verdict: "sendable" };
  }

  private async session(venue: Venue, adapter: SiteAdapter): Promise<SessionState> {
    const ttl = this.d.sessionTtlMs ?? 5 * 60_000;
    const hit = this.sessions.get(venue);
    if (hit && this.d.now() - hit.at < ttl) return hit.state;
    let state: SessionState;
    let session: DriverSession | null = null;
    try {
      session = await this.d.openDriver(venue);
      state = await adapter.checkSession(session.driver);
    } catch (e) {
      state = { signedIn: false, account: null, detail: `the site could not be reached: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      if (session) await session.close().catch(() => undefined);
    }
    this.sessions.set(venue, { at: this.d.now(), state });
    return state;
  }
}
