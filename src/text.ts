// Text rules shared by the pre-approval checks, the pre-click checks and the
// read-back: whitespace normalisation, mention and hidden-character detection,
// URL-tolerant matching, and X's weighted length.

/** Collapse every run of whitespace to one space and trim. Nothing else changes:
 * zero-width and other hidden characters are NOT whitespace and survive, so a
 * comparison still sees them. */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/** An `@word` (or the fullwidth `＠word`) that a site would turn into a mention.
 * An e-mail address is not one: the `@` there follows a letter or digit. */
const MENTION_RE = /(^|[^\p{L}\p{N}_])[@＠]([A-Za-z0-9_]+)/gu;

export function findMentions(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(MENTION_RE)) out.push(m[2] ?? "");
  return out;
}

/** Characters that render as nothing (or reorder text) and so can hide content
 * from the person approving it. ZWJ (U+200D) and the emoji variation selector
 * (U+FE0F) are allowed: emoji sequences need them. */
const HIDDEN_RE = /[­᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;

export function firstHiddenChar(s: string): { index: number; codePoint: string } | null {
  const m = HIDDEN_RE.exec(s);
  if (!m) return null;
  const cp = m[0].codePointAt(0) ?? 0;
  return { index: m.index, codePoint: "U+" + cp.toString(16).toUpperCase().padStart(4, "0") };
}

/** URL candidates in a body: anything with a scheme, or a bare host name with a
 * letter-only top-level label and an optional path. Trailing sentence
 * punctuation is not part of the URL. */
const URL_RE = /\bhttps?:\/\/[^\s<>"]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b(?:\/[^\s<>"]*)?/giu;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/u;

export interface UrlSpan {
  start: number;
  end: number;
  url: string;
}

export function findUrls(s: string): UrlSpan[] {
  const out: UrlSpan[] = [];
  for (const m of s.matchAll(URL_RE)) {
    const raw = m[0];
    const url = raw.replace(TRAILING_PUNCT_RE, "");
    if (!url) continue;
    const start = m.index ?? 0;
    out.push({ start, end: start + url.length, url });
  }
  return out;
}

/** Host names a site rewrites links through. A link shown through one of these
 * cannot be traced back to its target from the page, so it stands for any URL. */
export const SHORTENER_HOSTS: readonly string[] = ["t.co", "lnkd.in"];

function bareUrl(u: string): string {
  return u.replace(/^https?:\/\//iu, "").replace(/^www\./iu, "").toLowerCase();
}

function hostOf(u: string): string {
  return bareUrl(u).split(/[/?#]/u)[0] ?? "";
}

/** One piece of rendered text: plain text, or a link with its shown text and href. */
export type Segment = { text: string } | { text: string; href: string };

export function isLink(s: Segment): s is { text: string; href: string } {
  return "href" in s;
}

/** Does a rendered link stand for `url`? Its shown text (scheme, `www.` and a
 * trailing ellipsis removed) is a prefix of the URL, or its href is the URL, or
 * the link goes through a shortener. */
export function linkStandsFor(link: { text: string; href: string }, url: string): boolean {
  const want = bareUrl(url);
  const shown = bareUrl(normalizeWs(link.text).replace(/(?:…|\.\.\.)$/u, ""));
  if (SHORTENER_HOSTS.includes(hostOf(link.href)) || SHORTENER_HOSTS.includes(hostOf(shown))) return true;
  if (bareUrl(link.href) === want) return true;
  return shown.length >= 4 && want.startsWith(shown);
}

const LINK_MARK = "\u0001";

/** Does rendered text (segments, as read back from a page) say exactly the
 * approved `expected` text, after whitespace normalisation, allowing each URL in
 * `expected` to appear either literally or as a link that stands for it?
 * A link segment that is not one of the URLs (a hashtag or a mention) must match
 * literally, as its text. */
export function textMatches(expected: string, observed: Segment[]): boolean {
  const links: { text: string; href: string }[] = [];
  let obs = "";
  for (const seg of observed) {
    if (isLink(seg) && looksLikeUrlLink(seg)) {
      obs += LINK_MARK + String(links.length) + LINK_MARK;
      links.push(seg);
    } else {
      obs += seg.text;
    }
  }
  const exp = normalizeWs(expected);
  const urls = findUrls(exp);
  const parts: string[] = [];
  let at = 0;
  for (const u of urls) {
    parts.push(exp.slice(at, u.start));
    at = u.end;
  }
  parts.push(exp.slice(at));
  return matchFrom(parts, urls.map((u) => u.url), 0, normalizeWs(obs), 0, links);
}

function looksLikeUrlLink(l: { text: string; href: string }): boolean {
  const t = normalizeWs(l.text);
  if (/^[@＠#$]/u.test(t)) return false;
  return /^https?:\/\//iu.test(l.href) || /^https?:\/\//iu.test(t) || /\.[a-z]{2,}/iu.test(t);
}

// parts[i] is literal text; urls[i] sits between parts[i] and parts[i+1].
function matchFrom(parts: string[], urls: string[], i: number, obs: string, pos: number,
  links: { text: string; href: string }[]): boolean {
  const lit = parts[i] ?? "";
  // whitespace next to a link marker may have been dropped or doubled by the
  // page; compare the literal with its edges trimmed and skip spaces around it.
  const trimmed = lit.trim();
  let p = pos;
  while (obs[p] === " ") p++;
  if (!obs.startsWith(trimmed, p)) return false;
  p += trimmed.length;
  while (obs[p] === " ") p++;
  if (i === urls.length) return p === obs.length;
  const url = urls[i] ?? "";
  // option 1: the URL is a rendered link
  if (obs[p] === LINK_MARK) {
    const close = obs.indexOf(LINK_MARK, p + 1);
    const idx = Number(obs.slice(p + 1, close));
    const link = links[idx];
    if (link && linkStandsFor(link, url) && matchFrom(parts, urls, i + 1, obs, close + 1, links)) return true;
  }
  // option 2: the URL is literal text
  if (obs.startsWith(url, p) && matchFrom(parts, urls, i + 1, obs, p + url.length, links)) return true;
  return false;
}

/** X's weighted length (twitter-text v3 rules, simplified to err long): code
 * points in the Latin ranges weigh 1, every other code point 2, and each URL 23.
 * An emoji sequence is counted per code point, so it can only over-count. */
export function xWeightedLength(s: string): number {
  let total = 0;
  let at = 0;
  for (const u of findUrls(s)) {
    total += weighCodePoints(s.slice(at, u.start));
    total += 23;
    at = u.end;
  }
  return total + weighCodePoints(s.slice(at));
}

function weighCodePoints(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const light = cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

/** Length in code points (LinkedIn's limits are in characters). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
