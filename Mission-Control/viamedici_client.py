"""viamedici_client.py — ViaMedici API (Thieme) mit Keycloak Silent-Refresh.

Auth-Strategie (keycloak-js-Style):
  1. Nutzer pastet einmalig seine Keycloak-Session-Cookies von `authentication.thieme.de`
     (mindestens `KEYCLOAK_IDENTITY`, optional `KEYCLOAK_SESSION`, `AUTH_SESSION_ID`).
  2. Client macht bei Bedarf GET `/protocol/openid-connect/auth?prompt=none` mit diesen
     Cookies → Keycloak liefert 302 mit `?code=…` ODER `?error=login_required`.
  3. Bei code: POST `/token` mit grant_type=authorization_code → frisches 10-Min-Access-Token.
  4. Access-Token + Refresh-Token werden gecacht. Silent-Refresh solange KC-Session lebt
     (typisch 30 Tage bei „angemeldet bleiben"; rotiert serverseitig).

API-Endpoints (aus /api/v3/api-docs):
  - POST /api/search/learning-modules     → Volltext-Suche
  - POST /api/search/media                → Bild-Suche
  - GET  /api/module/content?assetId=&slug=  → Modul-Content (HTML)
  - GET  /api/module/meta?assetId=&slug=     → Modul-Metadaten
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import secrets
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import aiohttp

# --- Endpoints ---------------------------------------------------------------

_VIAMEDICI_API = "https://viamedici.thieme.de/api"
_VIAMEDICI_ORIGIN = "https://viamedici.thieme.de"

_KC_BASE = "https://authentication.thieme.de/realms/master/protocol/openid-connect"
_KC_AUTH_ENDPOINT = f"{_KC_BASE}/auth"
_KC_TOKEN_ENDPOINT = f"{_KC_BASE}/token"

# Client-ID aus JWT-Capture
_KC_CLIENT_ID = "via-medici-spa-2024"
# Keycloak-registrierte redirect_uri — die SPA nutzt typischerweise die Seite selber.
# Bei Fehler `Invalid parameter: redirect_uri` müssen wir das JS-Bundle prüfen.
_KC_REDIRECT_URI = "https://viamedici.thieme.de/silent-check-sso.html"
_KC_FALLBACK_REDIRECT_URIS = [
    "https://viamedici.thieme.de/",
    "https://viamedici.thieme.de/assets/silent-check-sso.html",
]
# `offline_access` → Refresh-Token überlebt SSO-Session-Ende (typ. 30 Tage statt 19 h).
# User-Token trägt die Realm-Rolle `offline_access`, Client sollte es erlauben.
# Falls KC den Scope ablehnt (`invalid_scope`), fallen wir auf den SPA-Default zurück.
_KC_SCOPE_PRIMARY = "openid profile email taal offline_access"
_KC_SCOPE_FALLBACK = "openid profile email taal"

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)

_API_HEADERS_BASE = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": _VIAMEDICI_ORIGIN,
    "Referer": f"{_VIAMEDICI_ORIGIN}/",
    "User-Agent": _USER_AGENT,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}

_VALID_IMG_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}


# --- Cookie / Token Cache ----------------------------------------------------

def _cache_path(uploads_dir: Path) -> Path:
    return uploads_dir.parent / "viamedici_auth_cache.json"


def _load_cache(uploads_dir: Path) -> dict:
    p = _cache_path(uploads_dir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return {}


def _save_cache(uploads_dir: Path, data: dict):
    p = _cache_path(uploads_dir)
    data = {**data, "saved_at": int(time.time())}
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _load_kc_cookies(uploads_dir: Path) -> str | None:
    return (_load_cache(uploads_dir).get("kc_cookies") or "").strip() or None


def save_kc_cookies(uploads_dir: Path, cookies: str):
    c = _load_cache(uploads_dir)
    c["kc_cookies"] = cookies.strip()
    # Access-Token & Refresh-Token verwerfen — wir holen frische mit neuen Cookies
    c.pop("access_token", None)
    c.pop("access_token_exp", None)
    c.pop("refresh_token", None)
    _save_cache(uploads_dir, c)


def saved_at(uploads_dir: Path) -> int | None:
    ts = _load_cache(uploads_dir).get("saved_at")
    return int(ts) if ts else None


def get_session_info(uploads_dir: Path) -> dict:
    """Extrahiert echte Ablaufzeiten aus gecachten JWTs und Cookies.
    Gibt Dict mit {kc_identity_exp, refresh_token_exp, access_token_exp,
    is_offline, scope} zurück — Werte sind Unix-Timestamps oder None.
    """
    cache = _load_cache(uploads_dir)
    info: dict = {
        "kc_identity_exp": None,
        "refresh_token_exp": None,
        "access_token_exp": cache.get("access_token_exp"),
        "is_offline": False,
        "scope": None,
    }

    # KEYCLOAK_IDENTITY exp aus Cookie (ist ein signed JWT)
    cookies_raw = cache.get("kc_cookies") or ""
    for pair in cookies_raw.split(";"):
        if "=" not in pair:
            continue
        name, _, value = pair.partition("=")
        if name.strip() == "KEYCLOAK_IDENTITY":
            info["kc_identity_exp"] = _jwt_exp(value.strip())
            break

    # Refresh-Token exp + scope
    rt = cache.get("refresh_token")
    if rt:
        info["refresh_token_exp"] = _jwt_exp(rt)
        try:
            payload_b64 = rt.split(".")[1]
            payload_b64 += "=" * (-len(payload_b64) % 4)
            payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
            scope = payload.get("scope", "") or ""
            info["scope"] = scope
            # KC signalisiert Offline-Token entweder via scope oder typ=Offline
            info["is_offline"] = (
                "offline_access" in scope or payload.get("typ") == "Offline"
            )
        except Exception:
            pass

    return info


# --- JWT-Decode (nur payload, keine Signatur-Prüfung) ------------------------

def _jwt_exp(token: str) -> int | None:
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
        return int(payload.get("exp") or 0) or None
    except Exception:
        return None


# --- PKCE --------------------------------------------------------------------

def _pkce_pair() -> tuple[str, str]:
    """Gibt (verifier, challenge) zurück. S256-Methode."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).decode().rstrip("=")
    return verifier, challenge


