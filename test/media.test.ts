import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRef, sha256Hex, sniff, stage } from "../src/media.ts";
import { jpegBytes, mp4Bytes, pngBytes, putMedia, tmp, webpBytes } from "./helpers/env.ts";

test("sniff recognises png, jpeg, webp and mp4 by magic bytes", () => {
  assert.equal(sniff(pngBytes()), "image/png");
  assert.equal(sniff(jpegBytes()), "image/jpeg");
  assert.equal(sniff(webpBytes()), "image/webp");
  assert.equal(sniff(mp4Bytes()), "video/mp4");
  assert.equal(sniff(new Uint8Array([1, 2, 3])), null);
});

test("resolveRef finds <root>/<angle>/<id>.<ext>, hashes it, checks the bytes", () => {
  const t = tmp("media-");
  try {
    putMedia(t.dir, "launch/hero-1", "png", pngBytes(5));
    const r = resolveRef(t.dir, "launch/hero-1");
    assert.ok(r.ok);
    assert.equal(r.ok && r.media.sha256, sha256Hex(pngBytes(5)));
    assert.equal(r.ok && r.media.contentType, "image/png");
    assert.equal(resolveRef(t.dir, "../etc/passwd").ok, false);
    assert.equal(resolveRef(t.dir, "Launch/Hero").ok, false);
  } finally {
    t.done();
  }
});

test("resolveRef refuses a file that resolves outside media_root (symlink)", () => {
  const t = tmp("media-");
  try {
    const root = join(t.dir, "root");
    const outside = join(t.dir, "outside.png");
    mkdirSync(join(root, "launch"), { recursive: true });
    writeFileSync(outside, pngBytes());
    symlinkSync(outside, join(root, "launch", "escape.png"));
    const r = resolveRef(root, "launch/escape");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.detail, /outside media_root/u);
  } finally {
    t.done();
  }
});

test("stage writes exactly the hashed bytes to a fresh 0600 file", () => {
  const t = tmp("media-");
  try {
    putMedia(t.dir, "a/b", "jpg", jpegBytes(9));
    const r = resolveRef(t.dir, "a/b");
    assert.ok(r.ok);
    if (!r.ok) return;
    const p = stage(join(t.dir, "stage"), r.media);
    assert.match(p, /\.jpg$/u);
    assert.equal(sha256Hex(readFileSync(p)), r.media.sha256);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  } finally {
    t.done();
  }
});
