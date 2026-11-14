// The sending rules: what makes a draft sendable on a site. Pure functions,
// run twice: by the pre-approval check (draft_checks) and again on the claim,
// before anything opens a browser.

import { codePointLength, findMentions, firstHiddenChar, xWeightedLength } from "./text.ts";
import type { OutboundTarget, SiteAdapter } from "./sites/types.ts";

export interface DraftForRules {
  venue: string;
  target: OutboundTarget;
  body: string;
  media: { ref: string; contentType: string; size: number }[];
}

export interface SiteRuleConfig {
  enabled: boolean;
  allowMentions: boolean;
  /** Overrides the site's post/reply length limit (e.g. a longer-post account). */
  maxLength?: number;
}

export interface Violation {
  rule: string;
  detail: string;
}

export function checkDraft(d: DraftForRules, adapter: SiteAdapter | undefined,
  cfg: SiteRuleConfig | undefined): Violation[] {
  if (!adapter || !cfg || !cfg.enabled) {
    return [{ rule: "venue", detail: `venue ${JSON.stringify(d.venue)} is not a site this plugin posts to (enabled: ${enabledHint(adapter, cfg)})` }];
  }
  const out: Violation[] = [];
  const t = adapter.parseTarget(d.target);
  if (!t.ok) {
    out.push({ rule: "target", detail: t.detail });
    return out;
  }
  const kind = t.kind;
  const L = adapter.limits;

  const hidden = firstHiddenChar(d.body);
  if (hidden) out.push({ rule: "hidden-char", detail: `the body holds an invisible character ${hidden.codePoint} at offset ${hidden.index}` });

  if (!cfg.allowMentions) {
    const m = findMentions(d.body);
    if (m.length) out.push({ rule: "mention", detail: `the body would tag ${m.map((x) => "@" + x).join(", ")}; mentions are off for ${d.venue}` });
  }

  const empty = d.body.trim() === "";
  if (empty && !(L.emptyBodyWithMedia && d.media.length > 0)) {
    out.push({ rule: "empty", detail: d.media.length ? `${d.venue} needs text beside media` : "the body is empty" });
  }

  const max = cfg.maxLength ?? L.maxLength[kind];
  const len = L.lengthRule === "x-weighted" ? xWeightedLength(d.body) : codePointLength(d.body);
  if (len > max) {
    out.push({ rule: "length", detail: `the body is ${len} ${L.lengthRule === "x-weighted" ? "weighted characters (URLs count 23)" : "characters"}; ${d.venue} ${kind} allows ${max}` });
  }

  const images = d.media.filter((m) => m.contentType.startsWith("image/"));
  const videos = d.media.filter((m) => m.contentType.startsWith("video/"));
  for (const m of d.media) {
    if (!L.mediaTypes[kind].includes(m.contentType)) {
      out.push({ rule: "media-type", detail: `${m.ref} is ${m.contentType}; a ${d.venue} ${kind} takes ${L.mediaTypes[kind].join(", ") || "no media"}` });
    }
    const cap = m.contentType.startsWith("video/") ? L.maxVideoBytes : L.maxImageBytes;
    if (m.size > cap) out.push({ rule: "media-size", detail: `${m.ref} is ${m.size} bytes; ${d.venue} takes at most ${cap}` });
  }
  if (images.length > L.maxImages[kind]) {
    out.push({ rule: "media-count", detail: `${images.length} images; a ${d.venue} ${kind} takes at most ${L.maxImages[kind]}` });
  }
  if (videos.length > L.maxVideos[kind]) {
    out.push({ rule: "media-count", detail: `${videos.length} videos; a ${d.venue} ${kind} takes at most ${L.maxVideos[kind]}` });
  }
  if (!L.mixMedia && images.length && videos.length) {
    out.push({ rule: "media-mix", detail: `${d.venue} does not mix images and a video in one ${kind}` });
  }
  return out;
}

function enabledHint(adapter: SiteAdapter | undefined, cfg: SiteRuleConfig | undefined): string {
  if (!adapter) return "unknown venue";
  return cfg ? "off in config" : "not configured";
}

export function describe(vs: Violation[]): string {
  return vs.map((v) => `rule ${v.rule}: ${v.detail}`).join("; ");
}