# --- Cookie-Header-Normalisierung --------------------------------------------

def _normalize_kc_cookies(raw: str) -> str:
    """Akzeptiert:
      - `document.cookie`-Output (alle Cookies, auch Fremd-Domain-Kram)
      - Tab-separiertes DevTools-Application-Format
      - Reine `Name=Value; Name=Value` Strings
    Extrahiert nur die Keycloak-relevanten Cookies.
    """
    raw = raw.strip()
    if not raw:
        return ""

    # DevTools-Format hat Tabs und Zeilen; splitte nach newline
    pairs: dict[str, str] = {}
    keycloak_keys = {"KEYCLOAK_IDENTITY", "KEYCLOAK_SESSION", "AUTH_SESSION_ID",
                     "KEYCLOAK_REMEMBER_ME", "KC_RESTART"}
    tricky_ts_prefix = "TS"  # Thieme-interne TS01…/TS27… Session-Cookies — nice-to-have

    # Wenn es Zeilen gibt (Multi-Line), jede Zeile parsen
    if "\n" in raw or "\t" in raw:
        for line in raw.splitlines():
            parts = [p for p in re.split(r"\t+|\s{2,}", line.strip()) if p]
            if len(parts) >= 2:
                name, value = parts[0].strip(), parts[1].strip()
                if name in keycloak_keys or name.startswith(tricky_ts_prefix):
                    pairs[name] = value
    else:
        # `Name=Value; Name=Value` Format
        for item in raw.split(";"):
            if "=" not in item:
                continue
            name, _, value = item.partition("=")
            name = name.strip()
            value = value.strip()
            if name in keycloak_keys or name.startswith(tricky_ts_prefix):
                pairs[name] = value

    if not pairs:
        # Fallback: wenn gar nichts erkannt, nehm den String roh (vielleicht hat der User
        # den Cookie-Header direkt aus einer Network-Zeile kopiert)
        return raw

    return "; ".join(f"{k}={v}" for k, v in pairs.items())


# --- Silent-Auth-Flow --------------------------------------------------------

