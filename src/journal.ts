// The attempt journal: an append-only JSON-lines file, fsynced on every
// record. Its one job is that a draft is clicked AT MOST ONCE, across crashes
// and restarts:
//
//   claimed  -> the draft was handed to us (nothing done yet)
//   refused  -> we decided not to send it; nothing was clicked
//   open     -> written and fsynced IMMEDIATELY BEFORE the click
//   outcome  -> after the click: posted | unknown (never "failed")
//   resolved -> the owner settled an open/unknown attempt by hand
//   reported -> muster recorded our result
//
// A draft with an `open` record is never attempted again. An `open` with no
// outcome (a crash between the record and the click, or during it) counts as
// unknown: it may have posted. While a site has an unresolved attempt, nothing
// more is posted there until the owner resolves it.

import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type JournalRecord =
  | { t: "claimed"; draft_id: number; venue: string; target_kind: string; target_ref: string; body_sha256: string; at: number }
  | { t: "refused"; draft_id: number; code: string; detail: string; at: number }
  | { t: "open"; draft_id: number; venue: string; at: number }
  | { t: "outcome"; draft_id: number; state: "posted" | "unknown"; ref?: string; detail: string; at: number }
  | { t: "resolved"; draft_id: number; as: "posted" | "not_posted"; ref?: string; note?: string; at: number }
  | { t: "reported"; draft_id: number; ok: boolean; status: string; at: number };

export type Phase = "claimed" | "refused" | "open" | "unknown" | "posted" | "resolved_posted" | "resolved_not_posted";

export interface DraftState {
  draftId: number;
  venue: string;
  claimed?: Extract<JournalRecord, { t: "claimed" }>;
  refused?: Extract<JournalRecord, { t: "refused" }>;
  open?: Extract<JournalRecord, { t: "open" }>;
  outcome?: Extract<JournalRecord, { t: "outcome" }>;
  resolved?: Extract<JournalRecord, { t: "resolved" }>;
  reported?: Extract<JournalRecord, { t: "reported" }>;
}

export function phaseOf(s: DraftState): Phase {
  if (s.resolved) return s.resolved.as === "posted" ? "resolved_posted" : "resolved_not_posted";
  if (s.open) return s.outcome ? s.outcome.state : "open";
  if (s.refused) return "refused";
  return "claimed";
}

/** An attempt that may have posted and that the owner has not settled. */
export function isUnresolved(s: DraftState): boolean {
  const p = phaseOf(s);
  return p === "open" || p === "unknown";
}

/** The result to report to muster for a settled draft, or null when there is
 * none to report (still open/unknown, or a bare claim the caller still holds). */
export function resultFor(s: DraftState): { ok: boolean; external_ref: string; detail: string } | null {
  switch (phaseOf(s)) {
    case "posted":
      return { ok: true, external_ref: s.outcome?.ref ?? "", detail: s.outcome?.detail ?? "" };
    case "resolved_posted":
      return { ok: true, external_ref: s.resolved?.ref ?? "", detail: "the owner confirmed it was posted" + (s.resolved?.note ? `: ${s.resolved.note}` : "") };
    case "resolved_not_posted":
      return { ok: false, external_ref: "", detail: "not posted: the owner confirmed the earlier attempt did not post" + (s.resolved?.note ? `: ${s.resolved.note}` : "") };
    case "refused":
      return { ok: false, external_ref: "", detail: `not sent: ${s.refused?.detail ?? ""}` };
    default:
      return null;
  }
}

export class JournalCorrupt extends Error {}

export class Journal {
  readonly path: string;
  private states = new Map<number, DraftState>();

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, "utf8");
    let text = raw;
    // A torn final line is a record whose fsync never returned, so whatever it
    // was guarding (a click) never ran: drop it, durably.
    if (raw.length && !raw.endsWith("\n")) {
      const keep = raw.lastIndexOf("\n") + 1;
      const fd = openSync(this.path, "r+");
      try {
        ftruncateSync(fd, Buffer.byteLength(raw.slice(0, keep)));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      text = raw.slice(0, keep);
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line === "") return;
      let rec: JournalRecord;
      try {
        rec = JSON.parse(line) as JournalRecord;
      } catch {
        throw new JournalCorrupt(`journal ${this.path} line ${i + 1} is not JSON; refusing to run (fix or move it aside)`);
      }
      this.apply(rec);
    });
  }

  private apply(r: JournalRecord): void {
    let s = this.states.get(r.draft_id);
    if (!s) {
      s = { draftId: r.draft_id, venue: "" };
      this.states.set(r.draft_id, s);
    }
    switch (r.t) {
      case "claimed": s.claimed = r; s.venue = r.venue; break;
      case "refused": s.refused = r; break;
      case "open": s.open = r; s.venue = r.venue; break;
      case "outcome": s.outcome = r; break;
      case "resolved": s.resolved = r; break;
      case "reported": s.reported = r; break;
      default: throw new JournalCorrupt(`unknown journal record ${JSON.stringify(r)}`);
    }
  }

  /** Append one record and fsync it before returning. Throws on any I/O error. */
  append(r: JournalRecord): void {
    const created = !existsSync(this.path);
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(r) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) fsyncDir(dirname(this.path));
    this.apply(r);
  }

  get(draftId: number): DraftState | undefined {
    return this.states.get(draftId);
  }

  all(): DraftState[] {
    return [...this.states.values()].sort((a, b) => a.draftId - b.draftId);
  }

  /** Has a click ever been armed for this draft? Then it is never tried again. */
  everOpened(draftId: number): boolean {
    return !!this.states.get(draftId)?.open;
  }

  unresolved(venue?: string): DraftState[] {
    return this.all().filter((s) => isUnresolved(s) && (venue === undefined || s.venue === venue));
  }

  /** When the last click was armed on `venue` (ms), or null. Pacing reads it. */
  lastOpenAt(venue: string): number | null {
    let last: number | null = null;
    for (const s of this.states.values()) {
      if (s.open && s.venue === venue && (last === null || s.open.at > last)) last = s.open.at;
    }
    return last;
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some platforms cannot fsync a directory; the file's own fsync still holds.
  }
}

/** One process per state dir: a pid lock file. A lock left by a dead process
 * is taken over. */
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) {
            // only our own lock is removed
            unlinkSync(path);
          }
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (pid && pidAlive(pid)) throw new Error(`another muster-social (pid ${pid}) holds ${path}`);
      unlinkSync(path);
    }
  }
  throw new Error(`could not take the lock ${path}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
