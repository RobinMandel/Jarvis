"""Anki .apkg-Export mit Custom Note Types die das MC-Mockup-Design (card-mockup.html) nachbauen.

Einstiegspunkt: build_apkg(cards, subject, uploads_dir) -> bytes
- Cards mit Cloze-Syntax {{cN::...}} oder Occlusions landen als MC-Cloze.
- Cards ohne Cloze landen als MC-Basic.
- Image Occlusion: HTML-Overlay-Boxen über dem Bild, Labels als Cloze-Lücken
  (auf der Front leer/dunkel, auf der Back sichtbar — kein Spezial-Addon nötig).
- Inline-SVG/Mermaid bleibt im Back-HTML erhalten (SVG rendert nativ in Anki;
  Mermaid bleibt als Roh-Block, da Anki kein JS auf Mobile/Web ausführt).
"""

from __future__ import annotations

import io
import re
import uuid
from pathlib import Path

import genanki

# Stabile Model-IDs. Bei Design-Updates IDs **bumpen** + Name-Suffix anheben,
# damit Anki frische Note-Types anlegt (Anki überschreibt bestehende Modelle
# beim apkg-Import nicht — sonst bleibt das alte CSS aktiv).
MODEL_ID_BASIC = 1733000005  # v3: alles inline — keine Abhängigkeit von Note-Type-CSS mehr
MODEL_ID_CLOZE = 1733000006
MODEL_NAME_BASIC = "MC-Basic v3"
MODEL_NAME_CLOZE = "MC-Cloze v3"


# ── Fach-Farb-Palette (Spiegel von medizin.js:_subjectColors) ──
_SUBJECT_COLORS: dict[str, dict[str, str]] = {
    'Anatomie':           {'bg': '#1a1000', 'accent': '#fbbf24', 'border': '#b45309'},
    'Biochemie':          {'bg': '#0a1a0f', 'accent': '#4ade80', 'border': '#166534'},
    'Physiologie':        {'bg': '#0f172a', 'accent': '#60a5fa', 'border': '#1d4ed8'},
    'Pharmakologie':      {'bg': '#0d1a1a', 'accent': '#2dd4bf', 'border': '#0f766e'},
    'Pathologie':         {'bg': '#1a0a1a', 'accent': '#c084fc', 'border': '#7e22ce'},
    'Mikrobiologie':      {'bg': '#0f1f1f', 'accent': '#22d3ee', 'border': '#0e7490'},
    'Immunologie':        {'bg': '#1a0f00', 'accent': '#fdba74', 'border': '#ea580c'},
    'Virologie':          {'bg': '#0f1a1f', 'accent': '#06b6d4', 'border': '#0e7490'},
    'Humangenetik':       {'bg': '#130d1f', 'accent': '#d8b4fe', 'border': '#7c3aed'},
    'Innere Medizin':     {'bg': '#0f2027', 'accent': '#34d399', 'border': '#065f46'},
    'Kardiologie':        {'bg': '#1a1422', 'accent': '#f472b6', 'border': '#9d174d'},
    'Pulmonologie':       {'bg': '#07111f', 'accent': '#93c5fd', 'border': '#2563eb'},
    'Gastroenterologie':  {'bg': '#0d180a', 'accent': '#a3e635', 'border': '#4d7c0f'},
    'Nephrologie':        {'bg': '#061a18', 'accent': '#2dd4bf', 'border': '#0f766e'},
    'Endokrinologie':     {'bg': '#1a1500', 'accent': '#fde047', 'border': '#ca8a04'},
    'Hämatologie':        {'bg': '#1a0808', 'accent': '#fc8181', 'border': '#991b1b'},
    'Onkologie':          {'bg': '#160a0a', 'accent': '#fca5a5', 'border': '#dc2626'},
    'Rheumatologie':      {'bg': '#1a0d1a', 'accent': '#e879f9', 'border': '#a21caf'},
    'Infektiologie':      {'bg': '#0a1a0a', 'accent': '#6ee7b7', 'border': '#065f46'},
    'Neurologie':         {'bg': '#1e1b4b', 'accent': '#818cf8', 'border': '#4338ca'},
    'Chirurgie':          {'bg': '#1c1209', 'accent': '#f59e0b', 'border': '#92400e'},
    'Unfallchirurgie':    {'bg': '#1a1005', 'accent': '#fb923c', 'border': '#9a3412'},
    'Neurochirurgie':     {'bg': '#1a1035', 'accent': '#a78bfa', 'border': '#5b21b6'},
    'Orthopädie':         {'bg': '#111827', 'accent': '#94a3b8', 'border': '#475569'},
    'Urologie':           {'bg': '#141009', 'accent': '#fcd34d', 'border': '#b45309'},
    'Dermatologie':       {'bg': '#1f0f0a', 'accent': '#fb923c', 'border': '#c2410c'},
    'Pädiatrie':          {'bg': '#0e1a10', 'accent': '#86efac', 'border': '#15803d'},
    'Gynäkologie':        {'bg': '#1f0f18', 'accent': '#f9a8d4', 'border': '#be185d'},
    'Psychiatrie':        {'bg': '#0d0f1e', 'accent': '#7dd3fc', 'border': '#0369a1'},
    'Ophthalmologie':     {'bg': '#091528', 'accent': '#38bdf8', 'border': '#0284c7'},
    'HNO':                {'bg': '#0e1c1c', 'accent': '#5eead4', 'border': '#0d9488'},
    'Radiologie':         {'bg': '#0a0f1a', 'accent': '#a0aec0', 'border': '#4a5568'},
    'Notfallmedizin':     {'bg': '#1f0909', 'accent': '#f87171', 'border': '#b91c1c'},
    'Intensivmedizin':    {'bg': '#1f0808', 'accent': '#ff6b6b', 'border': '#dc2626'},
    'Anästhesie':         {'bg': '#0a1520', 'accent': '#67e8f9', 'border': '#0891b2'},
    'Allgemeinmedizin':   {'bg': '#0d1a12', 'accent': '#4ade80', 'border': '#16a34a'},
    'Rechtsmedizin':      {'bg': '#0f0f0f', 'accent': '#9ca3af', 'border': '#374151'},
    'Klinische Chemie':   {'bg': '#0f1a10', 'accent': '#86efac', 'border': '#166534'},
    'default':            {'bg': '#0f1629', 'accent': '#a78bfa', 'border': '#6d28d9'},
}


