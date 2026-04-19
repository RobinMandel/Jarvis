import urllib.request, json, re, html as htmllib, sys

def get_transcript(video_id):
    req = urllib.request.Request(
        f'https://www.youtube.com/watch?v={video_id}',
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml'
        }
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        page = r.read().decode('utf-8')

    # Extract the raw captionTracks JSON string (unicode-escaped)
    idx = page.find('"captionTracks"')
    if idx == -1:
        return None, 'no captionTracks in page'

    # Find the baseUrl which contains \u0026 encoded params
    snippet = page[idx:idx+3000]
    
    # The URL is encoded with \u0026 for & signs
    url_re = re.search(r'"baseUrl":"(https://www\\.youtube\\.com/api/timedtext[^"]+)"', snippet)
    if not url_re:
        return None, 'no baseUrl matched, snippet: ' + repr(snippet[:400])
    
    raw_url = url_re.group(1)
    # Decode \u0026 -> &
    track_url = raw_url.replace('\\u0026', '&').replace('\\/', '/')
    
    # Fetch transcript XML
    req2 = urllib.request.Request(track_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req2, timeout=20) as r:
        xml = r.read().decode('utf-8')

    texts = re.findall(r'<text[^>]*>(.*?)</text>', xml, re.DOTALL)
    cleaned = [htmllib.unescape(re.sub('<[^>]+>', '', t)).strip() for t in texts]
    full = ' '.join(cleaned)
    return track_url[:80], full


titles = {
    '1PXFAFMgdns': 'The 7 Levels of Building ELITE Websites with Claude Code',
    'uqpXAfNEY4g': 'I Vibe Coded a $50K Website in One Weekend Using AI'
}

results = {}
for vid in ['1PXFAFMgdns', 'uqpXAfNEY4g']:
    print(f'=== {vid} | {titles[vid]} ===')
    try:
        url_short, transcript = get_transcript(vid)
        if url_short:
            print(f'URL prefix: {url_short}')
            print(f'Length: {len(transcript)} chars')
            print(transcript[:6000])
            results[vid] = transcript
        else:
            print(f'FAILED: {transcript}')
    except Exception as e:
        import traceback
        traceback.print_exc()
    print()

# Save full transcripts
import os
out_dir = r'C:\Users\Robin\Jarvis\data'
for vid, text in results.items():
    path = os.path.join(out_dir, f'yt-transcript-{vid}.txt')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f'Saved: {path}')
