#!/usr/bin/env python3
import sys
print("Python working!", flush=True)

try:
    import requests
    print("Requests imported", flush=True)
except ImportError as e:
    print(f"ERROR: requests not found: {e}", flush=True)
    sys.exit(1)

try:
    response = requests.post('http://localhost:8765', json={'action': 'version', 'version': 6}, timeout=2)
    print(f"Anki response: {response.json()}", flush=True)
except Exception as e:
    print(f"Anki connection failed: {e}", flush=True)
    sys.exit(1)

print("All good!", flush=True)