def _palette(subject: str) -> dict[str, str]:
    return _SUBJECT_COLORS.get(subject) or _SUBJECT_COLORS['default']


# ── Note-Type CSS ──
# Anki wickelt jede Karte in <div class="card">. Body-Hintergrund kommt aus
# .card. Mockup-Look 1:1 nachgebaut, Per-Subject-Farben kommen via inline
# CSS-Custom-Property `--accent` / `--bg` / `--border` aus dem Template.
_CARD_CSS = r"""
/* Minimal-CSS — alles Wesentliche steckt jetzt inline in den Templates,
   damit Anki das Design nicht ignorieren kann. Hier nur:
   - Card-Body-Reset (Anki's Default-Hintergrund/Farbe override)
   - Cloze-Highlight (Anki injiziert <span class="cloze">…</span> dynamisch) */
.card {
  background: #060910;
  color: #e2e8f0;
  padding: 18px 10px;
  text-align: left;
  font-size: 14px;
  line-height: 1.55;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
.card.nightMode, .card.night_mode { background: #060910; color: #e2e8f0; }
.cloze { color: #ef4444 !important; font-weight: 800; }
.cloze-inactive { color: #a78bfa; }

/* Image Occlusion: Boxen über dem Bild — Pos. inline, Look hier */
.mc-occ-wrap { position: relative; display: inline-block; max-width: 100%; }
.mc-occ-wrap > img { display: block; width: 100%; height: auto; max-height: 460px; object-fit: contain; }
.mc-occ-box {
  position: absolute;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-weight: 800; font-size: 12px;
  text-align: center; padding: 2px 4px;
  text-shadow: 0 1px 2px rgba(0,0,0,.7);
  border-radius: 4px; box-sizing: border-box;
}
""".strip()


# ── Templates: ALLES inline, keine Abhängigkeit von Note-Type-CSS ──
# Hex+Alpha-Tints werden via Mustache-Konkatenation gebaut: {{SubjectAccent}}33 → #f472b633.
# CSS-Klassen werden NUR für Anki-interne Hooks genutzt (.cloze).

_FONT = (
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;"
    "text-align:left"
)

_OUTER = (
    "max-width:660px;margin:0 auto 14px;border-radius:14px;overflow:hidden;"
    "border:1px solid #1f2937;background:#070a13;position:relative;" + _FONT
)
_ACCENT_BAR = (
    "position:absolute;left:0;top:0;bottom:0;width:4px;"
    "background:{{SubjectAccent}};z-index:2"
)
_HEADER = (
    "padding:10px 18px 9px 26px;display:flex;justify-content:space-between;"
    "align-items:center;border-bottom:1px solid {{SubjectAccent}}33;"
    "background:linear-gradient(90deg,{{SubjectBg}},{{SubjectAccent}}33);position:relative"
)
_SUBJECT = (
    "font-size:11px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;"
    "color:{{SubjectAccent}}"
)
_FRONT = (
    "padding:18px 20px 16px 26px;background:{{SubjectBg}};"
    "border-bottom:1px solid {{SubjectAccent}}33"
)
_BACK = "padding:18px 20px 18px 26px;background:#070a13"
_LABEL_FRAGE = (
    "font-size:10px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;"
    "margin-bottom:12px;color:{{SubjectAccent}};display:flex;align-items:center;gap:8px"
)
_LABEL_ANTWORT = (
    "font-size:10px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;"
    "margin-bottom:12px;color:#64748b;display:flex;align-items:center;gap:8px"
)
_BAR_FRAGE   = "display:inline-block;width:18px;height:2px;background:{{SubjectAccent}};border-radius:1px"
_BAR_ANTWORT = "display:inline-block;width:18px;height:2px;background:#475569;border-radius:1px"
_QUESTION = "color:#f8fafc;font-weight:600;font-size:17px;line-height:1.5"
_ANSWER   = "color:#cbd5e1;font-size:14px;line-height:1.7;margin-bottom:14px"