class SilentAuthError(RuntimeError):
    """OAuth-Fehler aus dem Silent-Auth-Endpoint. `code` ist der OAuth-Error-Code."""
    def __init__(self, code: str, description: str = ""):
        self.code = code
        self.description = description
        if code == "login_required":
            msg = ("Thieme-Session abgelaufen — bitte bei authentication.thieme.de "
                   "neu einloggen und Cookies frisch pasten")
        elif code == "invalid_scope":
            msg = f"Keycloak hat Scope abgelehnt: {description or code}"
        else:
            msg = f"Silent-Auth Fehler: {code}" + (f" — {description}" if description else "")
        super().__init__(msg)


async def _silent_auth_code(
    session: aiohttp.ClientSession,
    kc_cookies: str,
    redirect_uri: str,
    scope: str,
) -> tuple[str, str]:
    """Führt `prompt=none` Silent-Auth durch. Gibt (code, code_verifier) zurück.
    Wirft SilentAuthError mit OAuth-Code bei KC-Fehlern."""
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(16)
    nonce = secrets.token_urlsafe(16)

    params = {
        "client_id": _KC_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": scope,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "nonce": nonce,
        "prompt": "none",
        "response_mode": "query",
    }
    url = _KC_AUTH_ENDPOINT + "?" + "&".join(
        f"{k}={quote(str(v), safe='')}" for k, v in params.items()
    )

    headers = {"Cookie": kc_cookies, "User-Agent": _USER_AGENT,
               "Accept": "text/html,*/*"}

    async with session.get(url, headers=headers, allow_redirects=False,
                           timeout=aiohttp.ClientTimeout(total=15)) as resp:
        # Erfolg: 302/303 mit Location
        if resp.status in (301, 302, 303, 307):
            loc = resp.headers.get("Location", "")
            parsed = urlparse(loc)
            qs = parse_qs(parsed.query)
            if "error" in qs:
                raise SilentAuthError(
                    qs.get("error", ["?"])[0],
                    qs.get("error_description", [""])[0],
                )
            code = (qs.get("code") or [None])[0]
            if not code:
                raise RuntimeError(f"Silent-Auth: kein code in redirect, Location={loc[:200]}")
            return code, verifier

        # Oft 200 mit HTML-Fehlerseite (z.B. Session abgelaufen)
        body = await resp.text()
        snippet = body[:300]
        if "session" in body.lower() and ("not active" in body.lower() or "invalid" in body.lower()):
            raise SilentAuthError("login_required", "session not active")
        raise RuntimeError(f"Silent-Auth HTTP {resp.status}: {snippet}")


async def _exchange_code(
    session: aiohttp.ClientSession,
    code: str,
    verifier: str,
    redirect_uri: str,
) -> dict:
    """Tauscht Auth-Code gegen Access-Token + Refresh-Token."""
    data = {
        "grant_type": "authorization_code",
        "client_id": _KC_CLIENT_ID,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    }
    async with session.post(
        _KC_TOKEN_ENDPOINT, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json", "User-Agent": _USER_AGENT},
        timeout=aiohttp.ClientTimeout(total=15),
    ) as resp:
        body_txt = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"Token-Exchange HTTP {resp.status}: {body_txt[:300]}")
        return json.loads(body_txt)


async def _refresh_with_refresh_token(
    session: aiohttp.ClientSession,
    refresh_token: str,
) -> dict | None:
    """Nutzt Refresh-Token. Gibt None zurück wenn Token abgelaufen/ungültig."""
    data = {
        "grant_type": "refresh_token",
        "client_id": _KC_CLIENT_ID,
        "refresh_token": refresh_token,
    }
    try:
        async with session.post(
            _KC_TOKEN_ENDPOINT, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "Accept": "application/json", "User-Agent": _USER_AGENT},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            body_txt = await resp.text()
            if resp.status != 200:
                print(f"[ViaMedici] Refresh-Token nicht nutzbar (HTTP {resp.status}), fallback auf Silent-Auth")
                return None
            return json.loads(body_txt)
    except Exception as e:
        print(f"[ViaMedici] Refresh-Token Fehler: {e}")
        return None


