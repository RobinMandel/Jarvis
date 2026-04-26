import sys
import re

path = r'C:\Users\Robin\Jarvis\Mission-Control\jarvis_mcp.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

new_function = r'''
def _tool_skill_activate(slug: str, scope: str = "claude-cli") -> dict:
    """Aktiviert einen MC-Skill fuer claude-cli oder gemini-cli."""
    if not slug or "/" in slug or "\\" in slug or ".." in slug:
        return {"ok": False, "error": f"Ungueltiger slug {slug!r}"}

    src_dir = _MC_SKILLS_DIR / slug
    if not src_dir.is_dir():
        return {"ok": False, "error": f"Skill {slug!r} nicht gefunden"}
    
    src_file = src_dir / "SKILL.md"
    if not src_file.exists():
        src_file = src_dir / "README.md"
        if not src_file.exists():
            return {"ok": False, "error": "Keine SKILL.md/README.md gefunden"}

    _CC_SKILLS_DIR = Path.home() / ".claude" / "skills"
    _GEMINI_SKILLS_DIR = Path.home() / ".agents" / "skills"

    if scope == "claude-cli":
        dest_dir = _CC_SKILLS_DIR
        dest_path = dest_dir / f"{slug}.md"
    elif scope == "gemini-cli":
        dest_dir = _GEMINI_SKILLS_DIR / slug
        dest_path = dest_dir / "SKILL.md"
    else:
        return {"ok": False, "error": f"Scope {scope!r} nicht unterstuetzt"}

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        content = src_file.read_text(encoding="utf-8", errors="replace")
        dest_path.write_text(content, encoding="utf-8")
        return {
            "ok": True,
            "slug": slug,
            "scope": scope,
            "path": str(dest_path),
            "note": "Skill erfolgreich aktiviert."
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}
'''

# Ersetze die alte Funktion (sehr vorsichtiger Regex-Match)
content = re.sub(r'def _tool_skill_activate.*?return {"ok": False, "error": str\(e\)}', new_function, content, flags=re.DOTALL)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Function _tool_skill_activate rewritten successfully")
