import sys

path = r'C:\Users\Robin\Jarvis\Mission-Control\server.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('self.provider = \"claude-cli\"  # default', 'self.provider = \"openclaw\"  # default')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Default provider updated to openclaw")
