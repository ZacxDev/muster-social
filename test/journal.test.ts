import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Journal, JournalCorrupt, acquireLock, isUnresolved, phaseOf, resultFor } from "../src/journal.ts";
import { tmp } from "./helpers/env.ts";

test("a journal survives a restart: records are on disk, state is re-derived", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "j.jsonl");
    const a = new Journal(p);
    a.append({ t: "claimed", draft_id: 1, venue: "x", target_kind: "post", target_ref: "", body_sha256: "h", at: 1 });
    a.append({ t: "open", draft_id: 1, venue: "x", at: 2 });
    a.append({ t: "outcome", draft_id: 1, state: "posted", ref: "https://x.com/me/status/9", detail: "read back", at: 3 });
    const b = new Journal(p);
    const s = b.get(1);
    assert.ok(s);
    assert.equal(phaseOf(s), "posted");
    assert.deepEqual(resultFor(s), { ok: true, external_ref: "https://x.com/me/status/9", detail: "read back" });
    assert.equal(b.lastOpenAt("x"), 2);
    assert.equal(readFileSync(p, "utf8").split("\n").filter(Boolean).length, 3);
  } finally {
    t.done();
  }
});

test("crash between the journal's open record and the click: the draft is unresolved and never re-armed", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "j.jsonl");
    const a = new Journal(p);
    a.append({ t: "claimed", draft_id: 7, venue: "x", target_kind: "post", target_ref: "", body_sha256: "h", at: 1 });
    a.append({ t: "open", draft_id: 7, venue: "x", at: 2 });
    // ...process dies here: no outcome
    const b = new Journal(p);
    const s = b.get(7);
    assert.ok(s);
    assert.equal(phaseOf(s), "open");
    assert.ok(isUnresolved(s));
    assert.ok(b.everOpened(7));
    assert.deepEqual(b.unresolved("x").map((x) => x.draftId), [7]);
    assert.equal(resultFor(s), null, "an open attempt reports nothing (it may have posted)");
  } finally {
    t.done();
  }
});

test("unknown outcome stays unresolved until the owner resolves it", () => {
  const t = tmp();
  try {
    const j = new Journal(join(t.dir, "j.jsonl"));
    j.append({ t: "open", draft_id: 3, venue: "linkedin", at: 1 });
    j.append({ t: "outcome", draft_id: 3, state: "unknown", detail: "not found", at: 2 });
    assert.deepEqual(j.unresolved("linkedin").map((s) => s.draftId), [3]);
    assert.deepEqual(j.unresolved("x"), []);
    j.append({ t: "resolved", draft_id: 3, as: "not_posted", at: 3 });
    const s = j.get(3);
    assert.ok(s);
    assert.equal(phaseOf(s), "resolved_not_posted");
    assert.equal(j.unresolved().length, 0);
    assert.equal(resultFor(s)?.ok, false);
    assert.ok(j.everOpened(3), "a resolved draft is still never re-armed");
  } finally {
    t.done();
  }
});

test("a torn final line (an fsync that never returned) is dropped durably", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "j.jsonl");
    const a = new Journal(p);
    a.append({ t: "claimed", draft_id: 1, venue: "x", target_kind: "post", target_ref: "", body_sha256: "h", at: 1 });
    appendFileSync(p, '{"t":"open","draft_id":1,"ven');
    const b = new Journal(p);
    assert.equal(phaseOf(b.get(1) as never), "claimed");
    assert.ok(readFileSync(p, "utf8").endsWith("\n"));
    b.append({ t: "refused", draft_id: 1, code: "x", detail: "d", at: 2 });
    assert.equal(phaseOf(new Journal(p).get(1) as never), "refused");
  } finally {
    t.done();
  }
});

test("a corrupt line in the middle refuses to load", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "j.jsonl");
    writeFileSync(p, '{"t":"open","draft_id":1,"venue":"x","at":1}\nGARBAGE\n{"t":"open","draft_id":2,"venue":"x","at":1}\n');
    assert.throws(() => new Journal(p), JournalCorrupt);
  } finally {
    t.done();
  }
});

test("the lock admits one process; a dead holder's lock is taken over", () => {
  const t = tmp();
  try {
    const p = join(t.dir, "lock");
    const release = acquireLock(p);
    assert.throws(() => acquireLock(p), /holds/);
    release();
    assert.ok(!existsSync(p));
    writeFileSync(p, "999999999");
    const r2 = acquireLock(p);
    assert.equal(readFileSync(p, "utf8"), String(process.pid));
    r2();
  } finally {
    t.done();
  }
});
