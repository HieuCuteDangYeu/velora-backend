#!/usr/bin/env python3
"""Portable text-width estimation for the native SVG renderer.

This avoids treating every character as the same width. It is intentionally
font-agnostic and conservative so generated boxes remain readable even when the
viewer does not have Inter installed.
"""
from __future__ import annotations

import unicodedata

NARROW = set("ilIjtfr.,:;!'|()[]{}")
WIDE = set("MW@#%&QGODC")
MEDIUM_WIDE = set("ABCDEFGHKNPRSTUVXYZmw")
PUNCT = set("-_/\\+*=<>~")


def glyph_em(ch: str) -> float:
    if not ch:
        return 0.0
    if ch.isspace():
        return 0.32
    if ch in NARROW:
        return 0.34
    if ch in WIDE:
        return 0.92
    if ch in MEDIUM_WIDE:
        return 0.72
    if ch in PUNCT:
        return 0.48
    cat = unicodedata.category(ch)
    east = unicodedata.east_asian_width(ch)
    if east in {"W", "F"}:
        return 1.0
    if cat.startswith("N"):
        return 0.58
    if cat == "Lu":
        return 0.66
    if cat == "Ll":
        return 0.54
    if cat.startswith("P"):
        return 0.42
    return 0.62


def estimate_text_width(text: str, font_size: float, weight: str = "400") -> float:
    factor = 1.04 if str(weight) in {"600", "700", "bold"} else 1.0
    return sum(glyph_em(ch) for ch in str(text)) * font_size * factor


def fit_font_size(text: str, max_width: float, preferred: float, minimum: float) -> float:
    if not text:
        return preferred
    width = estimate_text_width(text, preferred, "700")
    if width <= max_width:
        return preferred
    scaled = preferred * max_width / max(width, 1.0)
    return max(minimum, min(preferred, scaled))


def wrap_text(text: str, max_width: float, font_size: float, max_lines: int = 3) -> list[str]:
    words = str(text).split()
    if not words:
        return []
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else current + " " + word
        if estimate_text_width(candidate, font_size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = word
        else:
            # Preserve exact tokens. The caller may reduce font size rather than
            # inventing breaks inside identifiers/protocol names.
            lines.append(word)
            current = ""
        if len(lines) >= max_lines:
            break
    if len(lines) < max_lines and current:
        lines.append(current)
    return lines[:max_lines]
