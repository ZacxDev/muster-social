import type { BrowserDriver } from "./types.ts";

/** Call fn until it returns a truthy value or `timeoutMs` passes on the
 * driver's clock. Returns the value, or null on timeout. */
export async function poll<T>(d: BrowserDriver, timeoutMs: number, stepMs: number,
  fn: () => Promise<T | null | undefined | false>): Promise<T | null> {
  const end = d.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (d.now() >= end) return null;
    await d.sleep(stepMs);
  }
}

export interface ReadbackResult<H> {
  hit: H | null;
  /** Errors met while reading, for the report's detail. */
  errors: string[];
}

/** Look for the post after the click: `first` is polled `tries` times, then
 * each of `rest` is read once. Errors are collected, never thrown: after the
 * click there is no "failed", only posted (found) or unknown (not found). */
export async function readback<H>(d: BrowserDriver, tries: number, stepMs: number,
  first: () => Promise<H | null>, rest: Array<() => Promise<H | null>>): Promise<ReadbackResult<H>> {
  const errors: string[] = [];
  for (let i = 0; i < tries; i++) {
    await d.sleep(stepMs);
    try {
      const h = await first();
      if (h) return { hit: h, errors };
    } catch (e) {
      errors.push(errText(e));
    }
  }
  for (const place of rest) {
    try {
      const h = await place();
      if (h) return { hit: h, errors };
    } catch (e) {
      errors.push(errText(e));
    }
  }
  return { hit: null, errors };
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Milliseconds since the epoch encoded in a 64-bit time-ordered id whose top
 * bits are a millisecond timestamp shifted left 22 (X and LinkedIn both use
 * this layout; X adds its own epoch). Null for a non-numeric id. */
export function idTimeMs(id: string, epochMs: bigint): number | null {
  if (!/^\d{1,20}$/u.test(id)) return null;
  return Number((BigInt(id) >> 22n) + epochMs);
}

/** How long to wait, and how often to look. Overridable for tests. */
export interface Timing {
  loadMs: number;
  stepMs: number;
  mediaWaitMs: number;
  clearWaitMs: number;
  readbackTries: number;
  readbackStepMs: number;
  /** A read-back accepts posts at most this much older than the click. */
  sinceSlackMs: number;
}

export const DEFAULT_TIMING: Timing = Object.freeze({
  loadMs: 20_000,
  stepMs: 500,
  mediaWaitMs: 120_000,
  clearWaitMs: 30_000,
  readbackTries: 6,
  readbackStepMs: 2_500,
  sinceSlackMs: 60_000,
});
