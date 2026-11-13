// One claimed draft, end to end: verify it is exactly what was approved,
// re-check the sending rules, re-hash the media, honour pacing and any
// unresolved attempt, then let the site adapter post it through the single
// journaled submit gate, and report the result.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { Journal, isUnresolved, resultFor, type DraftState } from "./journal.ts";
import { resolveRef, sha256Hex, stage } from "./media.ts";
import { checkDraft, describe } from "./rules.ts";
import { MusterError, type Claim } from "./muster/client.ts";
import type { BrowserDriver, LocalMedia, PostOutcome, SiteAdapter, Venue } from "./sites/types.ts";
import { isVenue } from "./sites/types.ts";
import type { SiteConfig } from "./config.ts";

export interface ResultSink {
  result(draftId: number, r: { ok: boolean; external_ref?: string; detail?: string }): Promise<{ draft_id: number; status: string }>;
}

export interface DriverSession {
  driver: BrowserDriver;
  close(): Promise<void>;
}

export interface PosterDeps {
  client: ResultSink;
  journal: Journal;
  adapters: Partial<Record<Venue, SiteAdapter>>;
  sites: Partial<Record<Venue, SiteConfig>>;
  mediaRoot: string;
  stateDir: string;
  openDriver: (venue: Venue) => Promise<DriverSession>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  /** A claim may wait this long in-process for its site's pacing gap. */
  maxPacingWaitMs?: number;
}

export type HandleOutcome =
  | { action: "posted"; ref: string }
  | { action: "unknown"; detail: string }
  | { action: "refused"; code: string; detail: string }
  | { action: "already-attempted" };

/** A click on a submit control outside the gate. */
export class UngatedSubmit extends Error {}

/** The adapter's driver: every call passes through, except a plain click on a
 * submit control, which only the gate may make. */
export function guardDriver(raw: BrowserDriver, submitSelectors: readonly string[]): BrowserDriver {
  return {
    goto: (u) => raw.goto(u),
    html: () => raw.html(),
    insertText: (s, t) => raw.insertText(s, t),
    attachFiles: (s, p, o) => raw.attachFiles(s, p, o),
    click: async (s) => {
      if (submitSelectors.includes(s)) throw new UngatedSubmit(`refused a click on submit control ${s} outside the journaled gate`);
      return raw.click(s);
    },
    sleep: (ms) => raw.sleep(ms),
    now: () => raw.now(),
  };
}

export class Poster {
  private readonly d: PosterDeps;
  private readonly maxPacingWaitMs: number;

  constructor(deps: PosterDeps) {
    this.d = deps;
    this.maxPacingWaitMs = deps.maxPacingWaitMs ?? 60_000;
  }

  /** Milliseconds until `venue` may post again (0 when it may now). */
  pacingRemainingMs(venue: Venue): number {
    const site = this.d.sites[venue];
    const last = this.d.journal.lastOpenAt(venue);
    if (!site || last === null) return 0;
    return Math.max(0, last + site.min_gap_seconds * 1000 - this.d.now());
  }

  /** Claim only when every enabled site could post within the in-lease wait,
   * and no enabled site has an unresolved attempt. muster's claim is not
   * scoped to a site, so a draft claimed for a paused or paced site could only
   * be refused, and a refusal sends the officer to redraft: rather than loop
   * that way, nothing is claimed until the owner resolves the attempt (the
   * pre-approval checks keep running meanwhile). */
  readyToClaim(): { ready: boolean; waitMs: number; reason: string } {
    let worst = 0;
    const paused: string[] = [];
    for (const [v, s] of Object.entries(this.d.sites)) {
      if (!s?.enabled || !isVenue(v)) continue;
      worst = Math.max(worst, this.pacingRemainingMs(v));
      for (const u of this.d.journal.unresolved(v)) paused.push(`${v} (draft ${u.draftId})`);
    }
    if (paused.length) {
      return { ready: false, waitMs: 30_000, reason: `unresolved attempt on ${paused.join(", ")}; run \`muster-social resolve\`` };
    }
    if (worst > this.maxPacingWaitMs) {
      return { ready: false, waitMs: worst - this.maxPacingWaitMs, reason: "pacing" };
    }
    return { ready: true, waitMs: 0, reason: "" };
  }

