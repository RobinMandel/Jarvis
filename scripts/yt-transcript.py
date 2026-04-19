import urllib.request, json, re, sys, html as htmllib

def get_transcript(video_id):
    url = f'https://www.youtube.com/watch?v={video_id}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        html = r.read().decode('utf-8')

    # Extract full playerResponse JSON blob
    match = re.search(r'"captionTracks":(\[.*?\])', html)
    if not match:
        return None, 'No captionTracks found'

    raw = match.group(1)
    # captionTracks array may be truncated; find balanced bracket
    depth = 0
    end = 0
    for i, c in enumerate(raw):
        if c == '[': depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    tracks_str = raw[:end]

    try:
        tracks = json.loads(tracks_str)
    except Exception as e:
        return None, f'JSON parse error: {e} | raw: {tracks_str[:200]}'

    track_url = None
    chosen_lang = None
    for t in tracks:
        lang = t.get('languageCode', '')
        if lang.startswith('en'):
            track_url = t.get('baseUrl')
            chosen_lang = lang
            break
    if not track_url and tracks:
        track_url = tracks[0].get('baseUrl')
        chosen_lang = tracks[0].get('languageCode', '?')

    if not track_url:
        return None, 'No baseUrl in tracks'

    req2 = urllib.request.Request(track_url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })
    with urllib.request.urlopen(req2, timeout=20) as r:
        xml = r.read().decode('utf-8')

    texts = re.findall(r'<text[^>]*>(.*?)</text>', xml, re.DOTALL)
    cleaned = [htmllib.unescape(re.sub('<[^>]+>', '', t)).strip() for t in texts]
    return chosen_lang, ' '.join(cleaned)

titles = {
    '1PXFAFMgdns': 'The 7 Levels of Building ELITE Websites with Claude Code',
    'uqpXAfNEY4g': 'I Vibe Coded a $50K Website in One Weekend Using AI'
}

for vid in ['1PXFAFMgdns', 'uqpXAfNEY4g']:
    print(f'=== {vid} | {titles.get(vid)} ===')
    try:
        lang, result = get_transcript(vid)
        if lang:
            print(f'Language: {lang} | Length: {len(result)} chars')
            print(result[:8000])
        else:
            print(f'FAILED: {result}')
    except Exception as e:
        print(f'Exception: {e}')
    print()
