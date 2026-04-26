
import asyncio
import os
import sys
from pathlib import Path

# Add Mission-Control to path
sys.path.append(os.getcwd())

from server import _fetch_amboss_medical, _fetch_viamedici_medical, _build_rag_context

UPLOADS_DIR = Path("data/uploads")

async def test_all():
    query = "Herzinsuffizienz Therapie"
    print(f"Testing query: {query}")
    
    print("\n--- Testing RAG ---")
    try:
        t0 = asyncio.get_event_loop().time()
        rag_ctx, n = await asyncio.wait_for(_build_rag_context(query), timeout=120)
        t1 = asyncio.get_event_loop().time()
        print(f"RAG took {t1-t0:.2f}s, found {n} chunks")
    except Exception as e:
        print(f"RAG failed or timed out: {e}")

    print("\n--- Testing Amboss ---")
    try:
        t0 = asyncio.get_event_loop().time()
        amboss = await asyncio.wait_for(_fetch_amboss_medical(query, UPLOADS_DIR), timeout=30)
        t1 = asyncio.get_event_loop().time()
        print(f"Amboss took {t1-t0:.2f}s, found {len(amboss)} articles")
    except Exception as e:
        print(f"Amboss failed or timed out: {e}")

    print("\n--- Testing ViaMedici ---")
    try:
        t0 = asyncio.get_event_loop().time()
        vm = await asyncio.wait_for(_fetch_viamedici_medical(query, UPLOADS_DIR), timeout=30)
        t1 = asyncio.get_event_loop().time()
        print(f"ViaMedici took {t1-t0:.2f}s, found {len(vm)} modules")
    except Exception as e:
        print(f"ViaMedici failed or timed out: {e}")

if __name__ == "__main__":
    asyncio.run(test_all())
