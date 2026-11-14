// Media refs: muster names each medium `<angle>/<id>`; the plugin resolves it
// to a file under its own media_root, hashes it, and stages the exact bytes it
// hashed into a private file for the browser to attach.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

/** muster's own ref shape (internal/plugins/outbound.go mediaRefRE). */
export const MEDIA_REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/u;

export const EXT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
});

const TYPE_EXT: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4",
});

export function sha256Hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

/** The type the bytes say they are, by magic number, or null. */
export function sniff(b: Uint8Array): string | null {
  const at = (i: number) => b[i] ?? -1;
  const ascii = (i: number, s: string) => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, "PNG\r\n\x1a\n")) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp")) return "video/mp4";
  return null;
}

export interface ResolvedMedia {
  ref: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
  size: number;
  sha256: string;
}

export type ResolveResult = { ok: true; media: ResolvedMedia } | { ok: false; detail: string };

/** Find `<media_root>/<angle>/<id>.<ext>` (exactly one of the known extensions),
 * refuse anything that resolves outside media_root, read and hash it, and check
 * that the bytes are the type the extension says. */
export function resolveRef(mediaRoot: string, ref: string): ResolveResult {
  if (!MEDIA_REF_RE.test(ref)) return { ok: false, detail: `media ref ${JSON.stringify(ref)} is not <angle>/<id>` };
  let root: string;
  try {
    root = realpathSync(mediaRoot);
  } catch {
    return { ok: false, detail: "media_root does not exist on this machine" };
  }
  const found = Object.keys(EXT_TYPES).map((ext) => join(root, `${ref}.${ext}`)).filter((p) => existsSync(p));
  if (found.length === 0) return { ok: false, detail: `media ref ${ref}: no ${ref}.{png,jpg,jpeg,webp,mp4} under media_root` };
  if (found.length > 1) return { ok: false, detail: `media ref ${ref}: more than one file matches (${found.length}); keep exactly one` };
  const p = found[0] as string;
  const real = realpathSync(p);
  if (!real.startsWith(root + sep)) return { ok: false, detail: `media ref ${ref} resolves outside media_root` };
  const bytes = new Uint8Array(readFileSync(real));
  const ext = p.slice(p.lastIndexOf(".") + 1);
  const declared = EXT_TYPES[ext] as string;
  const sniffed = sniff(bytes);
  if (sniffed !== declared) return { ok: false, detail: `media ref ${ref}: the bytes are ${sniffed ?? "an unknown type"}, not ${declared}` };
  return { ok: true, media: { ref, path: real, bytes, contentType: declared, size: bytes.length, sha256: sha256Hex(bytes) } };
}

/** Write `m`'s bytes (the ones hashed) to a fresh private file and return its
 * path: the browser attaches this copy, so a change to the original after the
 * hash cannot reach the post. */
export function stage(stageDir: string, m: ResolvedMedia): string {
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  const p = join(stageDir, `${randomBytes(8).toString("hex")}.${TYPE_EXT[m.contentType] ?? "bin"}`);
  writeFileSync(p, m.bytes, { mode: 0o600, flag: "wx" });
  return p;
}
