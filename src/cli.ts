#!/usr/bin/env node
// muster-social: post owner-approved outbound drafts from muster to social sites.

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfigPath, loadConfig, type Config } from "./config.ts";
import { Journal, acquireLock, phaseOf } from "./journal.ts";
import { MusterClient, MusterError, checkBaseUrl } from "./muster/client.ts";
import { Poster, type DriverSession } from "./poster.ts";
import { Checker } from "./checker.ts";
import { runLoop, isFatal } from "./daemon.ts";
import { pair } from "./pairing.ts";
import { makeXAdapter } from "./sites/x.ts";
import { makeLinkedinAdapter } from "./sites/linkedin.ts";
import type { SiteAdapter, Venue } from "./sites/types.ts";

const USAGE = `usage: muster-social <command> [--config <path>]

  init --server <url>            write a starter config file
  pair --owner <login> [--name muster-social] [--label <label>] [--deliver-to officer:<type>:<area>]
                                 ask muster for a token; you approve it in muster by typing the printed code
  login                          open the plugin's browser profile to sign in to each enabled site
  run                            the long-running loop (run it as a user service)
  check-once                     one pre-approval check sweep, then exit
  status                         unresolved attempts and pacing per site
  resolve <draft> --posted <url> | --not-posted [--note <text>]
                                 settle an attempt whose outcome was unknown
`;

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

