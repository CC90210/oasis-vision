#!/usr/bin/env python3
"""Block the visual patterns that make our software read as AI-generated.

WHY THIS EXISTS
---------------
On 2026-09-17 Adon recorded the exact combination that gets software instantly
read as generated: blurred drifting orbs, a radial-gradient wash, a faint grid,
an eyebrow label on every heading, and coloured halo glows. The rule went into
memory and nothing enforced it.

On 2026-09-27 an audit found every one of those patterns still shipping in
oasis-command-center, including in code written AFTER the rule was recorded:

  tailwind.config.js:88    a halo utility literally named `shadow-ironman`,
                           wired into Card and Stat, the two primitives on
                           nearly every screen of the daily ops dashboard.
  app/globals.css:211-260  three decorative gradient effects (.scan-line,
                           .top-glow, .chat-aurora).
  app/welcome/page.tsx     the full five-tell pattern, built after the ban.

That is the whole lesson: a design rule held only in memory cannot fail a build,
so it does not change shipped output. This file turns the rule into a gate.

WHAT IT LOOKS FOR
-----------------
Structural signals, not taste. Each rule keys on something mechanically true of
the tell rather than on a subjective read:

  halo-shadow    a box-shadow with ZERO x and y offset and a large blur. Light
                 has a direction; a shadow with no offset is a glow, not
                 elevation. Real elevation carries a y-offset.
  drifting-orb   absolute + rounded-full + a large blur on one element.
  radial-wash    radial-gradient used as a page or section backdrop.
  faint-grid     a grid/dot pattern background.
  gradient-text  bg-clip-text with transparent text.
  ai-accent      the indigo/violet band. This was Tailwind's old default button
                 colour, so it saturated the training corpus and is now the
                 single most diagnostic generated-UI tell.
  named-decor    our own decorative effects, by name.
  eyebrow        uppercase + tracked-out + tiny text. Heuristic, so it reports
                 as WARN and never fails the build on its own.

BASELINE
--------
Existing violations are recorded so the gate fails on NEW ones rather than
blocking every commit on day one. Baselines shrink, never grow - the same
convention as the Turso lints. Each repo needs its own baseline; sharing one
would silence real findings in the others.

Usage:
  python scripts/ui_slop_lint.py
  python scripts/ui_slop_lint.py --json
  python scripts/ui_slop_lint.py --update-baseline
  python scripts/ui_slop_lint.py --root ../oasis-command-center \
      --baseline state/ui-slop-baseline.occ.json --dirs app,components,lib
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "state" / "ui-slop-baseline.json"
SCAN_DIRS = ["app", "components", "lib", "src", "styles", "pages", "docs", "services"]

SCAN_EXT = {".css", ".scss", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".html", ".vue", ".svelte"}
SKIP_PARTS = set([
    "node_modules", ".next", ".git", "dist", "build", "out", "coverage",
    "vendor", "_ARCHIVE", ".ingested", "venv", "__pycache__",
    ".turbo", ".vercel", "site-packages", "examples", ".hallmark",
])
# This linter and its test necessarily CONTAIN the banned strings. Skipping them
# by name stops the guard reporting itself, which would be the dumbest possible
# false positive.
SKIP_FILES = {"ui_slop_lint.py", "test_ui_slop_lint.py"}

# A shadow with no x/y offset and a fat blur is a glow. Elevation has direction.
RE_HALO = re.compile(r"box-shadow\s*:[^;{}]*?\b0\s+0\s+(\d{2,})px", re.I)
RE_HALO_NAMED = re.compile(r"\bshadow-ironman\b|\bshadow-glow\b|\bdrop-shadow-glow\b")
RE_RADIAL = re.compile(r"bg-gradient-radial|radial-gradient\s*\(", re.I)
RE_GRID = re.compile(r"\bbg-grid(-|\b)|\bbg-dot(-|\b)", re.I)
RE_NAMED_DECOR = re.compile(r"\bscan-line\b|\btop-glow\b|\bchat-aurora\b")
RE_AI_ACCENT = re.compile(
    r"#(?:6366f1|818cf8|4f46e5|4338ca|8b5cf6|a78bfa|7c3aed|6d28d9|a855f7|9333ea|c084fc)\b"
    r"|\b(?:indigo|violet|purple)-(?:400|500|600|700)\b",
    re.I,
)

RULES_SIMPLE = [
    ("halo-shadow", RE_HALO_NAMED),
    ("radial-wash", RE_RADIAL),
    ("faint-grid", RE_GRID),
    ("named-decor", RE_NAMED_DECOR),
    ("ai-accent", RE_AI_ACCENT),
]


def _blur_class(line):
    return bool(re.search(r"\bblur-(?:xl|2xl|3xl|\[\d+px\])", line))


def scan_text(rel, text):
    hits = []
    for i, line in enumerate(text.splitlines(), 1):
        if len(line) > 2000:
            line = line[:2000]

        for rule, rx in RULES_SIMPLE:
            if rx.search(line):
                hits.append({"file": rel, "line": i, "rule": rule,
                             "severity": "VIOLATION", "snippet": line.strip()[:160]})

        m = RE_HALO.search(line)
        if m and int(m.group(1)) >= 16:
            hits.append({"file": rel, "line": i, "rule": "halo-shadow",
                         "severity": "VIOLATION", "snippet": line.strip()[:160]})

        if "absolute" in line and "rounded-full" in line and _blur_class(line):
            hits.append({"file": rel, "line": i, "rule": "drifting-orb",
                         "severity": "VIOLATION", "snippet": line.strip()[:160]})

        if "bg-clip-text" in line and "text-transparent" in line:
            hits.append({"file": rel, "line": i, "rule": "gradient-text",
                         "severity": "VIOLATION", "snippet": line.strip()[:160]})

        if ("uppercase" in line and "tracking-" in line
                and re.search(r"text-(?:xs|\[1[01]px\])", line)):
            hits.append({"file": rel, "line": i, "rule": "eyebrow",
                         "severity": "WARN", "snippet": line.strip()[:160]})
    return hits


def iter_files(root, dirs):
    roots = [root / d for d in dirs] or [root]
    for base in roots:
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in SCAN_EXT:
                continue
            if p.name in SKIP_FILES:
                continue
            if SKIP_PARTS & set(p.parts):
                continue
            yield p
    for name in ("tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs"):
        p = root / name
        if p.exists():
            yield p


def scan(root, dirs):
    hits = []
    for p in iter_files(root, dirs):
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = p.relative_to(root).as_posix()
        hits.extend(scan_text(rel, text))
    return hits


def load_baseline(path):
    """Return COUNTS per (file, rule), not a set of keys.

    A set silently accepts every additional occurrence of a rule in a file that
    already has one. The worst offenders are exactly the shared files people
    keep editing - app/globals.css already carries known radial washes - so a
    set made the gate weakest precisely where it had to be strongest. Counting
    catches an added occurrence; keying on (file, rule) rather than line means
    code moving up or down a file is not reported as new.
    """
    if not path.exists():
        return Counter()
    data = json.loads(path.read_text(encoding="utf-8"))
    return Counter((e["file"], e["rule"]) for e in data.get("known", []))


def main():
    ap = argparse.ArgumentParser(description="Block AI-tell visual patterns.")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--root")
    ap.add_argument("--baseline")
    ap.add_argument("--dirs")
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else ROOT
    if args.baseline:
        # Resolve a relative --baseline against the CURRENT WORKING DIRECTORY,
        # the way every other CLI does, not against this file's own location.
        #
        # It used to resolve against ROOT (the script's parent's parent). Inside
        # JARVIS those are the same directory, so it looked correct. Vendored
        # into another repo at .github/ui/, ROOT became that repo's .github/,
        # the baseline path pointed at a file that did not exist, and the lint
        # silently loaded an EMPTY baseline and reported every pre-existing
        # violation as new. A gate that fails everything gets switched off, so
        # this was worse than no gate.
        baseline = Path(args.baseline).resolve()
    else:
        baseline = BASELINE
    dirs = [d.strip() for d in args.dirs.split(",") if d.strip()] if args.dirs else SCAN_DIRS

    hits = scan(root, dirs)
    violations = [h for h in hits if h["severity"] == "VIOLATION"]
    warns = [h for h in hits if h["severity"] == "WARN"]

    if args.update_baseline:
        baseline.parent.mkdir(parents=True, exist_ok=True)
        baseline.write_text(json.dumps({
            "_comment": "Known AI-tell visual patterns. Each entry is a reason a business "
                        "owner reads our software as generated. Shrink, never grow.",
            "root": str(root),
            "known": [{"file": h["file"], "line": h["line"], "rule": h["rule"]}
                      for h in violations],
        }, indent=2) + "\n", encoding="utf-8")
        print("baseline updated: " + str(len(violations)) + " known (" + str(baseline) + ")")
        return 0

    known = load_baseline(baseline)
    seen = Counter()
    new = []
    for h in violations:
        key = (h["file"], h["rule"])
        seen[key] += 1
        if seen[key] > known[key]:
            new.append(h)

    if args.json:
        print(json.dumps({"violations": violations, "warns": warns, "new": new}, indent=2))
        return 1 if new else 0

    by_rule = {}
    for h in violations:
        by_rule[h["rule"]] = by_rule.get(h["rule"], 0) + 1
    if by_rule:
        print("  AI-TELL PATTERNS")
        for rule, n in sorted(by_rule.items(), key=lambda kv: -kv[1]):
            print("    " + rule.ljust(15) + " " + str(n))
    if warns:
        print("\n  eyebrow (heuristic, advisory only): " + str(len(warns)))

    if new:
        print("\n  NEW (" + str(len(new)) + ")")
        for h in new[:40]:
            print("    " + h["file"] + ":" + str(h["line"]) + "  [" + h["rule"] + "]")
            print("        " + h["snippet"])
        print("\nFAIL: " + str(len(new)) + " NEW AI-tell pattern(s).")
        print("These are the patterns that make a business owner read our software as")
        print("generated. Adon banned this exact set on 2026-09-17 and it shipped again")
        print("ten days later. Remove it, or if it is genuinely intentional, record it")
        print("with --update-baseline and say why in the commit message.")
        return 1

    print("\nOK: no new AI-tell patterns (" + str(len(violations)) + " known, "
          + str(len(warns)) + " advisory).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
