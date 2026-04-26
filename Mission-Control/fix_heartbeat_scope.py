import sys

path = r'C:\Users\Robin\Jarvis\Mission-Control\server.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Korrektur von nonlocal zu global
content = content.replace('nonlocal _heartbeat_task', 'global _heartbeat_task')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Global scoping fixed")