_IMG_WRAP = (
    "margin:10px 0 14px;border-radius:9px;overflow:hidden;"
    "border:1px solid {{SubjectAccent}}33;background:#0d1117;text-align:center"
)
_IMG = "display:block;width:100%;max-height:360px;object-fit:contain;margin:0 auto"

_FUNFACT_BOX = (
    "margin:12px 0;padding:11px 14px;background:#422006;"
    "border:1px solid #f59e0b55;border-left:4px solid #f59e0b;border-radius:0 9px 9px 0"
)
_FUNFACT_LABEL = (
    "font-size:10px;font-weight:800;letter-spacing:.1em;color:#fbbf24;"
    "margin-bottom:5px;text-transform:uppercase"
)
_FUNFACT_TEXT  = "color:#fde68a;font-size:13px;line-height:1.65"

_MERKHILFE_BOX = (
    "margin:12px 0;padding:11px 14px;background:{{SubjectAccent}}14;"
    "border:1px solid {{SubjectAccent}}33;border-left:4px solid {{SubjectAccent}};"
    "border-radius:0 9px 9px 0"
)
_MERKHILFE_LABEL = (
    "font-size:10px;font-weight:800;letter-spacing:.1em;color:{{SubjectAccent}};"
    "margin-bottom:5px;text-transform:uppercase"
)
_MERKHILFE_TEXT  = "color:#e9e0fa;font-size:13px;line-height:1.65"

_SOURCE_FOOTER = (
    "margin-top:14px;padding-top:8px;border-top:1px solid #1e293b;"
    "font-size:11px;color:#64748b"
)

# Pre-built blocks (so f-string-of-templates ist kürzer)
_HEADER_BLOCK = (
    f'<div style="{_HEADER}">'
        f'<span style="{_SUBJECT}">{{{{Subject}}}}</span>'
        f'<span style="display:flex;align-items:center;gap:6px">{{{{BadgeHtml}}}}</span>'
    f'</div>'
)
_FRONT_BLOCK_BASIC = (
    f'<div style="{_FRONT}">'
        f'<div style="{_LABEL_FRAGE}"><span style="{_BAR_FRAGE}"></span>Frage</div>'
        f'<div style="{_QUESTION}">{{{{Front}}}}</div>'
    f'</div>'
)
_FRONT_BLOCK_CLOZE = (
    f'<div style="{_FRONT}">'
        f'<div style="{_LABEL_FRAGE}"><span style="{_BAR_FRAGE}"></span>Lueckentext</div>'
        f'<div style="{_QUESTION}">{{{{cloze:Text}}}}</div>'
    f'</div>'
)
_BACK_EXTRAS = (
    '{{#Image}}'
        f'<div style="{_IMG_WRAP}"><img src="{{{{Image}}}}" style="{_IMG}"></div>'
    '{{/Image}}'
    '{{#FunFact}}'
        f'<div style="{_FUNFACT_BOX}">'
            f'<div style="{_FUNFACT_LABEL}">\U0001F4A1 Fun Fact</div>'
            f'<div style="{_FUNFACT_TEXT}">{{{{FunFact}}}}</div>'
        f'</div>'
    '{{/FunFact}}'
    '{{#Merkhilfe}}'
        f'<div style="{_MERKHILFE_BOX}">'
            f'<div style="{_MERKHILFE_LABEL}">\U0001F9E0 Merkhilfe</div>'
            f'<div style="{_MERKHILFE_TEXT}">{{{{Merkhilfe}}}}</div>'
        f'</div>'
    '{{/Merkhilfe}}'
    '{{#Source}}'
        f'<div style="{_SOURCE_FOOTER}">{{{{Source}}}}</div>'
    '{{/Source}}'
)
_BACK_BLOCK_BASIC = (
    f'<div style="{_BACK}">'
        f'<div style="{_LABEL_ANTWORT}"><span style="{_BAR_ANTWORT}"></span>Antwort</div>'
        f'<div style="{_ANSWER}">{{{{Back}}}}</div>'
        f'{_BACK_EXTRAS}'
    f'</div>'
)
_BACK_BLOCK_CLOZE = (
    f'<div style="{_BACK}">'
        f'{_BACK_EXTRAS}'
    f'</div>'
)

_BASIC_QFMT = (
    f'<div style="{_OUTER}">'
        f'<div style="{_ACCENT_BAR}"></div>'
        f'{_HEADER_BLOCK}'
        f'{_FRONT_BLOCK_BASIC}'
    f'</div>'
)
_BASIC_AFMT = (
    f'<div style="{_OUTER}">'
        f'<div style="{_ACCENT_BAR}"></div>'
        f'{_HEADER_BLOCK}'
        f'{_FRONT_BLOCK_BASIC}'
        f'{_BACK_BLOCK_BASIC}'
    f'</div>'
)
_CLOZE_QFMT = (
    f'<div style="{_OUTER}">'
        f'<div style="{_ACCENT_BAR}"></div>'
        f'{_HEADER_BLOCK}'
        f'{_FRONT_BLOCK_CLOZE}'
    f'</div>'
)
_CLOZE_AFMT = (
    f'<div style="{_OUTER}">'
        f'<div style="{_ACCENT_BAR}"></div>'
        f'{_HEADER_BLOCK}'
        f'{_FRONT_BLOCK_CLOZE}'
        f'{_BACK_BLOCK_CLOZE}'
    f'</div>'
)