function readToken(path: string): string {
  if (!existsSync(path)) throw new Error(`no token at ${path}; run \`muster-social pair\` first`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  const t = readFileSync(path, "utf8").trim();
  if (!t.startsWith("mpl_")) throw new Error(`${path} does not hold a muster plugin token`);
  return t;
}

function adaptersFor(cfg: Config): Partial<Record<Venue, SiteAdapter>> {
  const out: Partial<Record<Venue, SiteAdapter>> = {};
  if (cfg.sites.x?.enabled) out.x = makeXAdapter();
  if (cfg.sites.linkedin?.enabled) out.linkedin = makeLinkedinAdapter();
  return out;
}

async function openDriverFor(cfg: Config): Promise<(v: Venue) => Promise<DriverSession>> {
  const { openPlaywright } = await import("./browser/playwright.ts");
  return () => openPlaywright(cfg.browser);
}

async function build(cfg: Config) {
  const client = new MusterClient({ baseUrl: cfg.server_url, token: readToken(cfg.token_file) });
  const journal = new Journal(join(cfg.state_dir, "journal.jsonl"));
  const adapters = adaptersFor(cfg);
  const openDriver = await openDriverFor(cfg);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const poster = new Poster({
    client, journal, adapters, sites: cfg.sites, mediaRoot: cfg.media_root, stateDir: cfg.state_dir,
    openDriver, now: Date.now, sleep, log,
  });
  const checker = new Checker({
    client, adapters, sites: cfg.sites, mediaRoot: cfg.media_root, checkSession: cfg.check_session,
    openDriver, now: Date.now, log,
  });
  return { client, journal, poster, checker, sleep };
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      config: { type: "string" }, server: { type: "string" }, owner: { type: "string" }, name: { type: "string" },
      label: { type: "string" }, "deliver-to": { type: "string" }, posted: { type: "string" },
      "not-posted": { type: "boolean" }, note: { type: "string" },
    },
  });
  const configPath = values.config ?? defaultConfigPath();

  switch (cmd) {
    case "init": {
      if (!values.server) throw new Error("init needs --server <muster url>");
      if (existsSync(configPath)) throw new Error(`${configPath} exists; edit it instead`);
      const starter = {
        server_url: checkBaseUrl(values.server),
        sites: {
          x: { enabled: false, account: "your_handle", min_gap_seconds: 900, allow_mentions: false },
          linkedin: { enabled: false, account: "your-profile-slug", min_gap_seconds: 1800, allow_mentions: false },
        },
      };
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      writeFileSync(configPath, JSON.stringify(starter, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      console.log(`wrote ${configPath}; set each site's account and enabled, then run \`muster-social pair\``);
      return 0;
    }
    case "pair": {
      const cfg = loadConfig(configPath);
      if (!values.owner) throw new Error("pair needs --owner <your muster login (email)>");
      await pair({
        baseUrl: cfg.server_url, owner: values.owner, name: values.name ?? "muster-social",
        label: values.label ?? "Social posts", tokenFile: cfg.token_file, print: (l) => console.log(l),
        ...(values["deliver-to"] ? { deliverTo: values["deliver-to"] } : {}),
      });
      return 0;
    }
    case "login": {
      const cfg = loadConfig(configPath);
      const { openForLogin } = await import("./browser/playwright.ts");
      const urls: string[] = [];
      if (cfg.sites.x?.enabled) urls.push("https://x.com/login");
      if (cfg.sites.linkedin?.enabled) urls.push("https://www.linkedin.com/login");
      const ctx = await openForLogin(cfg.browser, urls);
      console.log("Sign in to each site in the window that opened, then close the window.");
      await new Promise<void>((r) => ctx.on("close", () => r()));
      return 0;
    }
    case "run": {
      const cfg = loadConfig(configPath);
      const release = acquireLock(join(cfg.state_dir, "lock"));
      try {
        const b = await build(cfg);
        const self = await b.client.self();
        if (!self.capabilities.includes("draft_checks")) throw new MusterError("capability", 403, "this plugin token lacks draft_checks; outbound drafts need it (turn on Checks replies for the plugin in muster)");
        if (!self.deliver_to) log("warning: the plugin is not bound to an officer (deliver_to); no outbound drafts will come");
        log(`muster-social: plugin ${self.plugin_name} (${self.plugin_id}) for ${self.owner_login}; sites: ${Object.keys(adaptersFor(cfg)).join(", ") || "none"}`);
        let stop = false;
        const onSig = () => {
          log("stopping after the current step");
          stop = true;
        };
        process.on("SIGINT", onSig);
        process.on("SIGTERM", onSig);
        await runLoop({
          claim: (w) => b.client.claim(w), poster: b.poster, checker: b.checker,
          claimWaitSeconds: cfg.claim_wait_seconds, checkIntervalMs: cfg.check_interval_seconds * 1000,
          now: Date.now, sleep: b.sleep, log, stopping: () => stop,
        });
      } finally {
        release();
      }
      return 0;
    }
    case "check-once": {
      const cfg = loadConfig(configPath);
      const release = acquireLock(join(cfg.state_dir, "lock"));
      try {
        const b = await build(cfg);
        const vs = await b.checker.runOnce();
        console.log(JSON.stringify(vs, null, 2));
      } finally {
        release();
      }
      return 0;
    }
    case "status": {
      const cfg = loadConfig(configPath);
      // read-only: `status` runs beside the daemon and must never repair (truncate) its journal
      const journal = new Journal(join(cfg.state_dir, "journal.jsonl"), { readOnly: true });
      const unresolved = journal.unresolved();
      for (const [v, s] of Object.entries(cfg.sites)) {
        if (!s?.enabled) continue;
        const last = journal.lastOpenAt(v);
        console.log(`${v}: last post ${last ? new Date(last).toISOString() : "never"}; min gap ${s.min_gap_seconds}s`);
      }
      console.log(unresolved.length ? "UNRESOLVED attempts (the site is paused until each is resolved):" : "no unresolved attempts");
      for (const s of unresolved) console.log(`  draft ${s.draftId} on ${s.venue}: ${phaseOf(s)} — ${s.outcome?.detail ?? "the plugin stopped between arming and the read-back"}`);
      return 0;
    }
    case "resolve": {
      const cfg = loadConfig(configPath);
      const id = Number(positionals[0]);
      if (!Number.isInteger(id) || id <= 0) throw new Error("resolve needs a draft id");
      if (!!values.posted === !!values["not-posted"]) throw new Error("resolve needs exactly one of --posted <url> or --not-posted");
      const release = acquireLock(join(cfg.state_dir, "lock"));
      try {
        const b = await build(cfg);
        await b.poster.resolve(id, values.posted ? "posted" : "not_posted", values.posted, values.note);
        const s = b.journal.get(id);
        console.log(`draft ${id}: ${s ? phaseOf(s) : "?"}${s?.reported ? `, reported (${s.reported.status})` : ", result not yet delivered (run will retry)"}`);
      } finally {
        release();
      }
      return 0;
    }
    default:
      process.stdout.write(USAGE);
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => {
  console.error(`muster-social: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(isFatal(e) ? 3 : 1);
});
