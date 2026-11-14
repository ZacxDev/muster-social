// The long-running loop: claim approved drafts and post them one at a time,
// sweep pending drafts for their pre-approval check, and re-send any result
// muster has not yet recorded. Sequential on purpose: one browser job at a time.

import type { Checker } from "./checker.ts";
import type { Poster } from "./poster.ts";
import { MusterError, type Claim } from "./muster/client.ts";

export interface DaemonDeps {
  claim: (waitSeconds: number) => Promise<Claim | null>;
  poster: Poster;
  checker: Checker;
  claimWaitSeconds: number;
  checkIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  /** Stop after the current step (set by SIGINT/SIGTERM). */
  stopping: () => boolean;
}

/** Fatal: the token is revoked/unknown, or lacks a capability. Nothing a retry fixes. */
export function isFatal(e: unknown): boolean {
  return e instanceof MusterError && (e.kind === "auth" || e.kind === "capability" || e.kind === "off");
}

export async function runLoop(d: DaemonDeps): Promise<void> {
  await d.poster.reconcile();
  let lastCheck = Number.NEGATIVE_INFINITY;
  let backoff = 1000;
  let lastHold = "";
  while (!d.stopping()) {
    try {
      if (d.now() - lastCheck >= d.checkIntervalMs) {
        lastCheck = d.now();
        await d.checker.runOnce();
      }
      const gate = d.poster.readyToClaim();
      if (!gate.ready) {
        if (gate.reason !== lastHold) d.log(`not claiming: ${gate.reason}`);
        lastHold = gate.reason;
        await d.sleep(Math.min(gate.waitMs, d.checkIntervalMs));
        continue;
      }
      lastHold = "";
      const claim = await d.claim(d.claimWaitSeconds);
      if (claim) await d.poster.handle(claim);
      await d.poster.reconcile();
      backoff = 1000;
    } catch (e) {
      if (isFatal(e)) throw e;
      d.log(`loop: ${e instanceof Error ? e.message : String(e)}; retrying in ${Math.round(backoff / 1000)}s`);
      await d.sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}
