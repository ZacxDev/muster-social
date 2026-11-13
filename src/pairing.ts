// Pairing (muster docs/plugins.md "Pairing a plugin without handling its
// token"): ask muster for a token, print the code for the owner to type into
// muster, poll, and write the token straight to a 0600 file. Nobody ever
// sees, types or pastes the token.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { pairPoll, pairRequest, type FetchFn } from "./muster/client.ts";

export interface PairOptions {
  baseUrl: string;
  owner: string;
  name: string;
  label: string;
  deliverTo?: string;
  tokenFile: string;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  print: (line: string) => void;
  pollMs?: number;
  /** Give up after this long (muster expires a request after 10 minutes). */
  timeoutMs?: number;
  now?: () => number;
}

export async function pair(o: PairOptions): Promise<{ pluginId: number; pluginName: string }> {
  if (existsSync(o.tokenFile)) {
    throw new Error(`${o.tokenFile} already exists; this plugin is paired. Revoke it in muster and remove the file to pair again`);
  }
  const fetchFn = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const req = {
    owner: o.owner, name: o.name, label: o.label,
    capabilities: ["messages", "draft_checks"],
    ...(o.deliverTo ? { deliver_to: o.deliverTo } : {}),
  };
  const created = await pairRequest(o.baseUrl, req, fetchFn);
  o.print(`Pairing code: ${created.code}`);
  o.print(`Approve the request "${o.name}" on muster's /plugins page (or in Attention) by typing this code.`);
  o.print(`It expires at ${created.expires_at}. Waiting…`);
  const end = now() + (o.timeoutMs ?? 11 * 60_000);
  let lastNote = "";
  while (now() < end) {
    await sleep(o.pollMs ?? 3000);
    const p = await pairPoll(o.baseUrl, created.request_id, created.poll_secret, fetchFn);
    if (p.status === "approved") {
      if (!p.token || !p.token.startsWith("mpl_")) throw new Error("muster approved the pairing but sent no plugin token");
      writeSecret(o.tokenFile, p.token);
      o.print(`Paired as plugin ${p.plugin_name} (id ${p.plugin_id}); token written to ${o.tokenFile} (mode 0600).`);
      return { pluginId: p.plugin_id ?? 0, pluginName: p.plugin_name ?? o.name };
    }
    if (p.status === "denied") throw new Error("the owner denied the pairing request");
    if (p.status === "expired") throw new Error("the pairing request expired; run pair again");
    if (p.status === "redeemed") throw new Error("the token was already handed out; revoke the plugin in muster and pair again");
    if (p.error && p.error !== lastNote) {
      lastNote = p.error;
      o.print(`muster: ${p.error}`);
    }
  }
  throw new Error("gave up waiting for the owner's approval");
}

/** Create `path` 0600 (never overwrite), write, fsync. */
export function writeSecret(path: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, secret + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
