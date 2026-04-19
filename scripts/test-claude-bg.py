"""Minimal test: can we call Claude from a background Python process?"""
import subprocess, os, time, sys

CLAUDE_CLI = r"C:\Users\Robin\.local\bin\claude.exe"

print(f"PID: {os.getpid()}")
print(f"Testing claude call...")

cmd = [
    CLAUDE_CLI,
    "-p", "Sag einfach OK",
    "--output-format", "text",
    "--max-turns", "0",
    "--dangerously-skip-permissions",
    "--system-prompt", "Antworte mit einem Wort.",
    "--no-session-persistence",
]

start = time.time()
proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    stdin=subprocess.DEVNULL,
    encoding="utf-8",
    errors="replace",
    creationflags=subprocess.CREATE_NO_WINDOW,
)

try:
    stdout, stderr = proc.communicate(timeout=60)
    elapsed = time.time() - start
    print(f"RC={proc.returncode} in {elapsed:.1f}s")
    print(f"stdout: {stdout[:200]}")
    if stderr:
        print(f"stderr: {stderr[:200]}")
except subprocess.TimeoutExpired:
    proc.kill()
    print(f"TIMEOUT after 60s!")
except Exception as e:
    print(f"ERROR: {e}")

print("DONE")
