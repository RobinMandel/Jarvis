"""amboss_client.py — Amboss GraphQL + Artikel-Bilder via Session-Cookie.

Amboss hat keinen öffentlichen Login-Endpoint. Statt API-Login nutzt dieser Client
Robins eingeloggtes Browser-Cookie (`next_auth_amboss_de`). Zum Einrichten:

  1. In Chrome/Edge auf next.amboss.com einloggen
  2. F12 → Application → Cookies → `next_auth_amboss_de` kopieren
  3. Wert in Mission-Control → Medizin-Tab → Amboss-Login-Panel einfügen
     (oder in config.json als `amboss_cookie`)

Das Cookie hält typisch 30 Tage. Nach Ablauf gibt die Suche einen GraphQL-Auth-Fehler
zurück — dann im Browser einmal neu einloggen und Cookie erneut kopieren.

Bild-Abruf-Strategie (via GraphQL-Introspection am 2026-04-21 entdeckt):
  1. `searchSuggestions` (oder `searchArticleResults`) → Artikel-EIDs
  2. `article(eid)` → liefert `titleMedia` + `content.media` mit `canonicalUrl`
     direkt auf `media-de.amboss.com`. Kein HTML-Scraping nötig.
"""

import asyncio
import json
import re
import time
from pathlib import Path

import aiohttp

# Korrekter Endpoint (nicht api.amboss.com — das war eine Halluzination im alten Code)
_AMBOSS_API = "https://www.amboss.com/de/api/graphql"
_AMBOSS_APP = "https://next.amboss.com"

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)

_GRAPHQL_HEADERS = {
    "accept": "*/*",
    "accept-language": "de-DE,de;q=0.9,en;q=0.7",
    "content-type": "application/json",
    "origin": _AMBOSS_APP,
    "referer": f"{_AMBOSS_APP}/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": _USER_AGENT,
}

# Minimaler searchSuggestions-Query (aus Browser-Capture, nur ARTICLE-Typ)
_SEARCH_SUGGESTIONS_QUERY = """query searchSuggestions($query: String!, $limit: Int!, $types: [SearchResultType], $useTranslation: SearchTranslationLang, $useRelatedTerm: Boolean, $includeTopicalIr: Boolean) {
  searchSuggestions(
    query: $query
    limit: $limit
    types: $types
    useTranslation: $useTranslation
    useRelatedTerm: $useRelatedTerm
    includeTopicalIr: $includeTopicalIr
  ) {
    text
    value
    metadata
    ... on SearchSuggestionInstantResult {
      __typename
      target {
        ... on SearchTargetArticle {
          articleEid
          particleEid
          anchorId
          __typename
        }
        __typename
      }
    }
    __typename
  }
}"""

_VALID_IMG_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}

_ARTICLE_MEDIA_QUERY = """query articleMedia($eid: String!) {
  article(eid: $eid) {
    eid
    title
    titleMedia { eid title canonicalUrl }
    content {
      ... on Particle {
        eid
        media { eid title canonicalUrl }
      }
    }
  }
}"""

_ARTICLE_FULL_QUERY = """query articleFull($eid: String!) {
  article(eid: $eid) {
    eid
    title
    abstract
    titleMedia { eid title canonicalUrl }
    content {
      ... on Particle {
        eid
        content
        media { eid title canonicalUrl }
      }
    }
  }
}"""


# ---------------------------------------------------------------------------
# Cookie-Verwaltung
# ---------------------------------------------------------------------------

def _cookie_cache_path(uploads_dir: Path) -> Path:
    return uploads_dir.parent / "amboss_cookie_cache.json"


def _load_cached_cookie(uploads_dir: Path) -> str | None:
    """Gibt das gecachte Cookie zurück, wenn vorhanden. Keine Ablaufprüfung (Amboss
    rotiert das Cookie serverseitig; wir merken den Ablauf erst bei 401/Auth-Fehler)."""
    cache = _cookie_cache_path(uploads_dir)
    if not cache.exists():
        return None
    try:
        data = json.loads(cache.read_text("utf-8"))
        return (data.get("cookie") or "").strip() or None
    except Exception:
        return None


def _save_cookie(uploads_dir: Path, cookie: str):
    cache = _cookie_cache_path(uploads_dir)
    cache.write_text(
        json.dumps({"cookie": cookie.strip(), "saved_at": int(time.time())}, indent=2),
        encoding="utf-8",
    )


