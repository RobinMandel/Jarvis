import urllib.request, json, re, html as htmllib, time

def get_transcript(vid, title):
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
    
    print(f'{vid}: {len(page)} chars, captionTracks={"captionTracks" in page}')
    
    if 'captionTracks' not in page:
        return None
    
    idx = page.find('captionTracks')
    snippet = page[idx:idx+800]
    
    # baseUrl is unicode-escaped inside the JSON
    m = re.search(r'"baseUrl":"(https://www\.youtube\.com/api/timedtext[^"]+)"', snippet)
    if not m:
        print(f'  No baseUrl. Snippet: {repr(snippet[:300])}')
        return None
    
    raw_url = m.group(1)
    # Unescape: \u0026 -> & and \/ -> /
    track_url = raw_url.encode('utf-8').decode('unicode_escape')
    print(f'  URL: {track_url[:100]}')
    
    req2 = urllib.request.Request(track_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req2, timeout=20) as r2:
        xml = r2.read().decode('utf-8')
    
    print(f'  XML length: {len(xml)}')
    texts = re.findall(r'<text[^>]*>(.*?)</text>', xml, re.DOTALL)
    cleaned = ' '.join([htmllib.unescape(re.sub('<[^>]+>', '', t)).strip() for t in texts])
    return cleaned


videos = [
    ('1PXFAFMgdns', 'The 7 Levels of Building ELITE Websites with Claude Code'),
    ('uqpXAfNEY4g', 'I Vibe Coded a $50K Website in One Weekend Using AI'),
]

for vid, title in videos:
    print(f'\n=== {title} ===')
    try:
        text = get_transcript(vid, title)
        if text:
            print(f'Length: {len(text)} chars')
            out = f'# {title}\nhttps://www.youtube.com/watch?v={vid}\n\n{text}'
            path = f'C:/Users/Robin/Jarvis/data/yt-transcript-{vid}.txt'
            with open(path, 'w', encoding='utf-8') as f:
                f.write(out)
            print(f'Saved to {path}')
            print('Preview:', text[:400])
        else:
            print('No transcript retrieved')
    except Exception as e:
        import traceback
        traceback.print_exc()
    time.sleep(3)
