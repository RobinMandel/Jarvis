#!/usr/bin/env python3
"""
zotero-add.py — Add a paper to Zotero by DOI (via Zotero Web API)
Usage: python scripts/zotero-add.py --doi 10.1038/s41467-025-12345-x
"""
import argparse
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

CRED_PATH = Path(__file__).parent.parent / "secrets" / "zotero-cred.json"


def load_creds():
    with open(CRED_PATH) as f:
        return json.load(f)


def add_by_doi(doi: str, api_key: str, user_id: str) -> dict:
    url = f"https://api.zotero.org/users/{user_id}/items"
    payload = json.dumps([{"itemType": "journalArticle", "DOI": doi}]).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Zotero-API-Key": api_key,
            "Content-Type": "application/json",
            "Zotero-API-Version": "3",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode()
            return {"ok": True, "status": resp.status, "body": json.loads(body)}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"ok": False, "status": e.code, "error": body}


def resolve_doi_title(doi: str) -> str:
    """Try to get title from CrossRef for confirmation message."""
    try:
        url = f"https://api.crossref.org/works/{doi}"
        req = urllib.request.Request(url, headers={"User-Agent": "Jarvis/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            titles = data.get("message", {}).get("title", [])
            return titles[0] if titles else doi
    except Exception:
        return doi


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--doi", required=True, help="DOI to add to Zotero")
    args = parser.parse_args()

    doi = args.doi.strip().lstrip("https://doi.org/").lstrip("doi:")

    creds = load_creds()
    api_key = creds["api_key"]
    user_id = creds["user_id"]

    title = resolve_doi_title(doi)
    result = add_by_doi(doi, api_key, user_id)

    if result["ok"]:
        print(json.dumps({"ok": True, "message": f"✅ In Zotero gespeichert: {title}", "doi": doi}))
    else:
        print(json.dumps({"ok": False, "message": f"❌ Zotero-Fehler ({result['status']}): {result['error'][:200]}", "doi": doi}))
        sys.exit(1)


if __name__ == "__main__":
    main()