def _cookie_saved_at(uploads_dir: Path) -> int | None:
    """Gibt Unix-Timestamp vom letzten Cookie-Speichern zurück, oder None."""
    cache = _cookie_cache_path(uploads_dir)
    if not cache.exists():
        return None
    try:
        data = json.loads(cache.read_text("utf-8"))
        ts = data.get("saved_at")
        return int(ts) if ts else None
    except Exception:
        return None


# HTML → Plaintext (Amboss-Artikel haben Markup mit data-content-Popovern, die raus müssen)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_WHITESPACE_RE = re.compile(r"\s+")
_DATA_CONTENT_RE = re.compile(r'data-content="[^"]*"')  # Base64-Popover-Blobs raushauen


def _strip_html(html: str) -> str:
    if not html:
        return ""
    text = _SCRIPT_STYLE_RE.sub("", html)
    text = _DATA_CONTENT_RE.sub("", text)
    text = _HTML_TAG_RE.sub(" ", text)
    # Basale HTML-Entities
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", '"').replace("&#39;", "'"))
    return _WHITESPACE_RE.sub(" ", text).strip()


def _cookie_header(cookie_value: str) -> str:
    """Baut den Cookie-Header. Akzeptiert:
    - nackten `next_auth_amboss_de`-Wert (Hex-Hash, ~32 Zeichen)
    - kompletten Cookie-String (mit `name=value;` Pairs, inkl. next_auth_amboss_de)
    """
    cv = cookie_value.strip()
    if not cv:
        return ""
    if "next_auth_amboss_de" in cv:
        return cv
    return f"next_auth_amboss_de={cv}"


# ---------------------------------------------------------------------------
# GraphQL-Aufrufe
# ---------------------------------------------------------------------------

async def _graphql_batch(
    session: aiohttp.ClientSession,
    cookie: str,
    operations: list[dict],
) -> list[dict]:
    """Führt gebatchten GraphQL-Call aus. Wirft RuntimeError bei HTTP- oder Auth-Fehler."""
    headers = {**_GRAPHQL_HEADERS, "cookie": _cookie_header(cookie)}
    async with session.post(
        _AMBOSS_API, json=operations, headers=headers,
        timeout=aiohttp.ClientTimeout(total=20),
    ) as resp:
        if resp.status == 401 or resp.status == 403:
            body = await resp.text()
            raise RuntimeError(f"Amboss Auth abgelaufen (HTTP {resp.status}) — Cookie erneuern. Body: {body[:200]}")
        if resp.status != 200:
            body = await resp.text()
            raise RuntimeError(f"Amboss GraphQL HTTP {resp.status}: {body[:300]}")
        result = await resp.json()

    if not isinstance(result, list):
        raise RuntimeError(f"Amboss GraphQL: erwartete Array-Response, bekam {type(result).__name__}: {str(result)[:200]}")
    # Auth-Fehler kommen oft als GraphQL-errors mit code UNAUTHENTICATED
    for op_idx, op_result in enumerate(result):
        errors = op_result.get("errors")
        if errors:
            err_str = json.dumps(errors, ensure_ascii=False)[:500]
            if "UNAUTHENTICATED" in err_str.upper() or "UNAUTHORIZED" in err_str.upper():
                raise RuntimeError(f"Amboss Cookie abgelaufen oder ungültig: {err_str}")
            print(f"[Amboss] GraphQL op#{op_idx} hat errors (nicht fatal): {err_str}")
    return result


async def search_article_eids(
    session: aiohttp.ClientSession,
    cookie: str,
    term: str,
    limit: int = 6,
) -> list[dict]:
    """Sucht Artikel zu `term`, gibt [{articleEid, text, particleEid}, ...] zurück."""
    op = {
        "operationName": "searchSuggestions",
        "variables": {
            "query": term,
            "limit": limit,
            "types": ["ARTICLE"],
            "useTranslation": None,
            "useRelatedTerm": False,
            "includeTopicalIr": True,
        },
        "query": _SEARCH_SUGGESTIONS_QUERY,
    }
    result = await _graphql_batch(session, cookie, [op])
    suggestions = ((result[0] or {}).get("data") or {}).get("searchSuggestions") or []

    out = []
    seen = set()
    for s in suggestions:
        target = (s or {}).get("target") or {}
        eid = target.get("articleEid")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        out.append({
            "articleEid": eid,
            "particleEid": target.get("particleEid"),
            "text": s.get("text", ""),
        })
    return out