def _build_models() -> tuple[genanki.Model, genanki.Model]:
    basic = genanki.Model(
        model_id=MODEL_ID_BASIC,
        name=MODEL_NAME_BASIC,
        fields=[
            {'name': 'Front'},
            {'name': 'Back'},
            {'name': 'Image'},
            {'name': 'FunFact'},
            {'name': 'Merkhilfe'},
            {'name': 'Source'},
            {'name': 'ExternalSource'},
            {'name': 'ExternalSourceSlug'},
            {'name': 'BadgeHtml'},
            {'name': 'Subject'},
            {'name': 'SubjectAccent'},
            {'name': 'SubjectBg'},
            {'name': 'SubjectBorder'},
        ],
        templates=[{'name': 'MC-Basic Card', 'qfmt': _BASIC_QFMT, 'afmt': _BASIC_AFMT}],
        css=_CARD_CSS,
    )
    cloze = genanki.Model(
        model_id=MODEL_ID_CLOZE,
        name=MODEL_NAME_CLOZE,
        model_type=genanki.Model.CLOZE,
        fields=[
            {'name': 'Text'},
            {'name': 'Image'},
            {'name': 'FunFact'},
            {'name': 'Merkhilfe'},
            {'name': 'Source'},
            {'name': 'ExternalSource'},
            {'name': 'ExternalSourceSlug'},
            {'name': 'BadgeHtml'},
            {'name': 'Subject'},
            {'name': 'SubjectAccent'},
            {'name': 'SubjectBg'},
            {'name': 'SubjectBorder'},
        ],
        templates=[{'name': 'MC-Cloze Card', 'qfmt': _CLOZE_QFMT, 'afmt': _CLOZE_AFMT}],
        css=_CARD_CSS,
    )
    return basic, cloze


# ── Helfer ──
_CLOZE_RE = re.compile(r"\{\{c\d+::", re.IGNORECASE)
_IMG_SRC_RE = re.compile(r'<img\s+([^>]*?)src="([^"]+)"', re.IGNORECASE)


def _strip_uploads_prefix(p: str) -> str:
    p = (p or "").strip()
    if p.startswith("/api/uploads/"):
        return p[len("/api/uploads/"):]
    return p


def _ext_src_slug(ext: str | None) -> str:
    if not ext:
        return ""
    e = ext.lower()
    if "amboss" in e: return "amboss"
    if "thieme" in e or "viamedici" in e: return "thieme"
    return "folien"


def _build_image_overlay(image_basename: str, occlusions: list[dict]) -> str:
    """Image-Occlusion-Block: Bild + absolut positionierte Cloze-Boxen.
    Front (Cloze hidden): Boxen sichtbar+leer. Back (Cloze shown): Labels in Boxen.
    Alle Styles inline — keine .mc-occ-*-Klassen mehr nötig."""
    boxes = []
    for i, o in enumerate(occlusions, start=1):
        label = (o.get("label") or "").strip()
        if not label:
            continue
        x = float(o.get("x", 0)); y = float(o.get("y", 0))
        w = float(o.get("w", 10)); h = float(o.get("h", 10))
        boxes.append(
            f'<div style="position:absolute;left:{x:.2f}%;top:{y:.2f}%;'
            f'width:{w:.2f}%;height:{h:.2f}%;background:rgba(167,139,250,.55);'
            f'border:2px solid #a78bfa;border-radius:4px;display:flex;'
            f'align-items:center;justify-content:center;color:#fff;font-weight:800;'
            f'font-size:12px;text-align:center;padding:2px 4px;'
            f'text-shadow:0 1px 2px rgba(0,0,0,.7);box-sizing:border-box">'
            f'{{{{c{i}::{label}}}}}</div>'
        )
    if not boxes:
        return ""
    return (
        f'<div style="position:relative;display:inline-block;max-width:100%">'
        f'<img src="{image_basename}" style="display:block;width:100%;height:auto;max-height:460px;object-fit:contain">'
        + "".join(boxes) +
        '</div>'
    )


def _collect_and_rewrite_imgs(html: str, uploads_dir: Path,
                               img_paths: dict[str, Path]) -> str:
    """Findet alle <img src="..."> und ersetzt durch basename. Sammelt absolute
    Pfade in img_paths {basename: abs_path} für genanki.Package(media_files)."""
    def _replace(m):
        attrs_before = m.group(1)
        src = m.group(2)
        if src.startswith(("http://", "https://", "data:")):
            return m.group(0)
        rel = _strip_uploads_prefix(src)
        if not rel:
            return m.group(0)
        abs_path = uploads_dir / rel
        if abs_path.exists():
            base = abs_path.name
            img_paths[base] = abs_path
            return f'<img {attrs_before}src="{base}"'
        return m.group(0)
    return _IMG_SRC_RE.sub(_replace, html or "")