  async handle(c: Claim): Promise<HandleOutcome> {
    const J = this.d.journal;
    const id = c.draft_id;
    const prior = J.get(id);
    if (prior && (prior.open || prior.refused || prior.resolved)) {
      // muster never offers a draft twice; if it ever did, it is not tried again.
      this.d.log(`draft ${id}: already handled (${prior.open ? "a click was armed" : "refused"}); not attempted again`);
      await this.report(prior);
      return { action: "already-attempted" };
    }
    if (!prior) {
      J.append({
        t: "claimed", draft_id: id, venue: String(c.venue ?? ""), target_kind: String(c.target?.kind ?? ""),
        target_ref: String(c.target?.ref ?? ""), body_sha256: String(c.body_sha256 ?? ""), at: this.d.now(),
      });
    }

    const refuse = async (code: string, detail: string): Promise<HandleOutcome> => {
      J.append({ t: "refused", draft_id: id, code, detail, at: this.d.now() });
      this.d.log(`draft ${id}: not sent (${code}): ${detail}`);
      await this.report(J.get(id) as DraftState);
      return { action: "refused", code, detail };
    };

    if (c.kind !== "outbound") return refuse("not_outbound", "this plugin sends only outbound drafts (a post or a reply an officer filed)");
    if (!c.body_sha256 || sha256Hex(c.body) !== c.body_sha256) {
      return refuse("body_hash", "the body does not hash to the approved body_sha256");
    }
    const venue = String(c.venue ?? "");
    const adapter = isVenue(venue) ? this.d.adapters[venue] : undefined;
    const site = isVenue(venue) ? this.d.sites[venue] : undefined;
    const claimMedia = c.media ?? [];
    const target = c.target ?? { kind: "", ref: "" };
    const vs = checkDraft(
      { venue, target, body: c.body, media: claimMedia.map((m) => ({ ref: m.ref, contentType: m.content_type, size: m.size })) },
      adapter, site && { enabled: site.enabled, allowMentions: site.allow_mentions, ...(site.max_length ? { maxLength: site.max_length } : {}) },
    );
    if (vs.length || !adapter || !site || !isVenue(venue)) return refuse("rules", describe(vs) || "venue not enabled");
    const parsed = adapter.parseTarget(target);
    if (!parsed.ok) return refuse("rules", parsed.detail);

    // Re-hash our own files: anything other than the approved bytes posts nothing.
    const resolved = [];
    for (const m of claimMedia) {
      const r = resolveRef(this.d.mediaRoot, m.ref);
      if (!r.ok) return refuse("media_missing", r.detail);
      if (r.media.sha256 !== m.sha256 || r.media.contentType !== m.content_type) {
        return refuse("media_changed", "media changed since approval");
      }
      resolved.push(r.media);
    }

    const open = J.unresolved(venue);
    if (open.length) {
      const ids = open.map((s) => s.draftId).join(", ");
      return refuse("venue_paused", `an earlier attempt on ${venue} (draft ${ids}) may have posted and is not resolved; `
        + `the owner resolves it with \`muster-social resolve <draft> --posted <url>|--not-posted\``);
    }

    const wait = this.pacingRemainingMs(venue);
    if (wait > this.maxPacingWaitMs) return refuse("paced", `${venue} posted less than ${site.min_gap_seconds}s ago`);
    if (wait > 0) await this.d.sleep(wait);

    const stageDir = join(this.d.stateDir, "staging", String(id));
    const media: LocalMedia[] = resolved.map((m) => ({ ref: m.ref, path: stage(stageDir, m), contentType: m.contentType, size: m.size, sha256: m.sha256 }));

    let armed = false;
    let gateUsed = false;
    let outcome: PostOutcome | null = null;
    let thrown: unknown = null;
    let session: DriverSession | null = null;
    try {
      session = await this.d.openDriver(venue);
      const raw = session.driver;
      const gate = async (selector: string) => {
        if (gateUsed) throw new Error("the submit gate opens once per draft");
        gateUsed = true;
        if (!adapter.submitSelectors.includes(selector)) throw new Error(`${selector} is not a submit control of ${venue}`);
        J.append({ t: "open", draft_id: id, venue, at: this.d.now() }); // fsynced before the click
        armed = true;
        await raw.click(selector);
      };
      outcome = await adapter.post({
        driver: guardDriver(raw, adapter.submitSelectors), body: c.body, media, target: { kind: parsed.kind, ref: parsed.ref },
        account: site.account, submit: gate, allowMentions: site.allow_mentions, log: (m) => this.d.log(`draft ${id}: ${m}`),
      });
    } catch (e) {
      thrown = e;
    } finally {
      if (session) await session.close().catch(() => undefined);
      rmSync(stageDir, { recursive: true, force: true });
    }

    if (armed) {
      // After the click there are only two outcomes; anything else is unknown.
      const state = outcome?.phase === "clicked" ? outcome.state : "unknown";
      const detail = outcome ? outcome.detail : `error after the click: ${errText(thrown)}`;
      const ref = outcome?.phase === "clicked" ? outcome.ref : undefined;
      J.append({ t: "outcome", draft_id: id, state, ...(ref ? { ref } : {}), detail, at: this.d.now() });
      if (state === "posted") {
        await this.report(J.get(id) as DraftState);
        this.d.log(`draft ${id}: posted ${ref ?? ""}`);
        return { action: "posted", ref: ref ?? "" };
      }
      this.d.log(`draft ${id}: OUTCOME UNKNOWN on ${venue} — not reported, ${venue} paused until the owner resolves it: ${detail}`);
      return { action: "unknown", detail };
    }
    if (thrown) return refuse("error", `nothing was clicked: ${errText(thrown)}`);
    if (outcome?.phase === "refused") return refuse(outcome.code, outcome.detail);
    return refuse("error", "the adapter reported a click the gate never made; nothing was clicked");
  }

