from __future__ import annotations
import base64
import json
import os
import asyncio
import uuid
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import aiohttp

def get_config_key(key_name):
    val = os.environ.get(key_name.upper())
    if val: return val
    try:
        conf_path = Path('C:/Users/Robin/Jarvis/Mission-Control/config.json')
        if conf_path.exists():
            conf = json.loads(conf_path.read_text(encoding='utf-8'))
            return conf.get(key_name.lower())
    except: pass
    return None

_OPENAI_IMAGE_URL = 'https://api.openai.com/v1/images/generations'
_GEMINI_IMAGE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
_GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-image-preview'  # Nano Banana 2 — Robins Default

# Modell-Katalog für Gemini Image (Stand 2026-04).
# Preise laut Google AI Studio, können sich ändern — siehe https://ai.google.dev/pricing
GEMINI_IMAGE_MODELS = {
    'gemini-2.5-flash-image': {
        'label': 'Nano Banana',
        'description': 'Günstig, schnell, gute Qualität. Standard-Wahl.',
        # Image-Output wird in Google's Billing als ~1290 Tokens pro 1024x1024-Bild berechnet.
        'usd_per_image': 0.039,
        'usd_per_1m_text_input': 0.30,
    },
    'gemini-3-pro-image-preview': {
        'label': 'Nano Banana Pro',
        'description': 'Premium. Bessere Faces, Text, Stil-Kontrolle. ~3x teurer.',
        'usd_per_image': 0.12,
        'usd_per_1m_text_input': 1.25,
    },
    'gemini-3.1-flash-image-preview': {
        'label': 'Nano Banana 2',
        'description': 'Neuestes Preview, zwischen Flash und Pro.',
        'usd_per_image': 0.06,
        'usd_per_1m_text_input': 0.50,
    },
}

# Usage-Log für Cost-Tracking
_USAGE_LOG_PATH = Path('C:/Users/Robin/Jarvis/Mission-Control/data/image_usage.jsonl')


def _log_image_usage(entry: dict) -> None:
    """Schreibt eine Zeile in image_usage.jsonl — für Cost-Tracking via /api/image/usage."""
    try:
        _USAGE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _USAGE_LOG_PATH.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception as e:
        print(f'[image_usage] log failed: {e}')


def _estimate_cost_usd(provider: str, model: str, usage_metadata: dict | None, num_images: int = 1) -> float:
    """Schätzt USD-Kosten für diesen Aufruf. Rundet nicht — Caller formatiert."""
    if provider == 'gemini':
        info = GEMINI_IMAGE_MODELS.get(model, GEMINI_IMAGE_MODELS[_GEMINI_DEFAULT_MODEL])
        cost = num_images * info['usd_per_image']
        # Input-Text-Kosten dazu (meist Bruchteil eines Cent)
        if usage_metadata:
            in_tok = int(usage_metadata.get('promptTokenCount', 0) or 0)
            cost += in_tok * info['usd_per_1m_text_input'] / 1_000_000
        return cost
    if provider == 'openai':
        # OpenAI-Pricing: gpt-image-1 ~$0.04 Standard 1024x1024, ~$0.08 HD
        return 0.04 * num_images
    if provider == 'bria':
        return 0.02 * num_images  # grob, siehe bria.ai/pricing
    return 0.0

@dataclass
class GeneratedImage:
    path: Path
    url: str
    provider: str
    model: str
    prompt: str
    size: str
    mime_type: str = 'image/png'
    metadata: dict | None = None

class ImageGenError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(f'[{code}] {message}')

async def _generate_openai(prompt, out_path, model='gpt-image-1', size='1024x1024', **kwargs):
    api_key = get_config_key('openai_api_key')
    if not api_key: raise ImageGenError('not_configured', 'OpenAI Key fehlt')
    if not model: model = 'gpt-image-1'
    if not size: size = '1024x1024'
    payload = {'model': model, 'prompt': prompt, 'n': 1, 'size': size, 'response_format': 'b64_json'}
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    async with aiohttp.ClientSession() as sess:
        async with sess.post(_OPENAI_IMAGE_URL, json=payload, headers=headers) as resp:
            if resp.status != 200: 
                err_text = await resp.text()
                raise ImageGenError('api_error', f'OpenAI {resp.status}: {err_text[:200]}')
            data = await resp.json()
            img_bytes = base64.b64decode(data['data'][0]['b64_json'])
            out_path.write_bytes(img_bytes)
    return {'model': model, 'size': size}

