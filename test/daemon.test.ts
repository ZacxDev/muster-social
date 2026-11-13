import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop } from "../src/daemon.ts";
import { MusterError, type Claim } from "../src/muster/client.ts";
import type { Poster } from "../src/poster.ts";
import type { Checker } from "../src/checker.ts";

function fakes(o: { claims: (Claim | null | Error)[]; ready?: boolean }) {
  const handled: number[] = [];
  let reconciles = 0;
  let checks = 0;
  const poster = {
    reconcile: async () => {
      reconciles++;
    },
    readyToClaim: () => ({ ready: o.ready ?? true, waitMs: 1000 }),
    handle: async (c: Claim) => {
      handled.push(c.draft_id);
      return { action: "posted", ref: "" };
    },
  } as unknown as Poster;
  const checker = { runOnce: async () => { checks++; return []; } } as unknown as Checker;
  let i = 0;
  let t = 0;
  const logs: string[] = [];
  return {
    handled, logs, get reconciles() { return reconciles; }, get checks() { return checks; },
    deps: {
      claim: async () => {
        const next = o.claims[i++];
        if (next instanceof Error) throw next;
        return next ?? null;
      },
      poster, checker, claimWaitSeconds: 0, checkIntervalMs: 10_000,
      now: () => t, sleep: async (ms: number) => { t += ms; }, log: (s: string) => logs.push(s),
      stopping: () => i >= o.claims.length,
    },
  };
}

const c = (id: number) => ({ draft_id: id, kind: "outbound", message_external_id: "", body: "b", approved_at: "" }) as Claim;

test("the loop reconciles first, claims and hands each draft to the poster in order", async () => {
  const f = fakes({ claims: [c(1), null, c(2)] });
  await runLoop(f.deps);
  assert.deepEqual(f.handled, [1, 2]);
  assert.ok(f.reconciles >= 4);
  assert.ok(f.checks >= 1);
});

test("a revoked token stops the loop; a network error backs off and continues", async () => {
  const f = fakes({ claims: [new MusterError("network", 0, "down"), c(3)] });
  await runLoop(f.deps);
  assert.deepEqual(f.handled, [3]);
  assert.ok(f.logs.some((l) => /retrying/u.test(l)));
  const g = fakes({ claims: [new MusterError("auth", 401, "revoked"), c(4)] });
  await assert.rejects(runLoop(g.deps), (e: unknown) => e instanceof MusterError && e.kind === "auth");
  assert.deepEqual(g.handled, []);
});

test("while pacing says not ready, nothing is claimed", async () => {
  let claimed = 0;
  let loops = 0;
  const f = fakes({ claims: [], ready: false });
  await runLoop({ ...f.deps, claim: async () => { claimed++; return null; }, stopping: () => ++loops > 3 });
  assert.equal(claimed, 0);
});
