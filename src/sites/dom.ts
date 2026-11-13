// Reading a page: every read goes through the page's serialised HTML, parsed
// here. The same code then runs on a live page (the driver's html()) and on a
// test fixture, so what a test proves about a read is what production runs.

import { parseHTML } from "linkedom";
import type { Segment } from "../text.ts";

// linkedom's types are loose; the small surface used here is typed locally.
export interface El {
  tagName: string;
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<El>;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
  closest(sel: string): El | null;
  textContent: string | null;
}

export interface Doc {
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}

export function parse(html: string): Doc {
  const { document } = parseHTML(html) as unknown as { document: Doc };
  return document;
}

export function all(root: Doc | El, sel: string): El[] {
  return Array.from(root.querySelectorAll(sel));
}

const BLOCK = new Set(["DIV", "P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** The rendered text of `root` as segments: text, an image's alt (sites draw
 * emoji as images), a line break for <br> and between blocks, and each <a> as a
 * link segment carrying its text and href. Elements marked aria-hidden are kept:
 * X hides a link's scheme that way, and the text still matches with or without it. */
export function segments(root: El): Segment[] {
  const out: Segment[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && !("href" in last)) last.text += t;
    else out.push({ text: t });
  };
  const walk = (n: El) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        push(c.nodeValue ?? "");
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (tag === "BR") {
        push("\n");
      } else if (tag === "IMG") {
        push(c.getAttribute("alt") ?? "");
      } else if (tag === "A") {
        out.push({ text: plainText(c), href: c.getAttribute("href") ?? "" });
      } else {
        const block = BLOCK.has(tag);
        if (block) push("\n");
        walk(c);
        if (block) push("\n");
      }
    }
  };
  walk(root);
  return out;
}

/** The text of `root`, links included as their shown text. */
export function plainText(root: El): string {
  let s = "";
  const walk = (n: El) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) s += c.nodeValue ?? "";
      else if (c.nodeType === 1) {
        const tag = c.tagName.toUpperCase();
        if (SKIP.has(tag)) continue;
        if (tag === "BR") s += "\n";
        else if (tag === "IMG") s += c.getAttribute("alt") ?? "";
        else {
          const block = BLOCK.has(tag);
          if (block) s += "\n";
          walk(c);
          if (block) s += "\n";
        }
      }
    }
  };
  walk(root);
  return s;
}

export function segmentsText(segs: Segment[]): string {
  return segs.map((s) => s.text).join("");
}