async def _generate_gemini(prompt, out_path, model=_GEMINI_DEFAULT_MODEL, reference_images=None, **_unused):
    """reference_images: optional list of Path | str — werden als inlineData
    parts vor dem Text gepackt. Nano Banana nutzt das fuer Subject-Consistency."""
    api_key = get_config_key('gemini_api_key')
    if not api_key: raise ImageGenError('not_configured', 'Gemini Key fehlt')
    if not model:
        model = _GEMINI_DEFAULT_MODEL
    url = _GEMINI_IMAGE_URL.format(model=model) + f'?key={api_key}'

    parts = []
    if reference_images:
        # Bilder zuerst — Modell setzt sie als visuellen Kontext, Text-Prompt referenziert sie.
        for ref in reference_images:
            ref_path = Path(ref) if not isinstance(ref, Path) else ref
            if not ref_path.is_file(): continue
            suf = ref_path.suffix.lower().lstrip('.')
            mime = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                    'webp': 'image/webp', 'gif': 'image/gif'}.get(suf, 'image/jpeg')
            try:
                ref_b64 = base64.b64encode(ref_path.read_bytes()).decode('ascii')
                parts.append({'inlineData': {'mimeType': mime, 'data': ref_b64}})
            except Exception as e:
                print(f'[gemini-img] reference {ref_path} skipped: {e}')
    parts.append({'text': prompt})

    # Google hat "responseModalities: [IMAGE]" allein deprecated — TEXT muss dabei sein.
    payload = {
        'contents': [{'parts': parts}],
        'generationConfig': {'responseModalities': ['TEXT', 'IMAGE']}
    }
    async with aiohttp.ClientSession() as sess:
        async with sess.post(url, json=payload) as resp:
            body = await resp.text()
            if resp.status != 200:
                raise ImageGenError('api_error', f'Gemini {resp.status}: {body[:300]}')
            data = json.loads(body)
            usage_metadata = data.get('usageMetadata', {}) or {}
            cand = data.get('candidates', [{}])[0]
            parts = cand.get('content', {}).get('parts', [])
            for p in parts:
                if 'inlineData' in p:
                    img_bytes = base64.b64decode(p['inlineData']['data'])
                    out_path.write_bytes(img_bytes)
                    return {'model': model, 'usage_metadata': usage_metadata}
    # Kein Bild erhalten — die finishReason gibt Hinweise was schiefging
    finish = (cand or {}).get('finishReason', 'UNKNOWN') if 'cand' in dir() else 'UNKNOWN'
    msg = (cand or {}).get('finishMessage', '') if 'cand' in dir() else ''
    hint_map = {
        'IMAGE_SAFETY': 'Sicherheitsfilter hat das Bild blockiert (Person/Gewalt/etc). Probier ohne Reference-Bilder oder anderen Prompt.',
        'IMAGE_PROHIBITED_CONTENT': 'Prompt verletzt Content-Policy. Anderen Prompt probieren.',
        'IMAGE_RECITATION': 'Modell hat Recitation-Filter getriggert (zu nah an Trainingsdaten). Prompt umformulieren.',
        'IMAGE_OTHER': 'Pro-Modell konnte das Bild nicht generieren — oft transient. Nochmal probieren oder Nano Banana 2 nutzen.',
        'SAFETY': 'Sicherheitsfilter hat blockiert. Prompt sanfter formulieren.',
        'BLOCKLIST': 'Wort aus der Blocklist im Prompt — wechsle die Formulierung.',
        'OTHER': 'Generation abgebrochen ohne klaren Grund — meist transient. Nochmal probieren.',
        'PROHIBITED_CONTENT': 'Prohibited Content. Prompt-Formulierung anpassen.',
    }
    hint = hint_map.get(finish, f'Unbekannter finishReason: {finish}')
    raise ImageGenError('empty', f'{hint} ({finish})')

async def _generate_bria(prompt, out_path, aspect_ratio='1:1', **_unused):
    api_key = get_config_key('bria_api_key')
    if not api_key: raise ImageGenError('not_configured', 'Bria Key fehlt')
    headers = {'api_token': api_key, 'Content-Type': 'application/json'}
    async with aiohttp.ClientSession() as sess:
        async with sess.post('https://engine.prod.bria-api.com/v2/image/generate', json={'prompt': prompt, 'aspect_ratio': aspect_ratio}, headers=headers) as r:
            if r.status not in (200, 201, 202): 
                err_body = await r.text()
                raise ImageGenError('api_error', f'Bria Start {r.status}: {err_body[:200]}')
            data = await r.json()
            req_id = data.get('request_id')
        
        for _ in range(30):
            await asyncio.sleep(2)
            async with sess.get(f'https://engine.prod.bria-api.com/v2/status/{req_id}', headers=headers) as r:
                st = await r.json()
                if st['status'] == 'COMPLETED':
                    img_url = st['result']['image_url']
                    async with sess.get(img_url) as r_img:
                        out_path.write_bytes(await r_img.read())
                        return {'model': 'bria-fibo'}
                if st['status'] == 'FAILED': raise ImageGenError('api_error', f'Bria Generation Failed: {st}')
    raise ImageGenError('timeout', 'Bria Timeout')

