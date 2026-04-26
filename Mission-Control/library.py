"""library.py — Persistente Image-Library + Avatare fuers Image Lab.

Layout:
    data/images-library/
        _inbox/                  ← Default fuer frisch generierte Bilder
        <custom-folder>/         ← Robin's Folders
        ...
    avatars/
        <person>/
            person.json          ← {name, description, style_hints, ...}
            references/<file>    ← Robin's Reference-Photos
            generated/<file>     ← (optional) Bilder die mit dieser Person erzeugt wurden

Static-URLs werden in server.py gemountet:
    /library/<folder>/<file>     → IMAGES_LIBRARY_DIR
    /avatars/<person>/...        → AVATARS_DIR
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
INBOX_FOLDER = "_inbox"
_VALID_NAME = re.compile(r"^[a-zA-Z0-9 _\-äöüÄÖÜß]{1,40}$")


def _safe_folder_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ValueError("Folder-Name darf nicht leer sein")
    if name.startswith(".") or "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"Ungueltiger Folder-Name: {name!r}")
    if not _VALID_NAME.match(name):
        raise ValueError(f"Folder-Name nur Buchstaben/Zahlen/Leerzeichen/_-: {name!r}")
    return name


def _safe_filename(name: str) -> str:
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"Ungueltiger Dateiname: {name!r}")
    return name


# ============================================================================
# Image-Library
# ============================================================================

def ensure_library(library_dir: Path) -> None:
    library_dir.mkdir(parents=True, exist_ok=True)
    (library_dir / INBOX_FOLDER).mkdir(parents=True, exist_ok=True)


def list_folders(library_dir: Path) -> list[dict]:
    """Returns [{name, count, cover_url}]. _inbox immer zuerst."""
    ensure_library(library_dir)
    out = []
    folders = sorted(
        [p for p in library_dir.iterdir() if p.is_dir()],
        key=lambda p: (p.name != INBOX_FOLDER, p.name.lower()),
    )
    for f in folders:
        imgs = [p for p in f.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
        cover = None
        if imgs:
            newest = max(imgs, key=lambda p: p.stat().st_mtime)
            cover = f"/library/{f.name}/{newest.name}"
        out.append({
            "name": f.name,
            "count": len(imgs),
            "cover_url": cover,
        })
    return out


def list_images(library_dir: Path, folder: str | None = None) -> list[dict]:
    """Returns flat list von {folder, filename, url, mtime, size, day, meta?}.
    Wenn folder=None → alle Folders gemerged. Sortiert nach mtime DESC.
    Sidecar `<file>.meta.json` (prompt, enhanced_prompt, provider, model, size)
    wird falls vorhanden mitgeladen.
    """
    ensure_library(library_dir)
    out = []
    if folder:
        folder = _safe_folder_name(folder)
        folders = [library_dir / folder]
        if not folders[0].is_dir():
            return []
    else:
        folders = [p for p in library_dir.iterdir() if p.is_dir()]

    for f in folders:
        for p in f.iterdir():
            if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
                continue
            stat = p.stat()
            mtime = stat.st_mtime
            day = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")
            entry = {
                "folder": f.name,
                "filename": p.name,
                "url": f"/library/{f.name}/{p.name}",
                "mtime": mtime,
                "iso": datetime.fromtimestamp(mtime).isoformat(),
                "day": day,
                "size": stat.st_size,
            }
            meta = read_image_meta(p)
            if meta:
                entry["meta"] = meta
            out.append(entry)
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def _meta_path(image_path: Path) -> Path:
    """Sidecar-Pfad fuer ein Bild: foo.png → foo.png.meta.json."""
    return image_path.with_suffix(image_path.suffix + ".meta.json")


def write_image_meta(image_path: Path, meta: dict) -> None:
    """Schreibt Sidecar-Meta-File neben dem Bild."""
    try:
        _meta_path(image_path).write_text(
            json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except Exception as e:
        print(f"[Library] meta write failed for {image_path}: {e}")


def read_image_meta(image_path: Path) -> dict | None:
    mp = _meta_path(image_path)
    if not mp.is_file():
        return None
    try:
        return json.loads(mp.read_text(encoding="utf-8"))
    except Exception:
        return None


def list_grouped_by_day(library_dir: Path, folder: str | None = None) -> list[dict]:
    """Returns [{day: 'YYYY-MM-DD', images: [...]}], neueste Tage zuerst."""
    items = list_images(library_dir, folder)
    groups: dict[str, list] = {}
    for it in items:
        groups.setdefault(it["day"], []).append(it)
    return [
        {"day": d, "images": groups[d]}
        for d in sorted(groups.keys(), reverse=True)
    ]


def create_folder(library_dir: Path, name: str) -> dict:
    name = _safe_folder_name(name)
    if name == INBOX_FOLDER:
        raise ValueError("_inbox ist reserviert")
    target = library_dir / name
    if target.exists():
        raise FileExistsError(f"Folder {name!r} existiert bereits")
    target.mkdir(parents=True)
    return {"name": name, "count": 0, "cover_url": None}


def delete_folder(library_dir: Path, name: str, force: bool = False) -> int:
    """Deletes folder. Returns number of images that were inside.
    force=False AND folder non-empty → ValueError."""
    name = _safe_folder_name(name)
    if name == INBOX_FOLDER:
        raise ValueError("_inbox kann nicht geloescht werden")
    target = library_dir / name
    if not target.is_dir():
        raise FileNotFoundError(f"Folder {name!r} nicht gefunden")
    imgs = [p for p in target.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
    if imgs and not force:
        raise ValueError(f"Folder {name!r} enthaelt {len(imgs)} Bilder — force=true zum Loeschen")
    shutil.rmtree(target)
    return len(imgs)


def rename_folder(library_dir: Path, old: str, new: str) -> None:
    old = _safe_folder_name(old)
    new = _safe_folder_name(new)
    if old == INBOX_FOLDER or new == INBOX_FOLDER:
        raise ValueError("_inbox kann weder Quelle noch Ziel sein")
    src = library_dir / old
    dst = library_dir / new
    if not src.is_dir():
        raise FileNotFoundError(f"Folder {old!r} nicht gefunden")
    if dst.exists():
        raise FileExistsError(f"Folder {new!r} existiert bereits")
    src.rename(dst)


def move_image(library_dir: Path, src_folder: str, filename: str, dest_folder: str) -> str:
    src_folder = _safe_folder_name(src_folder)
    dest_folder = _safe_folder_name(dest_folder)
    filename = _safe_filename(filename)
    src = library_dir / src_folder / filename
    if not src.is_file():
        raise FileNotFoundError(f"{src_folder}/{filename} nicht gefunden")
    dest_dir = library_dir / dest_folder
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    if dest.exists():
        # gleichen Namen vermeiden — Suffix _2, _3 ...
        stem, suf = dest.stem, dest.suffix
        i = 2
        while (dest_dir / f"{stem}_{i}{suf}").exists():
            i += 1
        dest = dest_dir / f"{stem}_{i}{suf}"
    src.rename(dest)
    return f"/library/{dest_folder}/{dest.name}"


def delete_image(library_dir: Path, folder: str, filename: str) -> None:
    folder = _safe_folder_name(folder)
    filename = _safe_filename(filename)
    target = library_dir / folder / filename
    if not target.is_file():
        raise FileNotFoundError(f"{folder}/{filename} nicht gefunden")
    target.unlink()
    # Auch dazugehoerige .meta.json entsorgen falls vorhanden
    meta = target.with_suffix(target.suffix + ".meta.json")
    if meta.exists():
        meta.unlink()


# ============================================================================
# Avatare
# ============================================================================

def ensure_avatars(avatars_dir: Path) -> None:
    avatars_dir.mkdir(parents=True, exist_ok=True)


def list_avatars(avatars_dir: Path) -> list[dict]:
    """Returns [{name, description, ref_count, cover_url, created_at}]."""
    ensure_avatars(avatars_dir)
    out = []
    for p in sorted(avatars_dir.iterdir(), key=lambda x: x.name.lower()):
        if not p.is_dir():
            continue
        meta = _read_person_meta(p)
        refs_dir = p / "references"
        refs = []
        if refs_dir.is_dir():
            refs = [f for f in refs_dir.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
        cover = f"/avatars/{p.name}/references/{refs[0].name}" if refs else None
        out.append({
            "name": p.name,
            "description": meta.get("description", ""),
            "style_hints": meta.get("style_hints", ""),
            "ref_count": len(refs),
            "cover_url": cover,
            "created_at": meta.get("created_at"),
        })
    return out


def get_avatar(avatars_dir: Path, name: str) -> dict:
    name = _safe_folder_name(name)
    p = avatars_dir / name
    if not p.is_dir():
        raise FileNotFoundError(f"Avatar {name!r} nicht gefunden")
    meta = _read_person_meta(p)
    refs_dir = p / "references"
    refs = []
    if refs_dir.is_dir():
        for f in sorted(refs_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
                refs.append({
                    "filename": f.name,
                    "url": f"/avatars/{name}/references/{f.name}",
                    "size": f.stat().st_size,
                })
    return {
        "name": name,
        "description": meta.get("description", ""),
        "style_hints": meta.get("style_hints", ""),
        "created_at": meta.get("created_at"),
        "references": refs,
    }


def create_avatar(avatars_dir: Path, name: str, description: str = "", style_hints: str = "") -> dict:
    name = _safe_folder_name(name)
    p = avatars_dir / name
    if p.exists():
        raise FileExistsError(f"Avatar {name!r} existiert bereits")
    p.mkdir(parents=True)
    (p / "references").mkdir()
    (p / "generated").mkdir()
    meta = {
        "name": name,
        "description": description.strip(),
        "style_hints": style_hints.strip(),
        "created_at": datetime.now().isoformat(),
    }
    _write_person_meta(p, meta)
    return get_avatar(avatars_dir, name)


def update_avatar(avatars_dir: Path, name: str, *, description: str | None = None, style_hints: str | None = None) -> dict:
    name = _safe_folder_name(name)
    p = avatars_dir / name
    if not p.is_dir():
        raise FileNotFoundError(f"Avatar {name!r} nicht gefunden")
    meta = _read_person_meta(p)
    if description is not None:
        meta["description"] = description.strip()
    if style_hints is not None:
        meta["style_hints"] = style_hints.strip()
    _write_person_meta(p, meta)
    return get_avatar(avatars_dir, name)


def delete_avatar(avatars_dir: Path, name: str) -> None:
    name = _safe_folder_name(name)
    p = avatars_dir / name
    if not p.is_dir():
        raise FileNotFoundError(f"Avatar {name!r} nicht gefunden")
    shutil.rmtree(p)


def add_reference(avatars_dir: Path, name: str, filename: str, content: bytes) -> str:
    name = _safe_folder_name(name)
    filename = _safe_filename(filename)
    if Path(filename).suffix.lower() not in IMAGE_EXTS:
        raise ValueError(f"Nur Bilddateien erlaubt: {sorted(IMAGE_EXTS)}")
    p = avatars_dir / name / "references"
    p.mkdir(parents=True, exist_ok=True)
    target = p / filename
    if target.exists():
        stem, suf = target.stem, target.suffix
        i = 2
        while (p / f"{stem}_{i}{suf}").exists():
            i += 1
        target = p / f"{stem}_{i}{suf}"
    target.write_bytes(content)
    return f"/avatars/{name}/references/{target.name}"


def delete_reference(avatars_dir: Path, name: str, filename: str) -> None:
    name = _safe_folder_name(name)
    filename = _safe_filename(filename)
    target = avatars_dir / name / "references" / filename
    if not target.is_file():
        raise FileNotFoundError(f"Reference {filename!r} nicht gefunden")
    target.unlink()


def _read_person_meta(person_dir: Path) -> dict:
    meta_file = person_dir / "person.json"
    if not meta_file.is_file():
        return {}
    try:
        return json.loads(meta_file.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_person_meta(person_dir: Path, meta: dict) -> None:
    meta_file = person_dir / "person.json"
    meta_file.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
