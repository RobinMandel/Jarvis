import sys

path = r'C:\Users\Robin\Jarvis\Mission-Control\jarvis_mcp.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Erweitere _tool_skill_activate um gemini-cli Support
old_code = r'''    if scope != "claude-cli":
        return {"ok": False, "error": f"scope {scope!r} noch nicht unterstützt (nur claude-cli)"}

    _CC_SKILLS_DIR.mkdir(parents=True, exist_ok=True)'''

new_code = r'''    _GEMINI_SKILLS_DIR = Path.home() / ".agents" / "skills"

    if scope == "claude-cli":
        dest_dir = _CC_SKILLS_DIR
        dest_path = dest_dir / f"{slug}.md"
    elif scope == "gemini-cli":
        dest_dir = _GEMINI_SKILLS_DIR / slug
        dest_path = dest_dir / "SKILL.md"
    else:
        return {"ok": False, "error": f"scope {scope!r} nicht unterstützt"}

    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_path'''

content = content.replace(old_code, new_code)

# Erweitere Tool-Definition
content = content.replace('["claude-cli"]', '["claude-cli", "gemini-cli"]')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("MCP Server updated with gemini-cli scope support")