def _is_cloze(text: str) -> bool:
    return bool(text and _CLOZE_RE.search(text))


def build_apkg(cards: list[dict], subject: str, uploads_dir: Path) -> tuple[bytes, dict]:
    """Erzeugt eine .apkg-Datei aus den generierten Karten.

    Returns: (apkg_bytes, stats_dict)
    stats_dict: {basic, cloze, occlusion, images, total}
    """
    if not cards:
        raise ValueError("Keine Karten übergeben")

    basic_model, cloze_model = _build_models()
    deck_name = subject.strip() or "MC-Karten"
    deck_id = (uuid.uuid5(uuid.NAMESPACE_DNS, f"mc-deck::{deck_name.lower()}").int >> 64) & 0x7FFFFFFFFFFFFFFF
    deck = genanki.Deck(deck_id=deck_id, name=f"Medizin::{deck_name}")

    pal = _palette(subject)
    img_paths: dict[str, Path] = {}

    stats = {"basic": 0, "cloze": 0, "occlusion": 0, "images": 0, "total": 0}

    for c in cards:
        front = c.get("front") or ""
        back = c.get("back") or ""
        img_rel = _strip_uploads_prefix((c.get("image") or "").strip())
        img_basename = ""
        if img_rel:
            abs_img = uploads_dir / img_rel
            if abs_img.exists():
                img_basename = abs_img.name
                img_paths[img_basename] = abs_img
        front = _collect_and_rewrite_imgs(front, uploads_dir, img_paths)
        back = _collect_and_rewrite_imgs(back, uploads_dir, img_paths)

        tags_str = (c.get("tags") or "").replace("\t", " ").replace(",", " ")
        tags = [t for t in tags_str.split() if t]

        ext_src = (c.get("external_source") or "").strip()
        ext_slug = _ext_src_slug(ext_src) if ext_src else (
            "amboss" if "amboss" in img_rel.lower() else
            "thieme" if ("thieme" in img_rel.lower() or "viamedici" in img_rel.lower()) else
            ("folien" if img_basename else "")
        )

        # Source-Badge inline pre-rendert: keine CSS-Klasse für Färbung nötig.
        _badge_styles = {
            "amboss": "background:#14532d;color:#86efac;border:1px solid #16a34a",
            "thieme": "background:#0c4a6e;color:#7dd3fc;border:1px solid #0ea5e9",
            "folien": "background:#1e3a8a;color:#93c5fd;border:1px solid #2563eb",
        }
        if ext_slug and ext_slug in _badge_styles:
            badge_label = ext_src or ext_slug.capitalize()
            badge_html = (
                f'<span style="border-radius:20px;padding:3px 10px;font-size:9px;'
                f'font-weight:800;letter-spacing:.06em;text-transform:uppercase;'
                f'{_badge_styles[ext_slug]}">{badge_label}</span>'
            )
        else:
            badge_html = ""

        common_fields = {
            "Image": img_basename,
            "FunFact": c.get("funfact") or "",
            "Merkhilfe": c.get("merkhilfe") or "",
            "Source": c.get("source") or "",
            "ExternalSource": ext_src,
            "ExternalSourceSlug": ext_slug,
            "BadgeHtml": badge_html,
            "Subject": deck_name,
            "SubjectAccent": pal["accent"],
            "SubjectBg": pal["bg"],
            "SubjectBorder": pal["border"],
        }

        occs = c.get("occlusions") or []
        has_cloze = _is_cloze(front) or _is_cloze(back)

        if occs and img_basename:
            overlay = _build_image_overlay(img_basename, occs)
            text = overlay
            if front:
                text = f'<div style="margin-bottom:10px">{front}</div>' + overlay
            note = genanki.Note(
                model=cloze_model,
                fields=[
                    text,
                    common_fields["Image"],
                    common_fields["FunFact"],
                    common_fields["Merkhilfe"],
                    common_fields["Source"],
                    common_fields["ExternalSource"],
                    common_fields["ExternalSourceSlug"],
                    common_fields["BadgeHtml"],
                    common_fields["Subject"],
                    common_fields["SubjectAccent"],
                    common_fields["SubjectBg"],
                    common_fields["SubjectBorder"],
                ],
                tags=tags,
            )
            deck.add_note(note)
            stats["occlusion"] += 1
            stats["cloze"] += 1
        elif has_cloze:
            # Cloze-Text-Building: Karte ist KEINE Frage+Antwort-Doppelung mehr.
            # - Hat Back die Cloze-Marker -> Back ist der Lueckentext, Front (falls
            #   vorhanden) wird als kleinerer Kontext-Header oben eingeklemmt.
            # - Hat nur Front Cloze -> Front ist der Lueckentext, Back als Erklaerung
            #   darunter (ohne Cloze-Marker).
            # - Beide Cloze -> einfach untereinander.
            front_has_cloze = _is_cloze(front)
            back_has_cloze = _is_cloze(back)
            if back_has_cloze and front and not front_has_cloze:
                # Front = kontext-Header, Back = der Cloze-Body
                text = (
                    f'<div style="opacity:.65;font-size:.85em;margin-bottom:10px">{front}</div>'
                    f'{back}'
                )
            elif front_has_cloze and back and not back_has_cloze:
                # Front = Cloze, Back = Kontext-Erklaerung darunter
                text = f'{front}<div style="margin-top:10px;opacity:.85">{back}</div>'
            elif front and back:
                text = f"{front}<br><br>{back}"
            else:
                text = front or back
            note = genanki.Note(
                model=cloze_model,
                fields=[
                    text,
                    common_fields["Image"],
                    common_fields["FunFact"],
                    common_fields["Merkhilfe"],
                    common_fields["Source"],
                    common_fields["ExternalSource"],
                    common_fields["ExternalSourceSlug"],
                    common_fields["BadgeHtml"],
                    common_fields["Subject"],
                    common_fields["SubjectAccent"],
                    common_fields["SubjectBg"],
                    common_fields["SubjectBorder"],
                ],
                tags=tags,
            )
            deck.add_note(note)
            stats["cloze"] += 1
        else:
            note = genanki.Note(
                model=basic_model,
                fields=[
                    front,
                    back,
                    common_fields["Image"],
                    common_fields["FunFact"],
                    common_fields["Merkhilfe"],
                    common_fields["Source"],
                    common_fields["ExternalSource"],
                    common_fields["ExternalSourceSlug"],
                    common_fields["BadgeHtml"],
                    common_fields["Subject"],
                    common_fields["SubjectAccent"],
                    common_fields["SubjectBg"],
                    common_fields["SubjectBorder"],
                ],
                tags=tags,
            )
            deck.add_note(note)
            stats["basic"] += 1
        stats["total"] += 1

    pkg = genanki.Package(deck)
    pkg.media_files = [str(p) for p in img_paths.values()]
    stats["images"] = len(img_paths)

    buf = io.BytesIO()
    pkg.write_to_file(buf)
    return buf.getvalue(), stats


