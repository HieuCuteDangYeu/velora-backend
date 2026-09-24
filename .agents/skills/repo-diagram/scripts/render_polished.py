#!/usr/bin/env python3
"""Auto-repair loop for polished native architecture renders.

The loop never changes semantic IR. It only retries presentation geometry with
progressively roomier spacing, then accepts the first render that passes the strict
geometry gate.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import yaml
except ImportError:
    print("AUTO-REPAIR unavailable: install PyYAML", file=sys.stderr)
    raise SystemExit(2)

REPAIRABLE = {
    "NODE_OVERLAP",
    "EDGE_NODE_CROSSING",
    "EDGE_EDGE_CROSSING",
    "EDGE_EDGE_OVERLAP",
    "LABEL_NODE_COLLISION",
    "LABEL_LABEL_COLLISION",
    "LABEL_EDGE_COLLISION",
    "REGION_HEADER_COLLISION",
    "PORT_CONGESTION",
    "CROSSING_BUDGET",
}

NON_REPAIRABLE = {
    "REGION_MEMBER_OUTSIDE",
    "REGION_CAPTURES_UNRELATED_NODE",
    "AMBIGUOUS_REGION_OVERLAP",
    "NON_ORTHOGONAL_ROUTE",
}


def run(cmd):
    return subprocess.run(cmd, text=True, capture_output=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--max-passes", type=int, default=4)
    ap.add_argument("--keep-attempts", action="store_true")
    args = ap.parse_args()

    doc = yaml.safe_load(args.spec.read_text(encoding="utf-8")) or {}
    layout = doc.get("layout") or {}
    crossing_target = int(layout.get("crossing_target", 0) or 0)

    script_dir = Path(__file__).resolve().parent
    renderer = script_dir / "render_architecture_svg.py"
    analyzer = script_dir / "visual_analyze_svg.py"

    scales = [1.0, 1.12, 1.28, 1.48, 1.7][:max(1, args.max_passes)]
    attempts_root = args.output.parent / (args.output.stem + ".repair-attempts")

    with tempfile.TemporaryDirectory(prefix="repo-diagrammer-repair-") as tmp:
        tmpdir = Path(tmp)
        last_findings = []
        best = None
        best_blocking = 10**9

        for idx, scale in enumerate(scales, start=1):
            svg = tmpdir / f"pass-{idx}.svg"
            report = tmpdir / f"pass-{idx}.json"

            rendered = run([
                sys.executable, str(renderer), str(args.spec), str(svg),
                "--spacing-scale", str(scale),
            ])
            if rendered.returncode != 0:
                print(rendered.stdout, end="")
                print(rendered.stderr, end="", file=sys.stderr)
                return rendered.returncode

            checked = run([
                sys.executable, str(analyzer), str(svg), "--strict",
                "--max-crossings", str(crossing_target), "--json", str(report),
            ])
            data = json.loads(report.read_text(encoding="utf-8")) if report.exists() else {}
            findings = data.get("findings") or []
            blocking = [f for f in findings if f.get("severity") == "blocking"]
            codes = {f.get("code") for f in blocking}
            last_findings = findings

            if len(blocking) < best_blocking:
                best_blocking = len(blocking)
                best = svg

            print(
                f"AUTO-REPAIR pass {idx}/{len(scales)}: spacing={scale:.2f}, "
                f"blocking={len(blocking)}, crossings={data.get('crossings', '?')}"
            )
            for finding in blocking:
                print(f"  BLOCKING {finding.get('code')}: {finding.get('message')}")

            if checked.returncode == 0:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(svg, args.output)
                print(f"AUTO-REPAIR PASS: {args.output} after {idx} pass(es)")
                if args.keep_attempts:
                    attempts_root.mkdir(parents=True, exist_ok=True)
                    for candidate in tmpdir.iterdir():
                        shutil.copyfile(candidate, attempts_root / candidate.name)
                return 0

            if codes & NON_REPAIRABLE:
                print(
                    "AUTO-REPAIR STOP: blocking defect requires model/grouping correction, "
                    "not more spacing.",
                    file=sys.stderr,
                )
                break

            if not (codes & REPAIRABLE):
                print(
                    "AUTO-REPAIR STOP: no supported automatic repair applies to remaining defects.",
                    file=sys.stderr,
                )
                break

        if args.keep_attempts:
            attempts_root.mkdir(parents=True, exist_ok=True)
            for candidate in tmpdir.iterdir():
                shutil.copyfile(candidate, attempts_root / candidate.name)

        print(
            f"AUTO-REPAIR FAILED: best pass still has {best_blocking} blocking defect(s).",
            file=sys.stderr,
        )
        for finding in last_findings:
            if finding.get("severity") == "blocking":
                print(
                    f"  {finding.get('code')}: {finding.get('message')}",
                    file=sys.stderr,
                )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