# ---------------------------------------------------------------------------
# Artikel-HTML + Bild-Extraktion
# ---------------------------------------------------------------------------

async def fetch_article_full(
    session: aiohttp.ClientSession,
    cookie: str,
    article_eid: str,
    media_limit: int = 10,
    text_char_limit: int = 4000,
) -> dict:
    """Holt Artikel mit Media + Text-Content. Gibt dict zurück:
    `{eid, title, abstract, media: [...], text: "..."}`
    Text ist bereinigte Concat der Particle-HTML-Contents, auf `text_char_limit` gekürzt.
    Media-Liste wie `fetch_article_media`.
    """
    op = {
        "operationName": "articleFull",
        "variables": {"eid": article_eid},
        "query": _ARTICLE_FULL_QUERY,
    }
    result = await _graphql_batch(session, cookie, [op])
    article = ((result[0] or {}).get("data") or {}).get("article") or {}
    if not article:
        return {}

    # Media sammeln (title zuerst, dann particle)
    media: list[dict] = []
    seen_media: set[str] = set()

    def _add_m(m: dict, source: str):
        if not isinstance(m, dict):
            return
        eid = m.get("eid") or ""
        url = m.get("canonicalUrl") or ""
        if not url or eid in seen_media:
            return
        seen_media.add(eid)
        media.append({"url": url, "title": m.get("title") or "", "eid": eid,
                      "source": source, "article_title": article.get("title") or ""})

    for m in (article.get("titleMedia") or []):
        _add_m(m, "title")
        if len(media) >= media_limit:
            break
    if len(media) < media_limit:
        for particle in (article.get("content") or []):
            for m in (particle.get("media") or []):
                _add_m(m, "article")
                if len(media) >= media_limit:
                    break
            if len(media) >= media_limit:
                break

    # Text zusammenbauen: abstract + erste Particles bis text_char_limit
    parts: list[str] = []
    abstract = _strip_html(article.get("abstract") or "")
    if abstract:
        parts.append(abstract)
    for particle in (article.get("content") or []):
        chunk = _strip_html(particle.get("content") or "")
        if chunk:
            parts.append(chunk)
        if sum(len(p) for p in parts) >= text_char_limit:
            break
    text = "\n".join(parts)
    if len(text) > text_char_limit:
        text = text[:text_char_limit].rsplit(" ", 1)[0] + "…"

    return {
        "eid": article.get("eid"),
        "title": article.get("title") or "",
        "abstract": abstract,
        "media": media,
        "text": text,
    }


async def fetch_article_media(
    session: aiohttp.ClientSession,
    cookie: str,
    article_eid: str,
    limit: int = 10,
) -> list[dict]:
    """Holt Artikel via `article(eid)`-Query, sammelt MediaAssets aus titleMedia
    und allen Particle-Media. Gibt dedup'te Liste [{url, title, eid, source}] zurück.
    `source` ist "title" oder "article". Titel-Bilder zuerst, dann Particle-Bilder.
    """
    op = {
        "operationName": "articleMedia",
        "variables": {"eid": article_eid},
        "query": _ARTICLE_MEDIA_QUERY,
    }
    result = await _graphql_batch(session, cookie, [op])
    article = ((result[0] or {}).get("data") or {}).get("article") or {}
    if not article:
        return []

    entries: list[dict] = []
    seen_eids = set()

    def _add(m: dict, source: str):
        if not isinstance(m, dict):
            return
        eid = m.get("eid") or ""
        url = m.get("canonicalUrl") or ""
        if not url or eid in seen_eids:
            return
        seen_eids.add(eid)
        entries.append({
            "url": url,
            "title": m.get("title") or "",
            "eid": eid,
            "source": source,
            "article_title": article.get("title") or "",
        })

    # 1. Title-Media (Hauptbilder des Artikels, meist die didaktisch besten)
    for m in (article.get("titleMedia") or []):
        _add(m, "title")
        if len(entries) >= limit:
            return entries

    # 2. Particle-Media (Bilder in den Unterkapiteln)
    for particle in (article.get("content") or []):
        for m in (particle.get("media") or []):
            _add(m, "article")
            if len(entries) >= limit:
                return entries

    return entries


