#!/usr/bin/env python3
"""Render a report Markdown file into a print-ready HTML and a PDF.

Usage:
    py scripts/md2pdf.py REPORT_3.md --title "Assignment 3: Load Balancing and Observability"
    py scripts/md2pdf.py REPORT_3.md --html-only

The PDF is produced with headless Edge/Chrome (`--print-to-pdf`), so no extra
Python packages beyond `markdown` are required.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent

CSS = """
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #1f2328;
    background: #fff;
    max-width: 920px;
    margin: 0 auto;
    padding: 28px 18px 56px;
  }
  h1 {
    font-size: 20pt;
    margin: 0 0 8px;
    color: #123a8a;
    border-bottom: 2px solid #eaecef;
    padding-bottom: 8px;
  }
  h2 {
    font-size: 14pt;
    margin: 26px 0 10px;
    padding-bottom: 4px;
    border-bottom: 1px solid #d0d7de;
    page-break-after: avoid;
  }
  h3 {
    font-size: 12pt;
    margin: 18px 0 8px;
    page-break-after: avoid;
  }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 10px; padding-left: 22px; }
  li { margin-bottom: 3px; }
  em { color: #424a53; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0 18px;
    font-size: 9.5pt;
  }
  th, td {
    border: 1px solid #d0d7de;
    padding: 6px 8px;
    vertical-align: top;
    text-align: left;
  }
  th { background: #f6f8fa; }
  code, pre {
    font-family: Consolas, "SF Mono", Menlo, monospace;
    font-size: 8.8pt;
  }
  code {
    background: rgba(175, 184, 193, 0.2);
    padding: 1px 4px;
    border-radius: 4px;
  }
  pre {
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 10px 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    margin: 10px 0 14px;
    page-break-inside: avoid;
  }
  pre code { background: transparent; padding: 0; }
  img.figure {
    display: block;
    max-width: 100%;
    max-height: 88mm;
    height: auto;
    margin: 8px auto 4px;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    page-break-inside: avoid;
  }
  p:has(img.figure) {
    page-break-inside: avoid;
    margin-bottom: 4px;
  }
  p em {
    display: block;
    font-size: 9.2pt;
    margin: 0 0 16px;
  }
  @media print {
    body { max-width: 100%; padding: 0; }
    h1, h2, h3, img.figure, table { page-break-inside: avoid; }
  }
"""


def build_html(md_text: str, title: str) -> str:
    body = markdown.markdown(md_text, extensions=["tables", "fenced_code"])
    body = re.sub(
        r'<pre><code class="language-mermaid">(.*?)</code></pre>',
        r'<div class="mermaid">\1</div>',
        body,
        flags=re.S,
    )
    body = body.replace("<img ", '<img class="figure" ')
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>{title}</title>
<style>{CSS}</style>
</head>
<body>
{body}
</body>
</html>
"""


def find_browser() -> Path | None:
    candidates = [
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def html_to_pdf(html_path: Path, pdf_path: Path) -> bool:
    browser = find_browser()
    if browser is None:
        print("No Chrome/Edge found; skipped PDF. HTML is ready to print manually.", file=sys.stderr)
        return False
    cmd = [
        str(browser),
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}",
        html_path.as_uri(),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if not pdf_path.exists():
        print(result.stdout, result.stderr, file=sys.stderr)
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Markdown file to render (relative to repo root).")
    parser.add_argument("--title", default=None, help="HTML <title> / PDF metadata title.")
    parser.add_argument("--html-only", action="store_true", help="Write the HTML but skip the PDF.")
    parser.add_argument("--keep-html", action="store_true", help="Keep the intermediate HTML file.")
    args = parser.parse_args()

    source = args.source if args.source.is_absolute() else (ROOT / args.source)
    if not source.exists():
        print(f"Not found: {source}", file=sys.stderr)
        return 1

    html_path = source.with_suffix(".html")
    pdf_path = source.with_suffix(".pdf")
    title = args.title or source.stem

    html_path.write_text(build_html(source.read_text(encoding="utf-8"), title), encoding="utf-8")
    print(f"Wrote {html_path}")

    if args.html_only:
        return 0

    if html_to_pdf(html_path, pdf_path):
        print(f"Wrote {pdf_path}")
    if not args.keep_html:
        html_path.unlink(missing_ok=True)
        print(f"Removed intermediate {html_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
