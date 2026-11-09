"""Queued, explicit-model illustration generation on AI Horde's public API."""
import base64
import os
import re
import time
from threading import Lock
from uuid import uuid4
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from .free_images import plan_pollinations
from .image_prompts import illustration_prompt

BASE = 'https://aihorde.net/api/v2'
_jobs = {}
_lock = Lock()


def _headers():
    return {'apikey': os.getenv('AI_HORDE_API_KEY', '').strip() or '0000000000',
            'Client-Agent': 'ResearchIllustration:0.1:demo'}


def _request(method, path, **kwargs):
    try:
        response = httpx.request(method, BASE + path, headers=_headers(), timeout=30, **kwargs)
    except httpx.HTTPError:
        raise HTTPException(502, 'AI Horde could not be reached. Please retry.') from None
    if not response.is_success:
        try:
            message = response.json().get('message', '')
        except ValueError:
            message = ''
        raise HTTPException(503 if response.status_code == 403 else response.status_code,
                            'AI Horde: ' + (message[:500] or f'HTTP {response.status_code}'))
    return response.json()



def start_horde(request):
    with _lock:
        now = time.monotonic()
        for key in list(_jobs):
            if now - _jobs[key]['created'] > 1800:
                _jobs.pop(key)
        if len(_jobs) >= 32:
            raise HTTPException(429, 'The demo has too many image jobs. Please retry later.')
    plan = plan_pollinations(request)
    positive, negative = illustration_prompt(request, plan)
    model = os.getenv('AI_HORDE_MODEL', 'stable_diffusion').strip()
    payload = {'prompt': positive + ' ### ' + negative,
               'params': {'width':512, 'height':512, 'steps':20, 'cfg_scale':7, 'sampler_name':'k_euler', 'n':1},
               'models':[model], 'nsfw':False, 'censor_nsfw':True, 'validated_backends':True,
               'r2':True, 'shared': _headers()['apikey'] == '0000000000'}
    queued = _request('POST', '/generate/async', json=payload)
    if not queued.get('id'):
        raise HTTPException(502, 'AI Horde did not return a generation job ID.')
    if any(w.get('code') == 'NoAvailableWorker' for w in queued.get('warnings', [])):
        _request('DELETE', '/generate/status/' + queued['id'])
        raise HTTPException(503, f'No AI Horde worker can currently run {model}. Please retry later or configure AI_HORDE_MODEL.')
    key = str(uuid4())
    result = {**plan, 'source':'aihorde', 'model':model, 'drawingBrief':positive, 'negativePrompt':negative,
              'providerNote':f'AI Horde · {model}. Demo illustration; check scientific details.',
              'planningBrief':plan.get('drawingBrief', '')}
    with _lock:
        _jobs[key] = {'created':time.monotonic(), 'remote':queued['id'], 'result':result, 'complete':False}
    return {'status':'queued', 'jobId':key, 'model':model, 'provider':'aihorde'}


def horde_status(key):
    with _lock:
        job = _jobs.get(key)
    if not job:
        raise HTTPException(404, 'This image job expired or the server restarted. Generate again.')
    if job['complete']:
        return job['result']
    if time.monotonic() - job['created'] > 1200:
        _request('DELETE', '/generate/status/' + job['remote'])
        with _lock:
            _jobs.pop(key, None)
        raise HTTPException(504, 'AI Horde did not finish within 20 minutes. Please retry later.')
    state = _request('GET', '/generate/check/' + job['remote'])
    if state.get('faulted'):
        raise HTTPException(502, 'The AI Horde worker failed to render this image. Please retry.')
    if not state.get('done'):
        return {'status':'rendering' if state.get('processing') else 'queued', 'jobId':key,
                'queuePosition':state.get('queue_position'), 'waitSeconds':state.get('wait_time'),
                'model':job['result']['model']}
    response = _request('GET', '/generate/status/' + job['remote'])
    generations = response.get('generations') or []
    if not generations:
        raise HTTPException(502, 'AI Horde finished without an image. Please retry.')
    generated = generations[0]
    if generated.get('censored'):
        raise HTTPException(422, 'The image provider filtered this result. Revise the request and retry.')
    if generated.get('model') != job['result']['model']:
        raise HTTPException(502, 'AI Horde returned an unexpected model; the result was not accepted.')
    value = generated.get('img', '')
    # API image URLs are untrusted: do not fetch internal URLs or redirects.
    parsed = urlparse(value)
    if parsed.scheme == 'https' and (parsed.hostname or '').endswith(('.r2.cloudflarestorage.com', '.aihorde.net')):
        try:
            image_response = httpx.get(value, timeout=30, follow_redirects=False)
            image_response.raise_for_status()
            content = image_response.content
        except httpx.HTTPError:
            raise HTTPException(502, 'Could not download the generated image. Retry checking this job.') from None
    elif not parsed.scheme:
        try:
            content = base64.b64decode(value, validate=True)
        except (ValueError, TypeError):
            raise HTTPException(502, 'AI Horde returned invalid image data.') from None
    else:
        raise HTTPException(502, 'AI Horde returned an unsupported image download URL.')
    mime = ('image/png' if content.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg' if content.startswith(b'\xff\xd8\xff')
            else 'image/webp' if content.startswith(b'RIFF') and content[8:12] == b'WEBP' else None)
    if not mime or len(content) < 1000:
        raise HTTPException(502, 'AI Horde returned no valid image; no placeholder was saved.')
    result = {**job['result'], 'image':f'data:{mime};base64,' + base64.b64encode(content).decode(),
              'seed':generated.get('seed'), 'status':'complete'}
    with _lock:
        job['result'] = result
        job['complete'] = True
    return result
