"""Compact subject-first drawing instructions shared by demo renderers."""
from .free_images import _compact


def illustration_prompt(request, plan):
    """Diffusion models need concrete visual content first, not an editor's essay."""
    grounding = plan.get('groundingPlan')
    if grounding:
        subject = grounding['subject']
        details = '; '.join(element['depiction'] for element in grounding['elements'][:3])
        scene = subject + '. ' + details + '. ' + grounding['composition']
    else:
        notes = plan.get('sourceNotes') or []
        scene = request.user_prompt or ' '.join(notes[:2]) or request.title
        if request.user_prompt and notes:
            scene += '. Research concept: ' + notes[0]
    style = {'abstract': 'abstract conceptual illustration, symbolic shapes',
             'realistic': 'realistic technical illustration, detailed materials',
             'illustrated': 'educational illustration, clean shapes, clear visual relationships'}.get(request.visual.representation, 'educational illustration')
    purpose = {'evoke': 'one striking visual metaphor, simple composition',
               'explain': 'clear explanatory visual, connected objects and directional flow',
               'balance': 'memorable central concept with supporting visual relationships'}.get(request.visual.purpose, 'clear explanatory visual')
    layout = {'split': 'side-by-side comparison', 'central': 'central composition', 'stacked': 'vertical visual sequence'}.get(request.visual.layout, 'central composition')
    positive = '. '.join([_compact(scene.replace('###', ' '), 650), style, purpose, layout,
                          _compact(request.preferences.replace('###', ' '), 180),
                          _compact(request.factors.keepFixed.replace('###', ' '), 180),
                          'uncluttered background, object-focused composition'])
    # This workspace is configured for research concepts, not character portraits.
    negative = 'portrait, person, people, human figure, glamour, fashion model, selfie, face closeup, stock photo, author photograph, university logo, watermark, signature, dense poster'
    if request.visual.density == 'none':
        negative += ', text, letters, labels'
    else:
        positive += '. Minimal short labels only'
    return positive, negative

