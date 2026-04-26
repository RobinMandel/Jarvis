import sys

path = r'C:\Users\Robin\Jarvis\Mission-Control\llm_client.py'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    if 'if name == \"openclaw\":' in line:
        new_lines.append('        if name == \"openclaw\":\n')
    elif '_PROVIDERS[name] = OpenClawProvider()' in line:
        new_lines.append('            _PROVIDERS[name] = OpenClawProvider()\n')
    else:
        new_lines.append(line)

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("Indentation fixed")
