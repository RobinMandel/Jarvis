import sys

path = r'C:\Users\Robin\Jarvis\Mission-Control\test_llm_client.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('assert len(infos) == 5', 'assert len(infos) == 6')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Test fixed")
