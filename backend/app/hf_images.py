"""Call the official FLUX.1-schnell public Gradio demo API, with bounded waits."""
import base64
import json
import secrets
import time
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from .free_images import plan_pollinations
from .image_prompts import illustration_prompt

SPACE = 'https://black-forest-labs-flux-1-schnell.hf.space'
MODEL = 'FLUX.1-schnell'


def build_flux_prompt(request, plan):
    positive, exclusions = illustration_prompt(request, plan)
    # Schnell does not expose a negative-prompt parameter in this API.
    prompt = positive + '. Draw the requested objects and relationships, not a person or portrait. Avoid author photographs, institutional logos, watermarks and dense poster text.'
    if request.visual.density == 'none':
        prompt += ' No text or labels anywhere in the image.'
    if request.feedback.strip():
        prompt = 'Revision instructions (take precedence): ' + request.feedback.strip() + '\nBase visual direction: ' + prompt
    return prompt


def generate_flux_demo(request):
    plan = plan_pollinations(request)
    return render_flux_prompt(build_flux_prompt(request, plan), plan)


def render_flux_prompt(prompt, plan, progress=lambda stage, message: None):
    started = time.monotonic()
    try:
        with httpx.Client(timeout=90, follow_redirects=False) as client:
            queued = client.post(SPACE + '/gradio_api/call/infer', json={
                'data':[prompt, secrets.randbelow(2147483647), False, 768, 512, 4]})
            if queued.status_code in (401,403,429):
                raise HTTPException(503, 'The public FLUX demo has reached its quota or requires sign-in. Please retry later; no other model was substituted.')
            queued.raise_for_status()
            event_id = queued.json().get('event_id')
            if not isinstance(event_id, str) or not event_id.isalnum():
                raise HTTPException(502, 'The FLUX demo returned no valid generation job.')
            progress('render', 'FLUX accepted the request. Waiting for the generated image; the provider does not report a percentage.')
            output = None
            event = ''
            with client.stream('GET', SPACE + '/gradio_api/call/infer/' + event_id) as stream:
                stream.raise_for_status()
                for line in stream.iter_lines():
                    if time.monotonic() - started > 240:
                        raise HTTPException(504, 'The FLUX demo did not finish within four minutes. Please retry later.')
                    if line.startswith('event:'):
                        event = line[6:].strip()
                    elif line.startswith('data:'):
                        if event == 'error':
                            raise HTTPException(503, 'The public FLUX demo could not run this request (quota, queue, or worker failure). Please retry later.')
                        if event == 'complete':
                            output = json.loads(line[5:])
                            break
            if not isinstance(output, list) or not output or not isinstance(output[0], dict):
                raise HTTPException(502, 'The FLUX demo finished without an image.')
            image_url = output[0].get('url', '')
            parsed = urlparse(image_url)
            if parsed.scheme != 'https' or parsed.netloc != urlparse(SPACE).netloc or not parsed.path.startswith('/gradio_api/file='):
                raise HTTPException(502, 'The FLUX demo returned an unexpected image URL.')
            progress('check', 'Downloading the result and checking that it is a valid image file.')
            image_response = client.get(image_url)
            image_response.raise_for_status()
            content = image_response.content
    except httpx.HTTPError:
        raise HTTPException(502, 'The public FLUX demo is unavailable or timed out. Please retry; no placeholder image was saved.') from None
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(502, 'The FLUX demo returned a malformed response. Please retry.') from None
    mime = ('image/png' if content.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg' if content.startswith(b'\xff\xd8\xff')
            else 'image/webp' if content.startswith(b'RIFF') and content[8:12] == b'WEBP' else None)
    if not mime or len(content) < 1000:
        raise HTTPException(502, 'The FLUX demo returned no valid image; no placeholder was saved.')
    return {**plan, 'source':'huggingface-space', 'model':MODEL, 'drawingBrief':prompt,
            'planningBrief':plan.get('drawingBrief',''),
            'providerNote':'FLUX.1-schnell · official Black Forest Labs public demo. Review scientific details.',
            'image':f'data:{mime};base64,'+base64.b64encode(content).decode(),
            'seed':output[1] if len(output)>1 else None}