async def ensure_access_token(uploads_dir: Path, leeway_sec: int = 30) -> str:
    """Gibt einen gültigen Access-Token zurück. Refresht automatisch wenn nötig.
    Strategie: Cache → Refresh-Token → Silent-Auth → Fehler.
    """
    cache = _load_cache(uploads_dir)
    now = int(time.time())

    # 1. Cache noch gültig?
    tok = cache.get("access_token")
    exp = cache.get("access_token_exp") or 0
    if tok and exp and now < (exp - leeway_sec):
        return tok

    kc_cookies = (cache.get("kc_cookies") or "").strip()
    if not kc_cookies:
        raise RuntimeError("Keine Keycloak-Cookies gecached — bitte im Medizin-Tab pasten")

    connector = aiohttp.TCPConnector(ssl=True)
    async with aiohttp.ClientSession(connector=connector) as session:
        # 2. Refresh-Token probieren (schneller als Silent-Auth)
        rt = cache.get("refresh_token")
        if rt:
            result = await _refresh_with_refresh_token(session, rt)
            if result and result.get("access_token"):
                _update_tokens_in_cache(uploads_dir, result)
                return result["access_token"]

        # 3. Silent-Auth mit KC-Cookies. Primary-Scope enthält offline_access
        # (gibt langlebigen Refresh-Token) — bei invalid_scope fallen wir zurück.
        last_err: Exception | None = None
        for scope in (_KC_SCOPE_PRIMARY, _KC_SCOPE_FALLBACK):
            for redirect_uri in [_KC_REDIRECT_URI, *_KC_FALLBACK_REDIRECT_URIS]:
                try:
                    code, verifier = await _silent_auth_code(
                        session, kc_cookies, redirect_uri, scope,
                    )
                    result = await _exchange_code(session, code, verifier, redirect_uri)
                    if result.get("access_token"):
                        print(f"[ViaMedici] Silent-Auth OK (scope={scope.split()[-1]}, "
                              f"redirect_uri={redirect_uri})")
                        _update_tokens_in_cache(uploads_dir, result)
                        return result["access_token"]
                except SilentAuthError as e:
                    last_err = e
                    # Falsche redirect_uri → nächste URI probieren
                    if e.code == "invalid_redirect_uri" or (
                        "redirect" in (e.description or "").lower()
                    ):
                        continue
                    # invalid_scope → break aus URI-Loop, probiere Fallback-Scope
                    if e.code == "invalid_scope":
                        print(f"[ViaMedici] Scope '{scope}' abgelehnt — Fallback ohne offline_access")
                        break
                    # Andere (login_required, access_denied, …) → User muss neu pasten
                    raise
                except Exception as e:
                    last_err = e
                    err_s = str(e)
                    if "redirect" in err_s.lower() and "invalid" in err_s.lower():
                        continue
                    raise

        raise RuntimeError(f"Silent-Auth mit allen Redirect-URIs fehlgeschlagen: {last_err}")


def _update_tokens_in_cache(uploads_dir: Path, token_response: dict):
    cache = _load_cache(uploads_dir)
    at = token_response.get("access_token")
    rt = token_response.get("refresh_token")
    expires_in = int(token_response.get("expires_in") or 600)
    cache["access_token"] = at
    cache["access_token_exp"] = int(time.time()) + expires_in
    if rt:
        cache["refresh_token"] = rt
    _save_cache(uploads_dir, cache)


# --- API-Calls ---------------------------------------------------------------

async def _api_get(
    session: aiohttp.ClientSession,
    access_token: str,
    path: str,
    params: dict | None = None,
) -> dict | list | str:
    headers = {**_API_HEADERS_BASE, "Authorization": f"Bearer {access_token}"}
    async with session.get(
        f"{_VIAMEDICI_API}{path}", params=params, headers=headers,
        timeout=aiohttp.ClientTimeout(total=20),
    ) as resp:
        if resp.status == 401:
            raise RuntimeError(f"401 Unauthorized auf {path} — Token abgelaufen")
        if resp.status != 200:
            body_txt = await resp.text()
            raise RuntimeError(f"ViaMedici GET {path} HTTP {resp.status}: {body_txt[:200]}")
        ct = resp.headers.get("Content-Type", "")
        if "json" in ct:
            return await resp.json()
        return await resp.text()


