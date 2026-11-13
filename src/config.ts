// The config file (JSON). Unknown keys are refused, so a typo never silently
// turns a guard off.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkBaseUrl } from "./muster/client.ts";
import type { Venue } from "./sites/types.ts";

export interface SiteConfig {
  enabled: boolean;
  /** The account the browser profile must be signed in as: an X handle, or a
   * LinkedIn public-profile slug (the part after /in/). */
  account: string;
  /** Minimum time between two posts on this site. */
  min_gap_seconds: number;
  allow_mentions: boolean;
  /** Overrides the site's length limit (X: weighted characters). */
  max_length?: number;
}

/** The browser is always launched on a dedicated profile directory; the
 * plugin never attaches to the owner's everyday browser. */
export interface BrowserConfig {
  user_data_dir: string;
  /** Installed browser to launch: chrome, chrome-beta, msedge… */
  channel?: string;
  executable_path?: string;
  headless: boolean;
}

export interface Config {
  server_url: string;
  allow_insecure_http: boolean;
  token_file: string;
  state_dir: string;
  media_root: string;
  claim_wait_seconds: number;
  /** Load each site to confirm the signed-in account before saying sendable. */
  check_session: boolean;
  /** Seconds between two pre-approval check sweeps. */
  check_interval_seconds: number;
  browser: BrowserConfig;
  sites: Partial<Record<Venue, SiteConfig>>;
}

export function defaultConfigPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "muster-social", "config.json");
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function defaults(): Omit<Config, "server_url"> {
  const cfg = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  const state = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  const data = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return {
    allow_insecure_http: false,
    token_file: join(cfg, "muster-social", "token"),
    state_dir: join(state, "muster-social"),
    media_root: join(data, "muster-social", "media"),
    claim_wait_seconds: 25,
    check_session: true,
    check_interval_seconds: 30,
    browser: { user_data_dir: join(data, "muster-social", "profile"), headless: false },
    sites: {},
  };
}

const TOP = new Set(["server_url", "allow_insecure_http", "token_file", "state_dir", "media_root", "claim_wait_seconds",
  "check_session", "check_interval_seconds", "browser", "sites"]);
const BROWSER = new Set(["user_data_dir", "channel", "executable_path", "headless"]);
const SITE = new Set(["enabled", "account", "min_gap_seconds", "allow_mentions", "max_length"]);
const SITE_DEFAULT_GAP: Record<Venue, number> = { x: 900, linkedin: 1800 };

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new Error(`config: unknown key ${where}${k}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseConfig(raw: unknown): Config {
  if (!isObj(raw)) throw new Error("config: the file is not a JSON object");
  unknownKeys(raw, TOP, "");
  const d = defaults();
  if (typeof raw["server_url"] !== "string") throw new Error("config: server_url is required");
  const allowHttp = raw["allow_insecure_http"] === true;
  const str = (v: unknown, dflt: string, k: string) => {
    if (v === undefined) return dflt;
    if (typeof v !== "string" || !v) throw new Error(`config: ${k} is a non-empty string`);
    return resolve(expandHome(v));
  };
  const num = (v: unknown, dflt: number, k: string, min: number, max: number) => {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`config: ${k} is a number ${min}..${max}`);
    return v;
  };
  const bool = (v: unknown, dflt: boolean, k: string) => {
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") throw new Error(`config: ${k} is true or false`);
    return v;
  };

  const b = raw["browser"] === undefined ? {} : raw["browser"];
  if (!isObj(b)) throw new Error("config: browser is an object");
  unknownKeys(b, BROWSER, "browser.");
  const browser: BrowserConfig = {
    user_data_dir: str(b["user_data_dir"], d.browser.user_data_dir, "browser.user_data_dir"),
    headless: bool(b["headless"], false, "browser.headless"),
  };
  if (b["channel"] !== undefined) browser.channel = String(b["channel"]);
  if (b["executable_path"] !== undefined) browser.executable_path = str(b["executable_path"], "", "browser.executable_path");

  const sitesRaw = raw["sites"] === undefined ? {} : raw["sites"];
  if (!isObj(sitesRaw)) throw new Error("config: sites is an object");
  const sites: Partial<Record<Venue, SiteConfig>> = {};
  for (const [name, sv] of Object.entries(sitesRaw)) {
    if (name !== "x" && name !== "linkedin") throw new Error(`config: unknown site sites.${name} (v0 knows x and linkedin)`);
    if (!isObj(sv)) throw new Error(`config: sites.${name} is an object`);
    unknownKeys(sv, SITE, `sites.${name}.`);
    const enabled = bool(sv["enabled"], true, `sites.${name}.enabled`);
    const account = sv["account"];
    if (enabled && (typeof account !== "string" || !account.trim())) {
      throw new Error(`config: sites.${name}.account is required (the account the browser must be signed in as)`);
    }
    const sc: SiteConfig = {
      enabled,
      account: typeof account === "string" ? account.trim().replace(/^@/u, "") : "",
      min_gap_seconds: num(sv["min_gap_seconds"], SITE_DEFAULT_GAP[name], `sites.${name}.min_gap_seconds`, 0, 7 * 86400),
      allow_mentions: bool(sv["allow_mentions"], false, `sites.${name}.allow_mentions`),
    };
    if (sv["max_length"] !== undefined) sc.max_length = num(sv["max_length"], 0, `sites.${name}.max_length`, 1, 100_000);
    sites[name] = sc;
  }

  return {
    server_url: checkBaseUrl(raw["server_url"], allowHttp),
    allow_insecure_http: allowHttp,
    token_file: str(raw["token_file"], d.token_file, "token_file"),
    state_dir: str(raw["state_dir"], d.state_dir, "state_dir"),
    media_root: str(raw["media_root"], d.media_root, "media_root"),
    claim_wait_seconds: num(raw["claim_wait_seconds"], d.claim_wait_seconds, "claim_wait_seconds", 0, 25),
    check_session: bool(raw["check_session"], d.check_session, "check_session"),
    check_interval_seconds: num(raw["check_interval_seconds"], d.check_interval_seconds, "check_interval_seconds", 5, 3600),
    browser,
    sites,
  };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`config: cannot read ${path} (run \`muster-social init\` to write one)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`config: ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(raw);
}
