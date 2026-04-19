"""Test: Claude with full bridge prompt from background process"""
import subprocess, os, time, sys
from pathlib import Path

CLAUDE_CLI = r"C:\Users\Robin\.local\bin\claude.exe"
VAULT_DIR = Path("E:/OneDrive/AI/Obsidian-Vault/Jarvis-Brain/Jarvis-Memory")
MEMORY_FILES = ["robin.md", "identity.md", "projects.md", "todos.md", "decisions.md"]

# Build vault context like bridge does
parts = []
for name in MEMORY_FILES:
    p = VAULT_DIR / name
    if p.exists():
        content = p.read_text(encoding="utf-8").strip()
        if content:
            parts.append(content)
vault = "\n\n---\n\n".join(parts)
prompt = f"=== DEIN GEDAECHTNIS ===\n{vault}\n=== ENDE GEDAECHTNIS ===\n\nRobin: ????\n\nAntworte als Jarvis auf Robins letzte Nachricht."

system_prompt = (
    "Du bist Jarvis, Robins persoenlicher AI-Assistent. "
    "Robin schreibt dir ueber Telegram. "
    "Du hast vollen Zugriff auf alle Tools: Dateien lesen/schreiben/editieren, "
    "Bash-Befehle ausfuehren, Dateien suchen, grep, Agents spawnen — nutze sie aktiv! "
    "Arbeitsverzeichnis: C:/Users/Robin/Jarvis. "
    "Antworte kurz und praegnant, Telegram-Format. "
    "Deutsch by default. Sei direkt, hilfreich, mit Persoenlichkeit. "
    "Keine Fuellwoerter. Du bekommst den Gespraechsverlauf mitgeliefert."
)

cmd = [
    CLAUDE_CLI,
    "-p", prompt,
    "--output-format", "text",
    "--max-turns", "0",
    "--dangerously-skip-permissions",
    "--system-prompt", system_prompt,
    "--no-session-persistence",
]

print(f"PID: {os.getpid()}")
print(f"Prompt: {len(prompt)} chars, system: {len(system_prompt)} chars")
print(f"Cmd args: {len(cmd)} items")

start = time.time()
proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    stdin=subprocess.PIPE,
    encoding="utf-8",
    errors="replace",
    env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    cwd="C:/Users/Robin/Jarvis",
    creationflags=subprocess.CREATE_NO_WINDOW,
)

print(f"Claude started as PID {proc.pid}")
try:
    stdout, stderr = proc.communicate(timeout=120)
    elapsed = time.time() - start
    print(f"RC={proc.returncode} in {elapsed:.1f}s")
    print(f"stdout ({len(stdout)} chars): {stdout[:300]}")
    if stderr:
        print(f"stderr ({len(stderr)} chars): {stderr[:300]}")
except subprocess.TimeoutExpired:
    proc.kill()
    elapsed = time.time() - start
    print(f"TIMEOUT after {elapsed:.1f}s!")
except Exception as e:
    print(f"ERROR: {e}")

print("DONE")