async def _api_post(
    session: aiohttp.ClientSession,
    access_token: str,
    path: str,
    body: dict,
) -> dict:
    headers = {**_API_HEADERS_BASE, "Authorization": f"Bearer {access_token}",
               "Content-Type": "application/json"}
    async with session.post(
        f"{_VIAMEDICI_API}{path}", json=body, headers=headers,
        timeout=aiohttp.ClientTimeout(total=20),
    ) as resp:
        if resp.status == 401:
            raise RuntimeError(f"401 Unauthorized auf {path} — Token abgelaufen")
        body_txt = await resp.text()
        if resp.status not in (200, 202):
            raise RuntimeError(f"ViaMedici POST {path} HTTP {resp.status}: {body_txt[:200]}")
        return json.loads(body_txt) if body_txt else {}


async def search_learning_modules(
    session: aiohttp.ClientSession,
    access_token: str,
    query: str,
    limit: int = 5,
) -> list[dict]:
    """Gibt Liste von {assetId, slug, title, snippet} zurück."""
    result = await _api_post(
        session, access_token, "/search/learning-modules",
        {"searchTerm": query, "searchFacets": None, "direction": "asc",
         "pagination": {"start": 1, "end": limit}},
    )
    entries = result.get("entries") or []
    out = []
    for e in entries[:limit]:
        asset_id = e.get("assetId") or ""
        slug = e.get("slug") or e.get("url") or ""  # Slug-Feld-Name prüfen
        title = _extract_plain_text(e.get("title"))
        snippet = _extract_plain_text(e.get("content"))
        out.append({"assetId": asset_id, "slug": slug, "title": title, "snippet": snippet})
    return out


async def search_media(
    session: aiohttp.ClientSession,
    access_token: str,
    query: str,
    limit: int = 10,
) -> list[dict]:
    """Sucht Bild-Treffer. Baut URLs aus imageRef → `/api/images/original/{imageRef}`.
    Gibt Liste von {url, title, source, assetId, slug} zurück.
    """
    result = await _api_post(
        session, access_token, "/search/media",
        {"searchTerm": query, "searchFacets": None,
         "pagination": {"start": 1, "end": limit}},
    )
    entries = result.get("entries") or []
    out = []
    for e in entries[:limit]:
        image_ref = e.get("imageRef") or ""
        if not image_ref:
            continue
        url = f"{_VIAMEDICI_API}/images/original/{image_ref}"
        out.append({
            "url": url,
            "title": _extract_plain_text(e.get("title")),
            "source": e.get("source") or "",
            "assetId": e.get("assetId") or "",
            "slug": e.get("slug") or "",
            "imageRef": image_ref,
        })
    return out


async def fetch_module_content(
    session: aiohttp.ClientSession,
    access_token: str,
    asset_id: str,
    slug: str,
) -> str:
    """Gibt Modul-Content als bereinigter Plaintext zurück.
    Response-Struktur: {preview, content, definitions, linkMapping, imppCompact,
                         crashCourse, practiceMode} — jeweils Listen von strukturierten
                         {key, props, children, value}-Bäumen.
    Wir nutzen `content` (Haupt) + `imppCompact` (Zusammenfassung) + `crashCourse`
    (didaktisch verdichtet) — das ist das was Claude für Karten braucht.
    """
    result = await _api_get(
        session, access_token, "/module/content",
        {"assetId": asset_id, "slug": slug},
    )
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except Exception:
            return result
    if not isinstance(result, dict):
        return ""

    parts: list[str] = []
    # imppCompact zuerst — das ist die hochdichte IMPP-Zusammenfassung
    for src_key in ("imppCompact", "content", "crashCourse"):
        src = result.get(src_key)
        if not src:
            continue
        text = _extract_plain_text(src).strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


async def fetch_module_meta(
    session: aiohttp.ClientSession,
    access_token: str,
    asset_id: str,
    slug: str,
) -> dict:
    result = await _api_get(
        session, access_token, "/module/meta",
        {"assetId": asset_id, "slug": slug},
    )
    return result if isinstance(result, dict) else {}


# --- Text-Extraktion aus strukturierten Snippets + HTML ----------------------

_BLOCK_KEYS = {"section", "p", "div", "li", "ul", "ol", "tr", "td", "th",
               "h1", "h2", "h3", "h4", "h5", "h6", "br"}


