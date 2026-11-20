"""Local, attributed cover references. Never download images during a generation."""
import hashlib
import json
import os
import re
from pathlib import Path

from fastapi import HTTPException

DEFAULT_LIBRARY = Path(__file__).resolve().parents[1] / 'examples' / 'nature_covers'

COVER_DIRECTION = """Create original scientific journal COVER ART, not a graphical abstract.
Express the paper's central idea through ONE visually arresting, coherent scene or material metaphor.
Use a dominant focal subject, intentional lighting, tactile materials, visual depth and negative space.
Select a coherent artistic language: cinematic realism, sculptural metaphor, abstract material study,
or bold editorial illustration. Do not mix reference styles into a collage.
Scientific mappings describe aspects of the SAME scene, not separate panels or icons.
Never use an icon collection, pictogram collage, flowchart, process diagram, boxes linked by arrows,
numbered steps, dashboard, multi-panel infographic, explanatory labels, legend or decorative charts.
No letters, journal masthead, Nature logo, headline, watermark or signature. Leave quiet space near
the top for future editorial typography, but render artwork only. Compose a portrait cover.
The reference images are examples of visual craft, not templates to reproduce. Ignore all text in
them. Do not reuse their subjects or import scientific content from them into this paper.
Preserve the supplied scientific claim and its uncertainty; no fabricated data or causal evidence.
Legacy explain/stacked/label settings describe scientific intent, not permission to draw a diagram.
"""


def library_root():
    return Path(os.getenv('TEASER_COVER_LIBRARY') or DEFAULT_LIBRARY).resolve()


def load_library():
    root = library_root()
    entries = []
    try:
        for path in sorted(root.glob('*/metadata.json')):
            if not path.resolve().is_relative_to(root):
                raise ValueError('External metadata path')
            item = json.loads(path.read_text())
            required = ('id', 'artwork_title', 'description', 'paper_title', 'style_family',
                        'source_url', 'image_url', 'image_sha256', 'design_principles', 'tags')
            if any(not item.get(key) for key in required) or item['id'] != path.parent.name:
                raise ValueError('Missing metadata')
            if item.get('image') not in ('image.jpg', 'image.png') or 'author' not in item:
                raise ValueError('Invalid image metadata')
            read_reference(item, root)
            entries.append(item)
        if not entries:
            raise ValueError('Empty library')
        return entries
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, 'Cover reference library is missing or invalid. Check image files, metadata and checksums.') from None


def image_mime(data):
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    raise ValueError('Invalid reference image')


def read_reference(item, root=None):
    root = root or library_root()
    path = (root / item['id'] / item['image']).resolve()
    if not path.is_relative_to(root) or path.stat().st_size > 5_000_000:
        raise ValueError('Invalid reference path or size')
    data = path.read_bytes()
    mime = image_mime(data)
    if len(data) < 1000 or mime != ('image/png' if item['image'].endswith('.png') else 'image/jpeg'):
        raise ValueError('Invalid reference image')
    if hashlib.sha256(data).hexdigest() != item['image_sha256']:
        raise ValueError('Reference checksum mismatch')
    return data


def select_references(request):
    entries = load_library()
    text = ' '.join([request.user_prompt, request.preferences, request.title,
                     request.scientific_concept.model_dump_json() if request.scientific_concept else request.paper[:12000],
                     request.visual.representation]).lower()
    tokens = set(re.findall(r'[a-z]+', text))
    ranked = sorted(entries, key=lambda item: (-len(tokens.intersection(item['tags'])), item['id']))
    if request.cover_style:
        matching = [item for item in ranked if item['style_family'] == request.cover_style]
        if not matching:
            raise HTTPException(422, 'Unknown cover style. Choose a style from the cover library.')
        ranked = matching + [item for item in ranked if item not in matching]
    return ranked[:2]


def reference_images(plan):
    ids = plan.get('coverReferenceIds', [])
    if not ids:
        return []
    catalog = {item['id']: item for item in load_library()}
    if len(ids) > 2 or any(key not in catalog for key in ids):
        raise HTTPException(503, 'The selected cover references are no longer available.')
    return [read_reference(catalog[key]) for key in ids]


def reference_context(references):
    return json.dumps([{'id': item['id'], 'style': item['style_family'],
                        'description': item['description'], 'principles': item['design_principles']}
                       for item in references], ensure_ascii=False)
