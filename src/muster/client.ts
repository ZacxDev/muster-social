// The muster plugin protocol, client side (muster docs/plugins.md). The plugin
// calls muster for everything; muster never calls the plugin.

import type { OutboundTarget } from "../sites/types.ts";

export interface ClaimMedia {
  ref: string;
  sha256: string;
  content_type: string;
  size: number;
}

export interface Claim {
  draft_id: number;
  kind: string;
  message_external_id: string;
  body: string;
  body_sha256?: string;
  approved_at: string;
  venue?: string;
  target?: OutboundTarget;
  media?: ClaimMedia[];
}

export interface CheckMedia {
  ref: string;
  uploaded: boolean;
  sha256?: string;
  content_type?: string;
  size?: number;
}

export interface AwaitingCheck {
  draft_id: number;
  kind: string;
  message_external_id: string;
  body: string;
  created_at: string;
  venue?: string;
  target?: OutboundTarget;
  media?: CheckMedia[];
}

export interface SelfInfo {
  plugin_id: number;
  plugin_name: string;
  owner_id: number;
  owner_login: string;
  capabilities: string[];
  deliver_to: string | null;
}

export type ErrorKind = "auth" | "capability" | "off" | "bad_request" | "not_found" | "conflict" | "too_large"
  | "rate_limited" | "server" | "network" | "protocol";

export class MusterError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  readonly body: unknown;
  constructor(kind: ErrorKind, status: number, message: string, body?: unknown) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
  /** Worth trying again: the request may not have been seen, or muster was busy. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "server" || this.kind === "rate_limited";
  }
}

export type FetchFn = typeof fetch;

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for an idempotent call (result, check, media). */
  attempts?: number;
  /** Per-request timeout for everything but the long-poll claim. */
  timeoutMs?: number;
}

export function kindForStatus(status: number): ErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "capability";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "protocol";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The base URL must be https, except for a loopback host. A plugin token acts
 * as its owner, so it never crosses a network in clear text. */
export function checkBaseUrl(raw: string, allowInsecureHttp = false): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`server_url ${JSON.stringify(raw)} is not a URL`);
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (loopback || allowInsecureHttp))) {
    throw new Error("server_url must be https:// (http:// only for a loopback host, or with allow_insecure_http)");
  }
  if (u.username || u.password || u.search || u.hash) throw new Error("server_url carries no user, query or fragment");
  return u.toString().replace(/\/+$/u, "");
}

