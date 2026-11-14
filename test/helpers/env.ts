import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timing } from "../../src/sites/common.ts";
import type { SiteConfig } from "../../src/config.ts";

export const FAST: Timing = Object.freeze({
  loadMs: 2_000,
  stepMs: 100,
  mediaWaitMs: 5_000,
  clearWaitMs: 3_000,
  readbackTries: 3,
  readbackStepMs: 200,
  sinceSlackMs: 60_000,
});

export function tmp(prefix = "ms-"): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal valid PNG signature + IHDR start; `salt` makes distinct bytes. */
export function pngBytes(salt = 0): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, salt & 0xff, 1, 2, 3]);
}

export function jpegBytes(salt = 0): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, salt & 0xff]);
}

export function webpBytes(salt = 0): Uint8Array {
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 30, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, salt & 0xff]);
}

export function mp4Bytes(salt = 0): Uint8Array {
  return new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, salt & 0xff]);
}

export function putMedia(root: string, ref: string, ext: string, bytes: Uint8Array): string {
  const p = join(root, `${ref}.${ext}`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

export function site(account: string, extra: Partial<SiteConfig> = {}): SiteConfig {
  return { enabled: true, account, min_gap_seconds: 0, allow_mentions: false, ...extra };
}
