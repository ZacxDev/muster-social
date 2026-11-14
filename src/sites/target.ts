// The element check every driver action runs on its resolved target, in the
// page, before acting. It is ONE self-contained function on purpose: the real
// driver ships its source into the page (Playwright's evaluate), and the fake
// driver calls it on a parsed fixture element, so both run the same check.
// No references to anything outside the function body.

export interface TargetGuardArg {
  forbid: string[];
  labels: string[];
  require: string[];
}

export function targetProblem(el: Element, g: TargetGuardArg): string | null {
  const test = (fn: () => unknown): boolean => {
    try {
      return !!fn();
    } catch {
      return true; // an unparsable selector fails closed
    }
  };
  for (const sel of g.forbid) {
    if (test(() => el.matches(sel))) return "the target is a submit control (" + sel + ")";
    if (test(() => el.closest(sel))) return "the target sits inside a submit control (" + sel + ")";
    if (test(() => el.querySelector(sel))) return "the target contains a submit control (" + sel + ")";
  }
  const btn = el.closest("button, [role=button], input[type=submit]");
  if (btn && g.labels.length) {
    if ((btn.getAttribute("type") || "").toLowerCase() === "submit") return "the target is a submit-type button";
    const names = [btn.getAttribute("aria-label") || "", btn.textContent || "", btn.getAttribute("value") || ""];
    for (const n of names) {
      const t = n.replace(/\s+/g, " ").trim().toLowerCase();
      if (t && g.labels.indexOf(t) >= 0) return "the target is a button labelled '" + t + "'";
    }
  }
  if (g.require.length) {
    let ok = false;
    for (const sel of g.require) {
      try {
        if (el.matches(sel)) ok = true;
      } catch {
        /* an unparsable selector never satisfies require */
      }
    }
    if (!ok) return "the target is not one of the site's submit controls";
  }
  return null;
}

export function guardArg(g: { forbid?: readonly string[]; labels?: readonly string[]; require?: readonly string[] } | undefined): TargetGuardArg {
  return { forbid: [...(g?.forbid ?? [])], labels: [...(g?.labels ?? [])], require: [...(g?.require ?? [])] };
}