# ── Live-Preview (Browser) ──
def _render_card_inline(c: dict, subject: str, idx: int = 0) -> str:
    """Rendert eine Karte in inline-styled HTML — entspricht 1:1 dem, was die
    Anki-Templates rendern. Genutzt von beiden Preview-Endpoints."""
    pal = _palette(subject)
    accent = pal["accent"]; bg = pal["bg"]

    front = c.get("front") or ""
    back = c.get("back") or ""
    cloze_re = re.compile(r"\{\{c\d+::(.+?)(?:::.+?)?\}\}")
    front = cloze_re.sub(r'<span class="cloze">\1</span>', front)
    back = cloze_re.sub(r'<span class="cloze">\1</span>', back)

    img_url = ""
    img_rel = _strip_uploads_prefix((c.get("image") or "").strip())
    if img_rel:
        img_url = f"/api/uploads/{img_rel}"

    occs = c.get("occlusions") or []
    img_html = ""
    if img_url and occs:
        boxes = []
        for o in occs:
            lbl = (o.get("label") or "").strip()
            if not lbl: continue
            x = float(o.get("x", 0)); y = float(o.get("y", 0))
            w = float(o.get("w", 10)); h = float(o.get("h", 10))
            boxes.append(
                f'<div style="position:absolute;left:{x:.2f}%;top:{y:.2f}%;'
                f'width:{w:.2f}%;height:{h:.2f}%;background:{accent}cc;'
                f'border:2px solid {accent};border-radius:4px;display:flex;'
                f'align-items:center;justify-content:center;color:#fff;'
                f'font-weight:800;font-size:12px;text-align:center;'
                f'padding:2px 4px;text-shadow:0 1px 2px rgba(0,0,0,.7);'
                f'box-sizing:border-box">{lbl}</div>'
            )
        img_html = (
            f'<div style="margin:10px 0 14px;border-radius:9px;overflow:hidden;'
            f'border:1px solid {accent}33;background:#0d1117;text-align:center">'
            f'<div style="position:relative;display:inline-block;max-width:100%">'
            f'<img src="{img_url}" alt="" style="display:block;width:100%;height:auto;max-height:460px;object-fit:contain">'
            + "".join(boxes) +
            '</div></div>'
        )
    elif img_url:
        img_html = (
            f'<div style="margin:10px 0 14px;border-radius:9px;overflow:hidden;'
            f'border:1px solid {accent}33;background:#0d1117;text-align:center">'
            f'<img src="{img_url}" alt="" style="display:block;width:100%;max-height:360px;object-fit:contain;margin:0 auto">'
            f'</div>'
        )

    funfact = c.get("funfact") or ""
    merkhilfe = c.get("merkhilfe") or ""
    source = c.get("source") or ""

    ff_block = (
        f'<div style="margin:12px 0;padding:11px 14px;background:#422006;'
        f'border:1px solid #f59e0b55;border-left:4px solid #f59e0b;'
        f'border-radius:0 9px 9px 0">'
        f'<div style="font-size:10px;font-weight:800;letter-spacing:.1em;'
        f'color:#fbbf24;margin-bottom:5px;text-transform:uppercase">'
        f'\U0001F4A1 Fun Fact</div>'
        f'<div style="color:#fde68a;font-size:13px;line-height:1.65">{funfact}</div>'
        f'</div>'
    ) if funfact else ""
    mh_block = (
        f'<div style="margin:12px 0;padding:11px 14px;background:{accent}14;'
        f'border:1px solid {accent}33;border-left:4px solid {accent};'
        f'border-radius:0 9px 9px 0">'
        f'<div style="font-size:10px;font-weight:800;letter-spacing:.1em;'
        f'color:{accent};margin-bottom:5px;text-transform:uppercase">'
        f'\U0001F9E0 Merkhilfe</div>'
        f'<div style="color:#e9e0fa;font-size:13px;line-height:1.65">{merkhilfe}</div>'
        f'</div>'
    ) if merkhilfe else ""
    src_block = (
        f'<div style="margin-top:14px;padding-top:8px;border-top:1px solid #1e293b;'
        f'font-size:11px;color:#64748b">{source}</div>'
    ) if source else ""
    answer_html = (
        f'<div style="color:#cbd5e1;font-size:14px;line-height:1.7;margin-bottom:14px">{back}</div>'
    ) if back else ""

    ext = (c.get("external_source") or "").strip()
    ext_slug = _ext_src_slug(ext) if ext else (
        "amboss" if "amboss" in (c.get("image") or "").lower() else
        ("thieme" if any(s in (c.get("image") or "").lower() for s in ("thieme", "viamedici"))
         else ("folien" if c.get("image") else ""))
    )
    badge_styles = {
        "amboss": "background:#14532d;color:#86efac;border:1px solid #16a34a",
        "thieme": "background:#0c4a6e;color:#7dd3fc;border:1px solid #0ea5e9",
        "folien": "background:#1e3a8a;color:#93c5fd;border:1px solid #2563eb",
    }
    badge_html = (
        f'<span style="border-radius:20px;padding:3px 10px;font-size:9px;'
        f'font-weight:800;letter-spacing:.06em;text-transform:uppercase;'
        f'{badge_styles.get(ext_slug, badge_styles["folien"])}">'
        f'{ext or ext_slug.capitalize()}</span>'
    ) if ext_slug else ""

    return (
        f'<div style="max-width:660px;margin:0 auto 22px;border-radius:14px;'
        f'overflow:hidden;border:1px solid #1f2937;background:#070a13;'
        f'position:relative;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,system-ui,sans-serif;'
        f'text-align:left">'
        f'<div style="position:absolute;left:0;top:0;bottom:0;width:4px;background:{accent};z-index:2"></div>'
        f'<div style="padding:10px 18px 9px 26px;display:flex;justify-content:space-between;'
        f'align-items:center;border-bottom:1px solid {accent}33;'
        f'background:linear-gradient(90deg,{bg},{accent}33);position:relative">'
        f'<span style="font-size:11px;font-weight:800;letter-spacing:.15em;'
        f'text-transform:uppercase;color:{accent}">{subject}</span>'
        f'<span style="display:flex;align-items:center;gap:6px">{badge_html}</span>'
        f'</div>'
        f'<div style="padding:18px 20px 16px 26px;background:{bg};'
        f'border-bottom:1px solid {accent}33">'
        f'<div style="font-size:10px;font-weight:800;letter-spacing:.15em;'
        f'text-transform:uppercase;margin-bottom:12px;color:{accent};'
        f'display:flex;align-items:center;gap:8px">'
        f'<span style="display:inline-block;width:18px;height:2px;background:{accent};border-radius:1px"></span>'
        f'Frage</div>'
        f'<div style="color:#f8fafc;font-weight:600;font-size:17px;line-height:1.5">{front}</div>'
        f'</div>'
        f'<div style="padding:18px 20px 18px 26px;background:#070a13">'
        f'<div style="font-size:10px;font-weight:800;letter-spacing:.15em;'
        f'text-transform:uppercase;margin-bottom:12px;color:#64748b;'
        f'display:flex;align-items:center;gap:8px">'
        f'<span style="display:inline-block;width:18px;height:2px;background:#475569;border-radius:1px"></span>'
        f'Antwort</div>'
        f'{answer_html}{img_html}{ff_block}{mh_block}{src_block}'
        f'</div>'
        f'</div>'
    )


