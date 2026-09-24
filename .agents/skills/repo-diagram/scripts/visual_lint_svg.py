#!/usr/bin/env python3
"""Mechanical SVG sanity checks; never a replacement for rendered visual review."""
import re, sys, xml.etree.ElementTree as ET
from pathlib import Path
if len(sys.argv)!=2:
    print("usage: visual_lint_svg.py <diagram.svg>", file=sys.stderr); raise SystemExit(2)
path=Path(sys.argv[1])
try: root=ET.parse(path).getroot()
except Exception as exc:
    print(f"VISUAL-LINT ERROR: {exc}", file=sys.stderr); raise SystemExit(1)
def num(v):
    if not v: return None
    m=re.match(r"\s*([0-9.]+)",v); return float(m.group(1)) if m else None
w,h=num(root.attrib.get("width")),num(root.attrib.get("height"))
vb=root.attrib.get("viewBox")
if (w is None or h is None) and vb:
    p=vb.replace(","," ").split()
    if len(p)==4: w,h=float(p[2]),float(p[3])
texts=[]
for el in root.iter():
    if el.tag.rsplit("}",1)[-1] in {"text","tspan"} and el.text: texts.append(el.text)
warnings=[]
if w and h and h:
    ratio=w/h
    if ratio>3.0: warnings.append(f"extreme landscape ratio {ratio:.2f}:1")
    if ratio<0.38: warnings.append(f"extreme portrait ratio 1:{1/ratio:.2f}")
joined="\n".join(texts)
if "\\n" in joined: warnings.append("literal \\n in rendered text")
if any(len(t.strip())>120 for t in texts): warnings.append("very long rendered text label")
print(f"VISUAL-LINT: {path.name}")
if w and h: print(f"  canvas: {w:g} x {h:g}")
for x in warnings: print(f"  WARNING: {x}")
print("  rendered inspection at 100% is still required")
