import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codePointLength, findMentions, findUrls, firstHiddenChar, linkStandsFor, normalizeLines, normalizeWs, textMatches, xWeightedLength,
} from "../src/text.ts";

test("normalizeWs collapses whitespace runs and trims, keeping hidden characters", () => {
  assert.equal(normalizeWs("  a \n\n b\t c  "), "a b c");
  assert.equal(normalizeWs("a​b"), "a​b");
});

test("findMentions: @word and fullwidth ＠word, not e-mail addresses", () => {
  assert.deepEqual(findMentions("hi @alice and ＠bob, mail me at x@example.com"), ["alice", "bob"]);
  assert.deepEqual(findMentions("no tags here"), []);
  assert.deepEqual(findMentions("(@carol)"), ["carol"]);
});

test("firstHiddenChar finds zero-width and bidi controls, allows ZWJ emoji", () => {
  assert.equal(firstHiddenChar("ok​there")?.codePoint, "U+200B");
  assert.equal(firstHiddenChar("a‮b")?.codePoint, "U+202E");
  assert.equal(firstHiddenChar("family \u{1F468}‍\u{1F469}‍\u{1F467} ❤️"), null);
});

test("findUrls: with and without scheme, trailing punctuation excluded", () => {
  const u = findUrls("see https://example.com/a?b=1. and github.com/example/project, ok");
  assert.deepEqual(u.map((x) => x.url), ["https://example.com/a?b=1", "github.com/example/project"]);
});

test("linkStandsFor: truncated display, full href, shorteners", () => {
  assert.ok(linkStandsFor({ text: "https://github.com/exam…", href: "https://t.co/zz" }, "github.com/example/project"));
  assert.ok(linkStandsFor({ text: "github.com/example/proj…", href: "https://elsewhere.invalid/" }, "https://github.com/example/project"));
  assert.ok(linkStandsFor({ text: "lnkd.in/abc", href: "https://lnkd.in/abc" }, "https://example.com/x"), "a shortener shown as itself is ambiguous: accepted");
  assert.ok(linkStandsFor({ text: "", href: "https://t.co/abc" }, "https://example.com/x"), "nothing shown, shortener href: accepted");
  assert.ok(linkStandsFor({ text: "click", href: "https://example.com/x" }, "https://example.com/x"));
  assert.ok(!linkStandsFor({ text: "evil.example/other…", href: "https://evil.example/other" }, "https://example.com/x"));
});

test("textMatches: exact text after whitespace normalisation", () => {
  assert.ok(textMatches("hello  world", [{ text: "hello\nworld" }]));
  assert.ok(!textMatches("hello world", [{ text: "hello world!" }]));
  assert.ok(!textMatches("hello world", [{ text: "hello" }]));
});

test("textMatches: a URL may be a rewritten link (t.co) or literal", () => {
  const body = "Launching today: https://github.com/example/project — try it";
  assert.ok(textMatches(body, [
    { text: "Launching today: " },
    { text: "https://github.com/example/proj…", href: "https://t.co/abc" },
    { text: " — try it" },
  ]));
  assert.ok(textMatches(body, [{ text: body }]));
  // the text around the link must still match
  assert.ok(!textMatches(body, [
    { text: "Launching tomorrow: " },
    { text: "https://github.com/example/proj…", href: "https://t.co/abc" },
    { text: " — try it" },
  ]));
});

test("textMatches: a hashtag or mention link must match as literal text", () => {
  assert.ok(textMatches("ship it #buildinpublic", [{ text: "ship it " }, { text: "#buildinpublic", href: "/hashtag/buildinpublic" }]));
  assert.ok(!textMatches("ship it #buildinpublic", [{ text: "ship it " }, { text: "#other", href: "/hashtag/other" }]));
});

test("xWeightedLength: Latin 1, CJK 2, URL 23", () => {
  assert.equal(xWeightedLength("abc"), 3);
  assert.equal(xWeightedLength("日本"), 4);
  assert.equal(xWeightedLength("go https://example.com/a/very/long/path/that/is/long"), 3 + 23);
  assert.equal(xWeightedLength("a".repeat(280)), 280);
});

test("codePointLength counts code points, not UTF-16 units", () => {
  assert.equal(codePointLength("\u{1F600}a"), 2);
});

test("a t.co link shown as one URL never stands for another (post-1 vs post-2)", () => {
  const body = "New on the blog: https://blog.example.com/post-2";
  const seen = (shown: string) => [{ text: "New on the blog: " }, { text: shown, href: "https://t.co/AAAA" }];
  assert.equal(textMatches(body, seen("blog.example.com/post-1")), false);
  assert.equal(textMatches(body, seen("blog.example.com/post-1…")), false);
  assert.equal(textMatches(body, seen("blog.example.com/post-2")), true);
  assert.equal(textMatches(body, seen("blog.example.com/pos…")), true, "a truncated display that is a prefix still matches");
  assert.equal(linkStandsFor({ text: "click here", href: "https://t.co/AAAA" }, "https://blog.example.com/post-2"), false);
});

test("normalizeLines keeps line breaks and blank lines, drops trailing spaces and CRLF", () => {
  assert.equal(normalizeLines("a  \r\nb\u00A0\n\nc\n"), "a\nb\n\nc");
  assert.notEqual(normalizeLines("1. buy\n2. sell"), normalizeLines("1. buy 2. sell"));
  assert.notEqual(normalizeLines("a\nb"), normalizeLines("a\n\nb"));
  assert.equal(normalizeLines("\n\nx\n\n"), "x");
});
