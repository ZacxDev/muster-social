// A fake muster server speaking the plugin routes this plugin uses, with
// failure injection. Shapes follow muster's docs/plugins.md and its handlers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { AwaitingCheck, Claim } from "../../src/muster/client.ts";

export const TOKEN = "mpl_test_token";

export interface Fault {
  route: "claim" | "result" | "check" | "checks" | "media" | "self";
  /** Answer with this status (and an error body) instead of handling. */
  status?: number;
  /** Handle the request (record it), then destroy the socket: the answer is lost. */
  dropAfterRecord?: boolean;
  /** Destroy the socket without handling. */
  dropBefore?: boolean;
  times: number;
}

export interface ResultReceipt {
  ok: boolean;
  external_ref: string;
  detail: string;
}

export class FakeMuster {
  server!: Server;
  url = "";
  capabilities = ["messages", "draft_checks"];
  deliverTo: string | null = "officer:example:main";
  claims: Claim[] = [];
  /** Every result request that was recorded, in order (repeats included). */
  resultCalls: { id: number; body: ResultReceipt }[] = [];
  /** First recorded result per draft. */
  results = new Map<number, ResultReceipt>();
  claimed = new Set<number>();
  awaiting: AwaitingCheck[] = [];
  verdicts = new Map<number, { sendable: boolean; detail: string }>();
  verdictCalls: { id: number; sendable: boolean; detail: string }[] = [];
  media = new Map<string, { sha256: string; contentType: string; size: number }>();
  mediaCalls: { id: number; ref: string; contentType: string; sha: string }[] = [];
  faults: Fault[] = [];
  pair: { code: string; secret: string; requestId: string; polls: number; approveAfter: number; outcome: "approved" | "denied" | "expired"; token: string; body?: unknown } | null = null;
  requests: { method: string; path: string; auth: string | undefined }[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    const a = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${a.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private fault(route: Fault["route"]): Fault | null {
    const f = this.faults.find((x) => x.route === route && x.times > 0);
    if (!f) return null;
    f.times--;
    return f;
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private send(res: ServerResponse, status: number, json?: unknown): void {
    res.statusCode = status;
    if (json === undefined) {
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(json));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", this.url);
    const path = u.pathname;
    this.requests.push({ method: req.method ?? "", path, auth: req.headers.authorization });

    // pairing needs no plugin token
    if (req.method === "POST" && path === "/plugin/v1/pair") {
      const b = JSON.parse((await this.body(req)).toString() || "{}");
      if (!this.pair) return this.send(res, 400, { error: "no pairing configured" });
      this.pair.body = b;
      return this.send(res, 202, { request_id: this.pair.requestId, code: this.pair.code, poll_secret: this.pair.secret, expires_at: "2000-01-01T00:10:00Z" });
    }
    const pm = /^\/plugin\/v1\/pair\/([^/]+)$/u.exec(path);
    if (req.method === "GET" && pm) {
      const p = this.pair;
      if (!p || pm[1] !== p.requestId || req.headers.authorization !== `Bearer ${p.secret}`) return this.send(res, 404, { error: "no such pairing request" });
      p.polls++;
      if (p.polls < p.approveAfter) return this.send(res, 200, { status: "pending", expires_at: "2000-01-01T00:10:00Z" });
      if (p.outcome !== "approved") return this.send(res, 200, { status: p.outcome });
      if (p.polls > p.approveAfter) return this.send(res, 200, { status: "redeemed" });
      return this.send(res, 200, { status: "approved", token: p.token, plugin_id: 9, plugin_name: "muster-social", capabilities: ["messages", "draft_checks"], deliver_to: null });
    }

    if (req.headers.authorization !== `Bearer ${TOKEN}`) return this.send(res, 401, { error: "not a live plugin token" });

    const route: Fault["route"] | null = path === "/plugin/v1/self" ? "self"
      : path === "/plugin/v1/drafts/claim" ? "claim"
        : path === "/plugin/v1/drafts/checks" ? "checks"
          : /\/result$/u.test(path) ? "result" : /\/check$/u.test(path) ? "check" : /\/media$/u.test(path) ? "media" : null;
    const f = route ? this.fault(route) : null;
    if (f?.dropBefore) {
      req.socket.destroy();
      return;
    }
    if (f?.status) return this.send(res, f.status, { error: "injected" });
    const drop = !!f?.dropAfterRecord;
    const answer = (status: number, json?: unknown) => {
      if (drop) req.socket.destroy();
      else this.send(res, status, json);
    };

    if (req.method === "GET" && route === "self") {
      return answer(200, { plugin_id: 9, plugin_name: "muster-social", owner_id: 1, owner_login: "owner@example.invalid", capabilities: this.capabilities, deliver_to: this.deliverTo });
    }
    if (req.method === "POST" && route === "claim") {
      const b = (await this.body(req)).toString();
      try {
        const j = b ? JSON.parse(b) : {};
        if (typeof j !== "object" || (j.wait_seconds !== undefined && typeof j.wait_seconds !== "number")) throw new Error();
      } catch {
        return answer(400, { error: 'the body is {"wait_seconds": 0-25}' });
      }
      const c = this.claims.shift();
      if (!c) return answer(204);
      this.claimed.add(c.draft_id);
      return answer(200, c);
    }
    if (req.method === "GET" && route === "checks") {
      if (!this.capabilities.includes("draft_checks")) return this.send(res, 403, { error: "needs draft_checks" });
      return answer(200, { drafts: this.awaiting.filter((a) => !this.verdicts.has(a.draft_id)) });
    }
    const idm = /^\/plugin\/v1\/drafts\/(\d+)\/(result|check|media)$/u.exec(path);
    if (req.method === "POST" && idm) {
      const id = Number(idm[1]);
      const raw = await this.body(req);
      if (idm[2] === "result") {
        const b = JSON.parse(raw.toString() || "{}");
        if (typeof b.ok !== "boolean") return answer(400, { error: "ok is required" });
        if (!this.claimed.has(id)) return answer(404, { error: "no such draft claimed by this plugin" });
        const prev = this.results.get(id);
        this.resultCalls.push({ id, body: b });
        if (prev && prev.ok !== b.ok) return answer(409, { error: "the draft already settled with the other result", draft_id: id, status: prev.ok ? "sent" : "failed" });
        if (!prev) this.results.set(id, b);
        return answer(200, { draft_id: id, status: b.ok ? "sent" : "failed" });
      }
      if (idm[2] === "check") {
        const b = JSON.parse(raw.toString() || "{}");
        if (typeof b.sendable !== "boolean") return answer(400, { error: "sendable is required" });
        if (!b.sendable && !b.detail) return answer(400, { error: "a refusal names its reason in detail" });
        const a = this.awaiting.find((x) => x.draft_id === id);
        if (!a) return answer(404, { error: "no such draft of this plugin's" });
        if (b.sendable && a.kind === "outbound") {
          const missing = (a.media ?? []).filter((m) => !this.media.has(`${id}:${m.ref}`) && !m.uploaded).map((m) => m.ref);
          if (missing.length) return answer(409, { error: "upload every medium before saying it is sendable", missing });
        }
        this.verdictCalls.push({ id, sendable: b.sendable, detail: b.detail ?? "" });
        const prev = this.verdicts.get(id);
        if (prev && prev.sendable !== b.sendable) return answer(409, { error: "the draft already has the other verdict" });
        if (!prev) this.verdicts.set(id, { sendable: b.sendable, detail: b.detail ?? "" });
        return answer(200, { draft_id: id, status: b.sendable ? "pending" : "rejected", check: b.sendable ? "sendable" : "refused" });
      }
      // media
      const ref = u.searchParams.get("ref") ?? "";
      const ctype = String(req.headers["content-type"] ?? "");
      const want = String(req.headers["x-content-sha256"] ?? "");
      const got = createHash("sha256").update(raw).digest("hex");
      this.mediaCalls.push({ id, ref, contentType: ctype, sha: want });
      const a = this.awaiting.find((x) => x.draft_id === id && x.kind === "outbound");
      if (!a) return answer(404, { error: "no such outbound draft of this plugin's" });
      if (!(a.media ?? []).some((m) => m.ref === ref)) return answer(400, { error: "ref is not one of the draft's" });
      if (got !== want) return answer(400, { error: "the body's SHA-256 is " + got + ", not the X-Content-SHA256 sent" });
      const key = `${id}:${ref}`;
      const prev = this.media.get(key);
      if (prev && prev.sha256 !== got) return answer(409, { error: "other bytes are already stored for this ref" });
      this.media.set(key, { sha256: got, contentType: ctype, size: raw.length });
      return answer(prev ? 200 : 201, { draft_id: id, ref, sha256: got, content_type: ctype, size: raw.length });
    }
    return this.send(res, 404, { error: "no route" });
  }
}
