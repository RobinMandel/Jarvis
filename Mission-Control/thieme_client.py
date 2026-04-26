"""thieme_client.py — Thieme Connect Auth + Bild-Abruf für Mission Control.

Verwendet Robins Thieme-Account (config.json: thieme_email / thieme_password)
um direkt Bilder aus Thieme-Inhalten zu laden.

Session-Cookies werden gecacht in data/thieme_token_cache.json (kein Passwort).

HINWEIS: Thieme nutzt session-cookie-basierte Auth (kein GraphQL/JWT wie Amboss).
Falls sich die Login-URL ändert, passe _THIEME_LOGIN_URL an.
"""

import json
import time
from pathlib import Path

import aiohttp

_THIEME_LOGIN_URL = "https://www.thieme-connect.de/products/login"
_THIEME_SEARCH_URL = "https://www.thieme-connect.de/products/ejournals/search"
_THIEME_BASE = "https://www.thieme-connect.de"

_LOGIN_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}


def _token_cache_path(uploads_dir: Path) -> Path:
    return uploads_dir.parent / "thieme_token_cache.json"


def _load_cached_cookies(uploads_dir: Path) -> dict | None:
    """Legacy: gibt gecachte Cookies-Dict aus Form-Login zurück wenn noch mind. 10 Min gültig.
    Neue Default-Strategie: cookie-string via `_load_cached_cookie_string`."""
    cache = _token_cache_path(uploads_dir)
    if not cache.exists():
        return None
    try:
        data = json.loads(cache.read_text("utf-8"))
        expires_at = data.get("expires_at", 0)
        if time.time() < expires_at - 600:
            return data.get("cookies")
    except Exception:
        pass
    return None


def _save_cookies(uploads_dir: Path, cookies: dict, expires_at: int | None = None):
    cache = _token_cache_path(uploads_dir)
    expiry = expires_at or int(time.time()) + 3600 * 8  # Fallback: 8h
    cache.write_text(
        json.dumps({"cookies": cookies, "expires_at": expiry}, indent=2),
        encoding="utf-8",
    )


# --- Cookie-String-Path (wie Amboss) ---

def _cookie_string_cache_path(uploads_dir: Path) -> Path:
    return uploads_dir.parent / "thieme_cookie_cache.json"


def _load_cached_cookie_string(uploads_dir: Path) -> str | None:
    cache = _cookie_string_cache_path(uploads_dir)
    if not cache.exists():
        return None
    try:
        data = json.loads(cache.read_text("utf-8"))
        return (data.get("cookie") or "").strip() or None
    except Exception:
        return None


def _save_cookie_string(uploads_dir: Path, cookie: str):
    cache = _cookie_string_cache_path(uploads_dir)
    cache.write_text(
        json.dumps({"cookie": cookie.strip(), "saved_at": int(time.time())}, indent=2),
        encoding="utf-8",
    )


def _cookie_string_saved_at(uploads_dir: Path) -> int | None:
    cache = _cookie_string_cache_path(uploads_dir)
    if not cache.exists():
        return None
    try:
        data = json.loads(cache.read_text("utf-8"))
        ts = data.get("saved_at")
        return int(ts) if ts else None
    except Exception:
        return None


async def _test_cookie_string(cookie: str) -> dict:
    """Verifiziert Thieme-Cookie durch GET auf eine auth-gated Seite.
    Heuristik: wenn Response ein Login-Formular (`name="password"`) enthält oder auf
    `/login` redirected → abgelaufen/ungültig. Sonst → gültig.
    Returns: {ok: bool, message: str}
    """
    headers = {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "de-DE,de;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "Cookie": cookie,
    }
    # Root-Seite — existiert immer, redirected ggf. zur Login-Seite wenn nicht eingeloggt
    probe_url = f"{_THIEME_BASE}/products/ejournals/"
    connector = aiohttp.TCPConnector(ssl=True)
    async with aiohttp.ClientSession(connector=connector) as sess:
        try:
            async with sess.get(probe_url, headers=headers, allow_redirects=True,
                                timeout=aiohttp.ClientTimeout(total=15)) as resp:
                status = resp.status
                final_url = str(resp.url)
                body = await resp.text()
        except Exception as e:
            return {"ok": False, "message": f"Verbindungsfehler: {e}"}

    looks_logged_in = ('name="password"' not in body
                       and "/login" not in final_url.lower()
                       and status < 400)
    return {
        "ok": looks_logged_in,
        "message": (
            f"HTTP {status} — Thieme erreichbar, Cookie akzeptiert"
            if looks_logged_in
            else f"HTTP {status} — Thieme scheint nicht eingeloggt (Cookie abgelaufen?)"
        ),
    }