async def _download_image(
    session: aiohttp.ClientSession,
    url: str,
    dest: Path,
    cookie: str | None = None,
) -> bool:
    """Lädt Bild herunter. Schickt Cookie mit falls die CDN auth-gated ist."""
    headers = {"user-agent": _USER_AGENT, "referer": f"{_AMBOSS_APP}/"}
    if cookie:
        headers["cookie"] = _cookie_header(cookie)
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=20)) as resp:
            if resp.status != 200:
                print(f"[Amboss] Download HTTP {resp.status} — übersprungen: {url[:80]}")
                return False
            ct = resp.headers.get("Content-Type", "")
            if "image/" not in ct.lower():
                print(f"[Amboss] Download Content-Type '{ct}' kein Bild — übersprungen: {url[:80]}")
                return False
            data = await resp.read()
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"[Amboss] Download-Fehler {url[:80]}: {e}")
        return False


# ---------------------------------------------------------------------------
# Haupt-API für server.py
# ---------------------------------------------------------------------------

async def fetch_amboss_context(
    cookie: str,
    terms: list[str],
    subject: str,
    uploads_dir: Path,
    images_per_term: int = 4,
    text_per_article: int = 2500,
) -> dict:
    """Orchestriert: Suche → article(eid) → Media + Text → Download.
    Returns: `{"image_paths": [...], "article_texts": [{title, eid, text}, ...]}`.
    Schreibt source_meta.json ins Subject-Dir.
    """
    import uuid as _uuid

    if not cookie or not cookie.strip():
        print("[Amboss] Kein Cookie — übersprungen")
        return {"image_paths": [], "article_texts": []}

    subj_slug = (subject or "medizin").lower().replace(" ", "_")
    out_dir = uploads_dir / "images" / f"amboss_{subj_slug}"
    out_dir.mkdir(parents=True, exist_ok=True)

    # searchSuggestions ist autocomplete-artig — exakte/prägnante Begriffe liefern am besten.
    # Wir probieren pro Term: zuerst nackt, dann mit subject-Prefix als Fallback.
    search_terms = list(terms) if terms else []
    if subject and subject not in search_terms:
        search_terms.append(subject)

    entries: list[dict] = []          # Bild-Entries für source_meta.json
    article_texts: list[dict] = []    # Text-Blöcke für Prompt-Kontext
    seen_article_eids: set[str] = set()
    connector = aiohttp.TCPConnector(ssl=True)
    async with aiohttp.ClientSession(connector=connector) as session:
        for term in search_terms[:4]:  # max 4 Begriffe
            candidates = [term]
            if subject and term != subject:
                candidates.append(f"{subject} {term}")
            articles: list[dict] = []
            for q in candidates:
                try:
                    articles = await search_article_eids(session, cookie, q, limit=4)
                except Exception as e:
                    print(f"[Amboss] Suche '{q}' fehlgeschlagen: {e}")
                    continue
                if articles:
                    print(f"[Amboss] Suche '{q}': {len(articles)} Artikel")
                    break
            if not articles:
                print(f"[Amboss] Keine Artikel für '{term}' (auch nicht mit Fach-Prefix)")
                continue

            # max 2 Top-Artikel pro Term, Duplikate skippen
            for article in articles[:2]:
                eid = article["articleEid"]
                if eid in seen_article_eids:
                    continue
                seen_article_eids.add(eid)
                article_title_short = article.get("text", "")
                try:
                    full = await fetch_article_full(
                        session, cookie, eid,
                        media_limit=images_per_term,
                        text_char_limit=text_per_article,
                    )
                except Exception as e:
                    print(f"[Amboss] Artikel {eid} Abruf fehlgeschlagen: {e}")
                    continue

                article_title = full.get("title") or article_title_short
                media_list = full.get("media") or []
                article_text = full.get("text") or ""

                if article_text:
                    article_texts.append({
                        "eid": eid,
                        "title": article_title,
                        "text": article_text,
                    })
                    print(f"[Amboss] Artikel {eid} ({article_title[:40]}): {len(article_text)} Zeichen Text gesammelt")

                if not media_list:
                    print(f"[Amboss] Artikel {eid} ({article_title[:40]}): keine Media-Assets")
                    continue
                print(f"[Amboss] Artikel {eid} ({article_title[:40]}): {len(media_list)} Bilder")

                for media in media_list:
                    url = media["url"]
                    path_part = url.split("?", 1)[0]
                    ext = path_part.rsplit(".", 1)[-1].lower()
                    if ext not in _VALID_IMG_EXTENSIONS:
                        ext = "jpg"
                    src_prefix = "art" if media["source"] == "article" else "title"
                    fname = f"amboss_{src_prefix}_{_uuid.uuid4().hex[:8]}.{ext}"
                    dest = out_dir / fname
                    ok = await _download_image(session, url, dest, cookie=cookie)
                    if ok:
                        rel = str(dest.relative_to(uploads_dir)).replace("\\", "/")
                        caption = media.get("title") or ""
                        if article_title and article_title not in caption:
                            caption = f"{caption} — {article_title}" if caption else article_title
                        entries.append({
                            "path": rel,
                            "source": media["source"],
                            "caption": caption,
                            "provider": "Amboss",
                        })
                        print(f"[Amboss] Gespeichert ({media['source']}): {fname} ← {caption[:70]}")

    # source_meta.json mergen (hält Captions + Provider-Tag für die Card-Gen)
    if entries:
        try:
            meta_path = out_dir / "source_meta.json"
            existing: list[dict] = []
            if meta_path.exists():
                try:
                    existing = json.loads(meta_path.read_text("utf-8"))
                except Exception:
                    existing = []
            existing_paths = {e["path"] for e in existing if isinstance(e, dict) and "path" in e}
            merged = existing + [e for e in entries if e["path"] not in existing_paths]
            meta_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as me:
            print(f"[Amboss] source_meta.json schreiben fehlgeschlagen: {me}")

    print(f"[Amboss] {len(entries)} Bilder + {len(article_texts)} Artikel-Texte gesamt für '{subject}'")
    return {
        "image_paths": [e["path"] for e in entries],
        "article_texts": article_texts,
    }


