"""Inspectable background runs for the paper → plan → prompt → image loop."""
import time
import os
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from uuid import uuid4
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field
from .teaser import TeaserRequest, plan_openai, render_openai_prompt, openai_key, lock_instructions
from .grounding import research_content
from .free_images import plan_pollinations
from .hf_images import build_flux_prompt, render_flux_prompt

router = APIRouter()
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='illustration')
_lock = Lock()
_runs = {}
STEPS = [('source','Read paper & brief'), ('plan','Build visual plan'), ('prompt','Compose drawing prompt'),
         ('render','Generate image'), ('check','Check image file')]

class WorkflowRequest(TeaserRequest):
    restart_from: Literal['plan','render'] = 'plan'
    drawing_prompt: str = Field(default='',max_length=32000)
    parent_version_id: str = Field(default='',max_length=100)


def _update(key, stage, message, **artifacts):
    with _lock:
        run = _runs[key]
        previous = run.get('stage')
        if previous and previous != stage:
            for step in run['steps']:
                if step['id'] == previous and step['status'] == 'running': step['status'] = 'complete'
        for step in run['steps']:
            if step['id'] == stage: step['status'] = 'running'
        run.update(status='running',stage=stage,message=message)
        run['artifacts'].update(artifacts)
        run['events'].append({'stage':stage,'message':message,'at':time.time()})


def _work(key, request):
    try:
        provider = os.getenv('TEASER_PROVIDER', 'flux-demo').strip().lower()
        if provider not in ('flux-demo', 'openai'):
            raise HTTPException(503, 'The version workflow supports TEASER_PROVIDER=openai or flux-demo.')
        if request.restart_from == 'render':
            with _lock:
                for step in _runs[key]['steps']:
                    if step['id'] in ('source','plan'): step['status'] = 'skipped'
            _update(key,'prompt','Reusing the selected version’s drawing instructions and applying your revision.')
            prompt = request.drawing_prompt.strip()
            if request.feedback.strip():
                prompt = 'Revision instructions (take precedence): ' + request.feedback.strip() + '\nPrevious drawing instructions: ' + prompt
            if lock_instructions(request):
                prompt += '\n\n' + lock_instructions(request)
            plan = {'generationMode':'user-directed','groundingPlan':None,
                    'generationNotes':['Re-rendered from saved drawing instructions. Paper claims were not revalidated for this revision.'],
                    'drawingBrief':prompt, 'scientificConcept':request.scientific_concept.model_dump() if request.scientific_concept else None}
        else:
            _update(key,'source','Reading the supplied paper text and removing publication metadata.' if request.paper else 'Reading your image request; no paper was attached.')
            input_characters = len(request.paper)
            cleaned = research_content(request.paper)
            request = request.model_copy(update={'paper':cleaned})
            _update(key,'plan','Connecting the research ideas to visual subjects and relationships.',
                    sourceSummary={'inputCharacters':input_characters,'researchCharacters':len(cleaned)})
            plan = plan_openai(request) if provider == 'openai' else plan_pollinations(request)
            _update(key,'prompt','Composing subject, composition, style, and revision instructions for the image model.',
                    scientificConcept=plan.get('scientificConcept'), visualMapping=plan.get('visualMapping'), promptSections=plan.get('promptSections'),
                    visualPlan=plan.get('groundingPlan'), sourceNotes=plan.get('sourceNotes',[]),
                    generationMode=plan.get('generationMode'), notes=plan.get('generationNotes',[]))
            prompt = plan['drawingBrief'] if provider == 'openai' else build_flux_prompt(request,plan)
        provider_label = 'OpenAI' if provider == 'openai' else 'FLUX'
        _update(key,'render',f'Sending the drawing instructions to {provider_label}. The image may take a little while.',drawingPrompt=prompt)
        render = render_openai_prompt if provider == 'openai' else render_flux_prompt
        result = render(prompt,plan,lambda stage,message:_update(key,stage,message))
        with _lock:
            run = _runs[key]
            for step in run['steps']:
                if step['status'] == 'running':step['status'] = 'complete'
            result.update(parentVersionId=request.parent_version_id or None, restartFrom=request.restart_from,
                          revisionFeedback=request.feedback, workflowSteps=deepcopy(run['steps']))
            run.update(status='complete',message='Image ready. Review it, then refine from any saved version.',result=result)
    except Exception as error:
        with _lock:
            run = _runs[key]
            for step in run['steps']:
                if step['status'] == 'running':step['status'] = 'failed'
            message = str(error.detail) if isinstance(error,HTTPException) else 'This generation step failed unexpectedly. Your previous versions are safe; retry this step.'
            run.update(status='failed',message=message)


@router.post('/api/teaser/runs',status_code=202)
def start_run(request: WorkflowRequest):
    if os.getenv('TEASER_PROVIDER', 'flux-demo').strip().lower() == 'openai':
        openai_key()
    if request.restart_from == 'render' and not request.drawing_prompt.strip():
        raise HTTPException(422,'A saved drawing prompt is required to restart rendering.')
    if request.restart_from == 'plan' and not any([request.paper.strip(),request.user_prompt.strip(),request.feedback.strip()]):
        raise HTTPException(422,'Add a paper or image request first.')
    with _lock:
        now = time.monotonic()
        for key in list(_runs):
            if _runs[key]['status'] in ('complete','failed') and now-_runs[key]['created']>1800: _runs.pop(key)
        if sum(run['status'] not in ('complete','failed') for run in _runs.values())>=4:
            raise HTTPException(429,'The demo is already processing several images. Please retry shortly.')
        # Bound completed image storage while never removing active work.
        if len(_runs)>=32:
            for key in list(_runs):
                if _runs[key]['status'] in ('complete','failed'):
                    _runs.pop(key);break
        key = str(uuid4())
        _runs[key] = {'id':key,'created':now,'status':'queued','stage':None,
                      'message':'Waiting for a generation slot.', 'steps':[{'id':s,'label':label,'status':'pending'} for s,label in STEPS],
                      'events':[],'artifacts':{},'result':None}
        initial = deepcopy(_runs[key])
    _pool.submit(_work,key,request)
    return initial


@router.get('/api/teaser/runs/{key}')
def get_run(key: str):
    with _lock:
        if key not in _runs:raise HTTPException(404,'This run expired or the server restarted. Your saved versions are still available; start a new run.')
        return deepcopy(_runs[key])