async def generate_image(*, provider, prompt, uploads_dir, reference_images=None, **kwargs):
    """reference_images: optional list of Path/str fuer Multi-Image-Input (Subject-Consistency).
    Aktuell nur Gemini-Provider unterstuetzt das nativ."""
    prov = provider.lower()
    out_dir = uploads_dir / 'images' / 'generated'
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f'{prov}_{int(time.time())}_{uuid.uuid4().hex[:8]}.png'
    t0 = time.time()
    if prov == 'bria': meta = await _generate_bria(prompt, out_path, **kwargs)
    elif prov == 'openai': meta = await _generate_openai(prompt, out_path, **kwargs)
    else: meta = await _generate_gemini(prompt, out_path, reference_images=reference_images, **kwargs)
    url = '/api/uploads/' + str(out_path.relative_to(uploads_dir)).replace('\\', '/')
    used_model = meta.get('model', 'unknown')
    usage_metadata = meta.get('usage_metadata') or {}
    estimated_cost = _estimate_cost_usd(prov, used_model, usage_metadata, num_images=1)
    # Usage-Log für Cost-Tracking (JSONL append-only)
    _log_image_usage({
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'provider': prov,
        'model': used_model,
        'prompt_chars': len(prompt or ''),
        'prompt_preview': (prompt or '')[:120],
        'usage_metadata': usage_metadata,
        'estimated_cost_usd': round(estimated_cost, 5),
        'duration_sec': round(time.time() - t0, 2),
        'output_path': str(out_path.relative_to(uploads_dir)).replace('\\', '/'),
    })
    return GeneratedImage(
        path=out_path, url=url, provider=prov, model=used_model,
        prompt=prompt, size=kwargs.get('size', '1024x1024'),
        metadata={'usage_metadata': usage_metadata, 'estimated_cost_usd': estimated_cost},
    )


def read_usage_log(period: str = 'all') -> dict:
    """Liest image_usage.jsonl und gibt Summary zurück.

    period: 'today' | 'month' | 'all'
    Returns: {total_images, total_usd, by_provider, by_model, entries_count, recent: [last 10]}
    """
    if not _USAGE_LOG_PATH.exists():
        return {
            'total_images': 0, 'total_usd': 0.0, 'by_provider': {}, 'by_model': {},
            'entries_count': 0, 'recent': [], 'period': period,
        }
    now = time.strftime('%Y-%m-%dT%H:%M:%S')
    today_prefix = now[:10]
    month_prefix = now[:7]
    entries: list = []
    try:
        with _USAGE_LOG_PATH.open('r', encoding='utf-8') as fh:
            for line in fh:
                try:
                    e = json.loads(line.strip())
                except Exception:
                    continue
                ts = e.get('timestamp', '')
                if period == 'today' and not ts.startswith(today_prefix):
                    continue
                if period == 'month' and not ts.startswith(month_prefix):
                    continue
                entries.append(e)
    except Exception as ex:
        return {'error': str(ex), 'period': period}
    total_usd = sum(float(e.get('estimated_cost_usd', 0) or 0) for e in entries)
    by_provider: dict = {}
    by_model: dict = {}
    for e in entries:
        p = e.get('provider', '?')
        m = e.get('model', '?')
        by_provider[p] = by_provider.get(p, 0) + 1
        by_model[m] = by_model.get(m, 0) + 1
    return {
        'total_images': len(entries),
        'total_usd': round(total_usd, 4),
        'by_provider': by_provider,
        'by_model': by_model,
        'entries_count': len(entries),
        'recent': entries[-10:][::-1],  # letzte 10 neueste zuerst
        'period': period,
    }


def list_image_providers():
    return [
        {'name': 'openai', 'label': 'OpenAI', 'configured': bool(get_config_key('openai_api_key'))},
        {
            'name': 'gemini',
            'label': 'Gemini (Nano Banana)',
            'configured': bool(get_config_key('gemini_api_key')),
            'models': [
                {'id': mid, **info}
                for mid, info in GEMINI_IMAGE_MODELS.items()
            ],
            'default_model': _GEMINI_DEFAULT_MODEL,
        },
        {'name': 'bria', 'label': 'Bria-AI (Pro)', 'configured': bool(get_config_key('bria_api_key'))}
    ]