export class MusterClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: number;
  private readonly timeoutMs: number;

  constructor(o: ClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/u, "");
    this.token = o.token;
    this.fetchFn = o.fetch ?? fetch;
    this.sleep = o.sleep ?? defaultSleep;
    this.attempts = o.attempts ?? 6;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  private async raw(method: string, path: string, opts: { json?: unknown; body?: Uint8Array; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; json: unknown; headers: Headers }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, ...opts.headers };
    let body: string | Uint8Array | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body) {
      body = opts.body;
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, {
        method, headers, body: body as BodyInit | undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (e) {
      throw new MusterError("network", 0, `${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json, headers: res.headers };
  }

  private fail(method: string, path: string, r: { status: number; json: unknown; headers: Headers }): MusterError {
    const msg = typeof r.json === "object" && r.json && "error" in r.json ? String((r.json as { error: unknown }).error) : `HTTP ${r.status}`;
    const e = new MusterError(kindForStatus(r.status), r.status, `${method} ${path}: ${r.status} ${msg}`, r.json);
    const ra = Number(r.headers.get("retry-after"));
    if (Number.isFinite(ra) && ra > 0) (e as MusterError & { retryAfterMs?: number }).retryAfterMs = ra * 1000;
    return e;
  }

  /** Retry an idempotent call on network errors, 5xx and 429 (muster answers a
   * repeated result, verdict or upload with the same success, so a retry after a
   * lost answer is safe). */
  private async idempotent<T>(fn: () => Promise<T>): Promise<T> {
    let delay = 500;
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof MusterError) || !e.retryable || i >= this.attempts) throw e;
        const ra = (e as MusterError & { retryAfterMs?: number }).retryAfterMs;
        await this.sleep(ra ?? delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async self(): Promise<SelfInfo> {
    const r = await this.raw("GET", "/plugin/v1/self");
    if (r.status !== 200) throw this.fail("GET", "/plugin/v1/self", r);
    return r.json as SelfInfo;
  }

  /** Long-poll for one approved draft. Never retried here: a claim whose answer
   * was lost is still a claim (muster marks it unconfirmed and never offers it
   * again), so the caller just claims again. */
  async claim(waitSeconds: number): Promise<Claim | null> {
    const wait = Math.max(0, Math.min(25, Math.floor(waitSeconds)));
    const r = await this.raw("POST", "/plugin/v1/drafts/claim", { json: { wait_seconds: wait }, timeoutMs: (wait + 15) * 1000 });
    if (r.status === 204) return null;
    if (r.status !== 200) throw this.fail("POST", "/plugin/v1/drafts/claim", r);
    const c = r.json as Claim;
    if (typeof c?.draft_id !== "number" || typeof c.body !== "string") {
      throw new MusterError("protocol", 200, "claim answer has no draft_id/body", r.json);
    }
    return c;
  }

  async result(draftId: number, res: { ok: boolean; external_ref?: string; detail?: string }): Promise<{ draft_id: number; status: string }> {
    const path = `/plugin/v1/drafts/${draftId}/result`;
    const body = {
      ok: res.ok,
      external_ref: (res.external_ref ?? "").slice(0, 200),
      detail: truncateBytes(res.detail ?? "", 4096),
    };
    return this.idempotent(async () => {
      const r = await this.raw("POST", path, { json: body });
      if (r.status !== 200) throw this.fail("POST", path, r);
      return r.json as { draft_id: number; status: string };
    });
  }

  async checks(): Promise<AwaitingCheck[]> {
    const r = await this.raw("GET", "/plugin/v1/drafts/checks");
    if (r.status !== 200) throw this.fail("GET", "/plugin/v1/drafts/checks", r);
    const list = (r.json as { drafts?: AwaitingCheck[] })?.drafts;
    if (!Array.isArray(list)) throw new MusterError("protocol", 200, "checks answer has no drafts list", r.json);
    return list;
  }

  async check(draftId: number, v: { sendable: boolean; detail?: string }): Promise<{ draft_id: number; status: string; check: string }> {
    const path = `/plugin/v1/drafts/${draftId}/check`;
    const body = { sendable: v.sendable, detail: truncateBytes(v.detail ?? "", 4096) };
    return this.idempotent(async () => {
      const r = await this.raw("POST", path, { json: body });
      if (r.status !== 200) throw this.fail("POST", path, r);
      return r.json as { draft_id: number; status: string; check: string };
    });
  }

  async uploadMedia(draftId: number, ref: string, bytes: Uint8Array, contentType: string, sha256: string): Promise<{ status: number; sha256: string }> {
    const path = `/plugin/v1/drafts/${draftId}/media?ref=${encodeURIComponent(ref)}`;
    return this.idempotent(async () => {
      const r = await this.raw("POST", path, { body: bytes, headers: { "Content-Type": contentType, "X-Content-SHA256": sha256 } });
      if (r.status !== 200 && r.status !== 201) throw this.fail("POST", path, r);
      return { status: r.status, sha256: String((r.json as { sha256?: string })?.sha256 ?? "") };
    });
  }
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
export function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (n + b > max - 3) break;
    out += ch;
    n += b;
  }
  return out + "...";
}

// --- pairing: no token yet, so these are free functions -------------------------

export interface PairRequest {
  owner: string;
  name: string;
  label: string;
  data_scope?: string;
  capabilities: string[];
  deliver_to?: string;
}

export interface PairCreated {
  request_id: string;
  code: string;
  poll_secret: string;
  expires_at: string;
}

export interface PairPoll {
  status: "pending" | "approved" | "redeemed" | "denied" | "expired";
  token?: string;
  plugin_id?: number;
  plugin_name?: string;
  capabilities?: string[];
  deliver_to?: string | null;
  error?: string;
}

export async function pairRequest(baseUrl: string, req: PairRequest, fetchFn: FetchFn = fetch): Promise<PairCreated> {
  const res = await fetchFn(baseUrl.replace(/\/+$/u, "") + "/plugin/v1/pair", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null) as unknown;
  if (res.status !== 202) {
    const err = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new MusterError(kindForStatus(res.status), res.status, `pairing request refused: ${err}`, json);
  }
  return json as PairCreated;
}

export async function pairPoll(baseUrl: string, requestId: string, pollSecret: string, fetchFn: FetchFn = fetch): Promise<PairPoll> {
  const res = await fetchFn(baseUrl.replace(/\/+$/u, "") + "/plugin/v1/pair/" + encodeURIComponent(requestId), {
    headers: { Authorization: `Bearer ${pollSecret}` }, signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null) as PairPoll | null;
  if (res.status === 200 || res.status === 409) return json ?? { status: "pending" };
  throw new MusterError(kindForStatus(res.status), res.status, `pairing poll: HTTP ${res.status}`, json);
}
