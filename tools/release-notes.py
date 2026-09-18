#!/usr/bin/env python3
"""Extract the exact stable release section; never publish empty/generated notes."""

import argparse
import pathlib
import re


def release_notes(changelog: str, tag: str) -> str:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("expected a stable vX.Y.Z tag")
    sections = list(re.finditer(r"^## \[([^\]]+)\].*$", changelog, re.MULTILINE))
    matches = [(i, item) for i, item in enumerate(sections) if item[1] == tag[1:]]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one CHANGELOG section for {tag}")
    i, section = matches[0]
    end = sections[i + 1].start() if i + 1 < len(sections) else len(changelog)
    body = changelog[section.end():end].strip()
    if not re.search(r"^- \S", body, re.MULTILINE):
        raise ValueError(f"CHANGELOG section for {tag} has no release entries")
    return body + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--changelog", default="CHANGELOG.md")
    args = parser.parse_args()
    try:
        print(release_notes(pathlib.Path(args.changelog).read_text(encoding="utf-8"), args.tag), end="")
    except ValueError as exc:
        parser.error(str(exc))
