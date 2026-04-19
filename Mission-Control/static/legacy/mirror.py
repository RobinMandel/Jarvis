"""One-shot mirror of robinmandel.de into this folder.
Keeps a frozen archive of the old school project. Run once; delete after.
"""
import urllib.request
import re
import os
import ssl
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

BASE = "https://robinmandel.de/"
OUT = Path(__file__).parent
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

seen = set()
queue = [BASE]
ctx = ssl.create_default_context()

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, context=ctx, timeout=30).read()

def local_path(url):
    p = urlparse(url).path
    if p.endswith("/") or p == "":
        p += "index.html"
    rel = unquote(p.lstrip("/"))
    return OUT / rel

def extract_refs(html_text):
    refs = set()
    for m in re.finditer(r'''(?:href|src)\s*=\s*["']([^"'#]+)["']''', html_text, re.IGNORECASE):
        refs.add(m.group(1))
    for m in re.finditer(r'''url\(\s*["']?([^"')]+)["']?\s*\)''', html_text, re.IGNORECASE):
        refs.add(m.group(1))
    return refs

while queue:
    url = queue.pop(0)
    if url in seen:
        continue
    seen.add(url)
    parsed = urlparse(url)
    if parsed.netloc and parsed.netloc not in ("robinmandel.de", "www.robinmandel.de"):
        continue  # external
    if url.startswith("mailto:") or url.startswith("javascript:"):
        continue
    try:
        data = fetch(url)
    except Exception as e:
        print(f"FAIL {url}: {e}")
        continue
    dst = local_path(url)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    print(f"OK   {url}  -> {dst.relative_to(OUT)}  ({len(data)} B)")
    ct_hint = dst.suffix.lower()
    if ct_hint in (".html", ".htm", ".css"):
        try:
            text = data.decode("utf-8", errors="ignore")
        except Exception:
            continue
        for ref in extract_refs(text):
            absolute = urljoin(url, ref)
            absolute = absolute.split("#", 1)[0]
            if not absolute.startswith(("http://", "https://")):
                continue
            if absolute not in seen:
                queue.append(absolute)

print(f"\nDone. {len(seen)} URLs processed.")