def render_preview_html() -> str:
    """Beispiel-Preview mit verschiedenen Karten-Varianten."""
    samples = [
        {"subject": "Kardiologie", "front": "Welche 4 Klassen Antiarrhythmika gibt es nach Vaughan-Williams?",
         "back": "<b>Klasse I</b>: Na-Kanalblocker (Ia/Ib/Ic) — verlängern/verkürzen ÄP<br>"
                 "<b>Klasse II</b>: Betablocker — reduzieren sympathischen Drive am SA-Knoten<br>"
                 "<b>Klasse III</b>: K-Kanalblocker (z.B. <i>Amiodaron</i>) — verlängern Repolarisation<br>"
                 "<b>Klasse IV</b>: Ca-Kanalblocker — Verapamil, Diltiazem",
         "funfact": "Amiodaron enthält <b>37% Jod</b> nach Gewicht — TFT-Kontrollen alle 6 Monate Pflicht!",
         "merkhilfe": "<b>SINKEN</b>: Sinus, Na, K, Ca — die 4 Angriffspunkte",
         "source": "Kardio VL5 · Antiarrhythmika", "external_source": "Amboss",
         "image": "", "occlusions": []},
        {"subject": "Neurologie", "front": "Hirnnerven mit präganglionären parasympathischen Fasern: {{c1::III}}, {{c2::VII}}, {{c3::IX}}, {{c4::X}}.",
         "back": "", "funfact": "",
         "merkhilfe": '"3 — 7 — 9 — 10": die einzigen Hirnnerven mit Parasympathikus.',
         "source": "Hirnnerven-Übersicht", "external_source": "Amboss",
         "image": "", "occlusions": []},
        {"subject": "Pharmakologie",
         "front": "Unterschied kompetitive vs. nicht-kompetitive Hemmung — Wirkung auf Vmax und Km?",
         "back": '<b>Kompetitiv</b>: Inhibitor bindet aktives Zentrum reversibel<br>→ <span style="color:#fde047">Km ↑</span>, Vmax unverändert<br><br>'
                 '<b>Nicht-kompetitiv</b>: Inhibitor bindet allosterisch<br>→ Km unverändert, <span style="color:#fde047">Vmax ↓</span>',
         "funfact": "<i>Methotrexat</i> ist ein klassischer kompetitiver DHFR-Hemmer.",
         "merkhilfe": "", "source": "Biochemie Enzymkinetik", "external_source": None,
         "image": "", "occlusions": []},
    ]
    cards_html = "\n".join(
        f'<div style="margin-bottom:24px"><div style="font-size:11px;color:#475569;'
        f'margin-bottom:6px;letter-spacing:.05em;text-transform:uppercase">'
        f'{i+1}. {s["subject"]}</div>{_render_card_inline(s, s["subject"], i)}</div>'
        for i, s in enumerate(samples)
    )

    return (
        '<!DOCTYPE html>\n<html><head><meta charset="utf-8">'
        '<title>MC Anki Card Preview</title>'
        f'<style>{_CARD_CSS}\n'
        'body { background:#060910; padding:24px 12px; max-width:760px; margin:0 auto; }\n'
        'h1 { color:#e2e8f0; font-family:-apple-system,Segoe UI,sans-serif; font-size:20px; margin:0 0 8px; }\n'
        '.note { color:#94a3b8; font-size:13px; font-family:-apple-system,Segoe UI,sans-serif; margin-bottom:24px; line-height:1.6; }\n'
        '.note code { background:#1e293b; padding:1px 6px; border-radius:3px; color:#fbbf24; }\n'
        '</style></head><body>'
        '<h1>MC Anki — Render-Preview</h1>'
        '<div class="note">So sehen die Karten in Anki aus — alle Styles sind inline, kein Note-Type-CSS-Fallout möglich. '
        'Die neuen Note-Types heissen <b>MC-Basic v3</b> / <b>MC-Cloze v3</b>.</div>'
        f'{cards_html}'
        '</body></html>'
    )