  /** Report a settled draft's result once muster has not yet recorded it. */
  async report(s: DraftState): Promise<void> {
    if (s.reported) return;
    const r = resultFor(s);
    if (!r) return;
    try {
      const res = await this.d.client.result(s.draftId, r);
      this.d.journal.append({ t: "reported", draft_id: s.draftId, ok: r.ok, status: res.status, at: this.d.now() });
    } catch (e) {
      if (e instanceof MusterError && (e.kind === "conflict" || e.kind === "not_found")) {
        // muster holds a different truth (or no such claim): record it and stop.
        this.d.journal.append({ t: "reported", draft_id: s.draftId, ok: r.ok, status: `${e.kind}: ${e.message}`, at: this.d.now() });
        this.d.log(`draft ${s.draftId}: muster refused the result: ${e.message}`);
        return;
      }
      this.d.log(`draft ${s.draftId}: result not delivered yet (${errText(e)}); will retry`);
    }
  }

  /** Settle what a restart left behind and re-send unreported results. Call
   * only while no draft is being handled. */
  async reconcile(): Promise<void> {
    for (const s of this.d.journal.all()) {
      if (!s.open && !s.refused && !s.resolved && s.claimed) {
        this.d.journal.append({ t: "refused", draft_id: s.draftId, code: "restart", detail: "the plugin stopped before posting it; nothing was clicked", at: this.d.now() });
      }
    }
    for (const s of this.d.journal.all()) await this.report(s);
  }

  /** The owner settles an open/unknown attempt. */
  async resolve(draftId: number, as: "posted" | "not_posted", ref?: string, note?: string): Promise<void> {
    const s = this.d.journal.get(draftId);
    if (!s || !isUnresolved(s)) throw new Error(`draft ${draftId} has no unresolved attempt`);
    if (as === "posted" && !ref) throw new Error("--posted needs the post's URL or id");
    this.d.journal.append({ t: "resolved", draft_id: draftId, as, ...(ref ? { ref } : {}), ...(note ? { note } : {}), at: this.d.now() });
    await this.report(this.d.journal.get(draftId) as DraftState);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