def _extract_plain_text(node) -> str:
    """ViaMedici-Suche/Content liefert Text als verschachtelte {key,props,children,value}-Bäume.
    Rekursiv alle `value`-Strings einsammeln. Block-Elemente bekommen ein Trennzeichen
    damit nicht „DiagnostikExamenH25Bei" zusammenklebt."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        k = node.get("key")
        if k == "text" and "value" in node:
            return str(node["value"])
        children = node.get("children") or []
        inner = "".join(_extract_plain_text(c) for c in children)
        if k in _BLOCK_KEYS:
            return inner + " "
        return inner
    if isinstance(node, list):
        return "".join(_extract_plain_text(c) for c in node)
    return ""


_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_html(html: str) -> str:
    if not html:
        return ""
    text = _HTML_TAG_RE.sub(" ", html)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", '"').replace("&#39;", "'"))
    return _WHITESPACE_RE.sub(" ", text).strip()


# --- Download-Helper ---------------------------------------------------------

async def _download_image(
    session: aiohttp.ClientSession,
    url: str,
    dest: Path,
    access_token: str | None = None,
) -> bool:
    headers = {"User-Agent": _USER_AGENT, "Referer": f"{_VIAMEDICI_ORIGIN}/"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    try:
        async with session.get(url, headers=headers,
                               timeout=aiohttp.ClientTimeout(total=20)) as resp:
            if resp.status != 200:
                print(f"[ViaMedici] Download HTTP {resp.status}: {url[:80]}")
                return False
            ct = resp.headers.get("Content-Type", "")
            if "image/" not in ct.lower():
                print(f"[ViaMedici] Download Content-Type '{ct}' kein Bild: {url[:80]}")
                return False
            dest.write_bytes(await resp.read())
            return True
    except Exception as e:
        print(f"[ViaMedici] Download-Fehler {url[:80]}: {e}")
        return False


# --- Haupt-Orchestrierung (für server.py) ------------------------------------

async def fetch_viamedici_context(
    uploads_dir: Path,
    terms: list[str],
    subject: str,
    images_per_term: int = 4,
    text_per_article: int = 2500,
) -> dict:
    """Orchestriert: Silent-Refresh → Suche → Content + Media → Download.
    Returns: `{"image_paths": [...], "article_texts": [{title, assetId, text}, ...]}`.
    Schreibt source_meta.json ins Subject-Dir. Alle Exceptions werden intern gelogged
    und gemsluckt (nicht-fatal für Kartengen).
    """
    import uuid as _uuid

    out: dict = {"image_paths": [], "article_texts": []}

    try:
        access_token = await ensure_access_token(uploads_dir)
    except Exception as e:
        print(f"[ViaMedici] Auth fehlgeschlagen: {e}")
        return out

    subj_slug = (subject or "medizin").lower().replace(" ", "_")
    img_dir = uploads_dir / "images" / f"viamedici_{subj_slug}"
    img_dir.mkdir(parents=True, exist_ok=True)

    search_terms = list(terms) if terms else []
    if subject and subject not in search_terms:
        search_terms.append(subject)

    entries: list[dict] = []
    article_texts: list[dict] = []
    seen_assets: set[str] = set()
    connector = aiohttp.TCPConnector(ssl=True)
    async with aiohttp.ClientSession(connector=connector) as session:
        for term in search_terms[:4]:
            # 1. Lernmodul-Suche
            try:
                modules = await search_learning_modules(session, access_token, term, limit=4)
            except Exception as e:
                print(f"[ViaMedici] Suche '{term}' fehlgeschlagen: {e}")
                continue
            if not modules:
                print(f"[ViaMedici] Keine Module für '{term}'")
                continue
            print(f"[ViaMedici] Suche '{term}': {len(modules)} Module")

            # 2. Top-2 Module: Content holen
            for mod in modules[:2]:
                asset_id = mod.get("assetId")
                slug = mod.get("slug")
                if not asset_id or asset_id in seen_assets:
                    continue
                seen_assets.add(asset_id)
                title = mod.get("title") or ""

                if slug:
                    try:
                        text = await fetch_module_content(session, access_token, asset_id, slug)
                        # Whitespace aufräumen (fetch_module_content liefert schon Plaintext)
                        text = _WHITESPACE_RE.sub(" ", text).strip()
                        if len(text) > text_per_article:
                            text = text[:text_per_article].rsplit(" ", 1)[0] + "…"
                        if text:
                            article_texts.append({
                                "assetId": asset_id, "title": title, "text": text,
                            })
                            print(f"[ViaMedici] Modul {asset_id} ({title[:40]}): {len(text)} Zeichen")
                    except Exception as e:
                        print(f"[ViaMedici] Content {asset_id} fehlgeschlagen: {e}")

            # 3. Media-Suche — direkt Bilder über dedizierten Endpoint
            try:
                media = await search_media(session, access_token, term, limit=images_per_term)
            except Exception as e:
                print(f"[ViaMedici] Media-Suche '{term}' fehlgeschlagen: {e}")
                continue

            for m in media:
                url = m["url"]
                path_part = url.split("?", 1)[0]
                ext = path_part.rsplit(".", 1)[-1].lower()
                if ext not in _VALID_IMG_EXTENSIONS:
                    ext = "jpg"
                fname = f"viamedici_{_uuid.uuid4().hex[:8]}.{ext}"
                dest = img_dir / fname
                ok = await _download_image(session, url, dest, access_token=access_token)
                if ok:
                    rel = str(dest.relative_to(uploads_dir)).replace("\\", "/")
                    title = (m.get("title") or "").strip()
                    source = (m.get("source") or "").strip()
                    caption = f"{title} — {source}" if title and source else (title or source)
                    entries.append({
                        "path": rel, "source": "viamedici",
                        "caption": caption, "provider": "Thieme ViaMedici",
                    })
                    print(f"[ViaMedici] Gespeichert: {fname} ← {caption[:70]}")

    # source_meta.json
    if entries:
        try:
            meta_path = img_dir / "source_meta.json"
            existing: list[dict] = []
            if meta_path.exists():
                try:
                    existing = json.loads(meta_path.read_text("utf-8"))
                except Exception:
                    existing = []
            existing_paths = {e["path"] for e in existing if isinstance(e, dict) and "path" in e}
            merged = existing + [e for e in entries if e["path"] not in existing_paths]
            meta_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
        except Exception as me:
            print(f"[ViaMedici] source_meta.json schreiben fehlgeschlagen: {me}")

    print(f"[ViaMedici] {len(entries)} Bilder + {len(article_texts)} Texte gesamt für '{subject}'")
    out["image_paths"] = [e["path"] for e in entries]
    out["article_texts"] = article_texts
    return out


# --- Standalone-Test ---------------------------------------------------------

if __name__ == "__main__":
    import sys

    async def _test():
        here = Path(__file__).parent
        uploads_dir = here / "data" / "uploads"
        uploads_dir.mkdir(parents=True, exist_ok=True)

        if "--save-cookies" in sys.argv:
            # python viamedici_client.py --save-cookies "KEYCLOAK_IDENTITY=…; KEYCLOAK_SESSION=…"
            idx = sys.argv.index("--save-cookies")
            cookies = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else ""
            if not cookies:
                print("Keine Cookies übergeben."); sys.exit(1)
            save_kc_cookies(uploads_dir, _normalize_kc_cookies(cookies))
            print(f"Cookies gespeichert nach: {_cache_path(uploads_dir)}")
            sys.exit(0)

        try:
            token = await ensure_access_token(uploads_dir)
        except Exception as e:
            print(f"[Test] Auth-Fehler: {e}")
            sys.exit(1)

        exp = _jwt_exp(token) or 0
        print(f"[Test] Access-Token OK, läuft in {max(0, exp - int(time.time()))}s ab")

        term = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "Herzinsuffizienz"

        async with aiohttp.ClientSession() as session:
            print(f"\n[Test] → Lernmodul-Suche '{term}'")
            mods = await search_learning_modules(session, token, term, limit=3)
            for m in mods:
                print(f"  · {m['assetId']:>10}  {m['title'][:60]}")

            print(f"\n[Test] → Media-Suche '{term}'")
            med = await search_media(session, token, term, limit=5)
            for m in med:
                print(f"  · {m['url'][:100]}  — {m['title'][:50]}")

            if mods:
                m = mods[0]
                print(f"\n[Test] → Modul-Content für {m['assetId']} / {m['slug']}")
                try:
                    content = await fetch_module_content(session, token, m["assetId"], m["slug"])
                    plain = _strip_html(content)
                    print(f"  → {len(content)} Zeichen HTML, {len(plain)} Zeichen Plaintext")
                    print(f"  Snippet: {plain[:300]}")
                except Exception as e:
                    print(f"  FEHLER: {e}")

    asyncio.run(_test())
