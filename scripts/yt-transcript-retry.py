"""
Retries YouTube transcript extraction when IP block has lifted.
Saves to memory/ and updates Obsidian note.
"""
import urllib.request, json, re, html as htmllib, sys, os
from pathlib import Path

VIDEOS = [
    ('1PXFAFMgdns', 'The 7 Levels of Building ELITE Websites with Claude Code'),
    ('uqpXAfNEY4g', 'I Vibe Coded a $50K Website in One Weekend Using AI'),
]
OUT_DIR = Path('C:/Users/Robin/Jarvis/data')
OBSIDIAN_NOTE = Path('E:/OneDrive/Obsidian/Jarvis-Brain/Jarvis-Knowledge/Technik/Webdesign-AI-Workflow.md')

def get_transcript(vid):
    req = urllib.request.Request(
        f'https://www.youtube.com/watch?v={vid}&hl=en',
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'identity',
        }
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        page = r.read().decode('utf-8')

    if 'captionTracks' not in page:
        raise Exception('No captionTracks in page (blocked?)')

    idx = page.find('"captionTracks"')
    snippet = page[idx:idx+800]
    m = re.search(r'"baseUrl":"(https://www\.youtube\.com/api/timedtext[^"]+)"', snippet)
    if not m:
        raise Exception(f'No baseUrl found. Snippet: {snippet[:200]}')

    raw_url = m.group(1)
    track_url = raw_url.encode('utf-8').decode('unicode_escape')

    req2 = urllib.request.Request(track_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req2, timeout=20) as r2:
        xml = r2.read().decode('utf-8')

    texts = re.findall(r'<text[^>]*>(.*?)</text>', xml, re.DOTALL)
    cleaned = ' '.join([htmllib.unescape(re.sub('<[^>]+>', '', t)).strip() for t in texts])
    return cleaned


results = {}
for vid, title in VIDEOS:
    print(f'Fetching: {title}')
    try:
        transcript = get_transcript(vid)
        if len(transcript) < 100:
            print(f'  Too short ({len(transcript)} chars) - skipping')
            continue
        results[vid] = (title, transcript)
        out_path = OUT_DIR / f'yt-transcript-{vid}.txt'
        out_path.write_text(f'# {title}\nhttps://www.youtube.com/watch?v={vid}\n\n{transcript}', encoding='utf-8')
        print(f'  Saved {len(transcript)} chars -> {out_path}')
    except Exception as e:
        print(f'  FAILED: {e}')
        sys.exit(1)

if len(results) == 2:
    print('\nBoth transcripts retrieved! You can now run the analysis step.')
else:
    print(f'\nOnly {len(results)}/2 transcripts retrieved.')
    sys.exit(1)
