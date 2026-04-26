
import asyncio
import aiohttp
import json

async def test_med_agent():
    url = "http://localhost:8090/api/medical/reason"
    payload = {
        "query": "Was sind die klinischen Zeichen einer Aortenstenose?",
        "provider": "claude-cli",
        "model": "",
        "include_sources": ["rag"]  # Nur RAG testen, da Amboss/Thieme Cookies brauchen könnten
    }
    
    print(f"Testing {url} with query: {payload['query']}")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=30) as resp:
                print(f"Status: {resp.status}")
                data = await resp.json()
                if data.get("ok"):
                    print("SUCCESS!")
                    print(f"Answer snippet: {data.get('answer')[:100]}...")
                else:
                    print(f"FAILED: {data.get('error')}")
    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == "__main__":
    asyncio.run(test_med_agent())