def render_deck_preview_html(cards: list, subject: str, topics: list, ts: str) -> str:
    """Browser-Vollvorschau eines gespeicherten Decks. Zeigt alle Karten,
    nutzt das gleiche inline-Styling wie der Anki-Export."""
    if not cards:
        cards_html = '<div style="color:#94a3b8;font-family:-apple-system,Segoe UI,sans-serif;padding:24px;text-align:center">Keine Karten in diesem Deck.</div>'
    else:
        cards_html = "\n".join(
            f'<div style="margin-bottom:22px"><div style="font-size:11px;color:#475569;'
            f'margin-bottom:6px;letter-spacing:.05em;text-transform:uppercase">'
            f'#{i+1} · {subject}</div>{_render_card_inline(c, subject, i)}</div>'
            for i, c in enumerate(cards)
        )

    topics_str = ", ".join(topics) if topics else "—"
    header = (
        f'<div style="margin-bottom:24px;padding:14px 16px;background:#0d1117;'
        f'border:1px solid #1e293b;border-radius:9px">'
        f'<div style="font-size:18px;font-weight:700;color:#e2e8f0;margin-bottom:4px">'
        f'{subject} <span style="color:#64748b;font-weight:400;font-size:13px">— {len(cards)} Karten</span></div>'
        f'<div style="font-size:12px;color:#94a3b8">Themen: {topics_str}</div>'
        f'<div style="font-size:11px;color:#475569;margin-top:2px">Erstellt: {ts}</div>'
        f'</div>'
    )

    return (
        '<!DOCTYPE html>\n<html><head><meta charset="utf-8">'
        f'<title>{subject} — Anki-Karten Preview</title>'
        f'<style>{_CARD_CSS}\n'
        'body { background:#060910; padding:24px 12px; max-width:760px; margin:0 auto; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; }\n'
        '</style></head><body>'
        f'{header}{cards_html}'
        '</body></html>'
    )