async def _get_cookies(session: aiohttp.ClientSession, email: str, password: str, uploads_dir: Path) -> dict:
    """Login + Cookie-Caching. Wirft Exception bei Fehler."""
    cached = _load_cached_cookies(uploads_dir)
    if cached:
        print("[Thieme] Cookies aus Cache geladen")
        return cached

    print(f"[Thieme] Einloggen als {email}…")
    payload = {
        "username": email,
        "password": password,
        "remember": "on",
        "submit": "Login",
    }
    async with session.post(
        _THIEME_LOGIN_URL,
        data=payload,
        headers=_LOGIN_HEADERS,
        allow_redirects=True,
        timeout=aiohttp.ClientTimeout(total=20),
    ) as resp:
        if resp.status not in (200, 302):
            body = await resp.text()
            raise RuntimeError(f"Thieme Login HTTP {resp.status}: {body[:300]}")
        # Prüfe ob Login erfolgreich war (keine Login-Seite mehr in Response)
        body_text = await resp.text()
        if 'name="password"' in body_text or "login" in str(resp.url).lower():
            raise RuntimeError("Thieme Login fehlgeschlagen — Credentials prüfen oder URL anpassen")

        cookies = {k: v.value for k, v in session.cookie_jar._cookies.items()
                   if not isinstance(v, dict)}
        # Einfacherer Cookie-Extrakt
        raw_cookies = {}
        for c in session.cookie_jar:
            raw_cookies[c.key] = c.value

    if not raw_cookies:
        raise RuntimeError("Thieme: keine Session-Cookies nach Login — Login-URL prüfen")

    _save_cookies(uploads_dir, raw_cookies)
    print("[Thieme] Login erfolgreich, Cookies gecacht")
    return raw_cookies


async def _search_images(
    session: aiohttp.ClientSession,
    cookies: dict,
    term: str,
    limit: int = 5,
) -> list[dict]:
    """Sucht Bilder auf Thieme Connect — gibt [{url, alt}] zurück."""
    params = {"query": term, "type": "figure"}
    headers = {
        "Accept": "application/json, text/html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items()),
    }
    try:
        async with session.get(
            _THIEME_SEARCH_URL,
            params=params,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                print(f"[Thieme] Suche '{term}' HTTP {resp.status}: {body[:200]}")
                return []
            body_text = await resp.text()
    except Exception as e:
        print(f"[Thieme] Suche-Fehler: {e}")
        return []

    # Bilder aus HTML extrahieren (Thieme gibt keine JSON-API für Bilder zurück)
    import re
    images = []
    for m in re.finditer(r'<img[^>]+src="([^"]+thieme-connect[^"]*\.(?:jpg|jpeg|png|gif|webp))"[^>]*(?:alt="([^"]*)")?', body_text, re.IGNORECASE):
        url = m.group(1)
        alt = m.group(2) or ""
        if url.startswith("//"):
            url = "https:" + url
        if url and len(images) < limit:
            images.append({"url": url, "alt": alt})

    return images


async def _download_image(session: aiohttp.ClientSession, url: str, dest: Path) -> bool:
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status != 200:
                return False
            data = await resp.read()
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"[Thieme] Download-Fehler {url}: {e}")
        return False