async def fetch_amboss_images(
    cookie: str,
    terms: list[str],
    subject: str,
    uploads_dir: Path,
    images_per_term: int = 4,
) -> list[str]:
    """Backward-compat-Wrapper — wenn nur Bilder gebraucht werden."""
    result = await fetch_amboss_context(
        cookie=cookie, terms=terms, subject=subject,
        uploads_dir=uploads_dir, images_per_term=images_per_term,
    )
    return result.get("image_paths") or []


# ---------------------------------------------------------------------------
# Standalone-Test: python amboss_client.py
# Cookie aus config.json (`amboss_cookie`) oder Cache wird benutzt.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    async def _run_test():
        here = Path(__file__).parent
        config_path = here / "config.json"
        # Muss mit server.py UPLOADS_DIR übereinstimmen: data/uploads
        uploads_dir = here / "data" / "uploads"
        uploads_dir.mkdir(parents=True, exist_ok=True)

        cookie = _load_cached_cookie(uploads_dir)
        if not cookie:
            try:
                cfg = json.loads(config_path.read_text("utf-8"))
                cookie = (cfg.get("amboss_cookie") or "").strip()
            except Exception as e:
                print(f"[Test] config.json nicht lesbar: {e}")
                sys.exit(1)

        if not cookie:
            print("[Test] FEHLER: kein Cookie. Trage `amboss_cookie` in config.json ein")
            print("       oder logge dich über Mission-Control → Medizin-Tab → Amboss-Login ein.")
            sys.exit(1)

        print(f"[Test] Cookie-Länge: {len(cookie)} Zeichen, Preview: {cookie[:16]}…")

        connector = aiohttp.TCPConnector(ssl=True)
        async with aiohttp.ClientSession(connector=connector) as session:
            # 1. Suche
            term = sys.argv[1] if len(sys.argv) > 1 else "Herzinsuffizienz"
            print(f"\n[Test] → Suche '{term}'…")
            try:
                articles = await search_article_eids(session, cookie, term, limit=5)
            except Exception as e:
                print(f"[Test] FEHLER Suche: {e}")
                sys.exit(1)
            print(f"[Test] {len(articles)} Artikel:")
            for a in articles:
                print(f"  · {a['articleEid']:>10}  {a.get('text','')[:70]}")
            if not articles:
                print("[Test] Keine Artikel — Cookie evtl. abgelaufen?")
                sys.exit(1)

            # 2. Media-Assets via article()-Query
            first_eid = articles[0]["articleEid"]
            print(f"\n[Test] → Media für Artikel {first_eid}…")
            try:
                media_list = await fetch_article_media(session, cookie, first_eid, limit=8)
            except Exception as e:
                print(f"[Test] FEHLER Media-Query: {e}")
                sys.exit(1)
            print(f"[Test] {len(media_list)} Media-Assets:")
            for m in media_list[:8]:
                print(f"  · [{m['source']:>5}] {m['title'][:50]:50}  {m['url'][:90]}")

    asyncio.run(_run_test())
