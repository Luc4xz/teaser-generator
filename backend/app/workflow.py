"""Inspectable background runs for the paper → plan → prompt → image loop."""
import time
import logging
import os
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from uuid import uuid4
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import Field
from .teaser import TeaserRequest, plan_openai, render_openai_prompt, openai_key, lock_instructions, extract_concept_with_progress
from .grounding import research_content
from .free_images import plan_pollinations
from .hf_images import build_flux_prompt, render_flux_prompt

logger = logging.getLogger(__name__)
from .boards import require_session
from .model_providers import resolve_model, render_image

router = APIRouter(dependencies=[Depends(require_session)])
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='illustration')
_lock = Lock()
_runs = {}
_TERMINAL = {'complete', 'failed', 'cancelled'}
STEPS = [('source','Read paper & brief'), ('plan','Build visual plan'), ('prompt','Compose drawing prompt'),
         ('render','Generate image'), ('check','Check image file')]

CONCEPT_STEPS = [('source', 'Prepare paper & locked fields'), ('summary', 'Prepare research context'),
                 ('concept', 'Generate scientific concept'), ('check', 'Validate concept fields')]

class WorkflowRequest(TeaserRequest):
    restart_from: Literal['plan','render'] = 'plan'
    drawing_prompt: str = Field(default='',max_length=32000)
    parent_version_id: str = Field(default='',max_length=100)


class RunCancelled(Exception):
    pass


def _public_run(run):
    return deepcopy({name: value for name, value in run.items() if not name.startswith('_')})


def _active_run(key):
    run = _runs[key]
    if run['status'] == 'cancelled':
        raise RunCancelled()
    return run


def _update(key, stage, message, **artifacts):
    with _lock:
        run = _active_run(key)
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
        provider = 'selected' if request.image_model else os.getenv('TEASER_PROVIDER', 'flux-demo').strip().lower()
        if provider not in ('flux-demo', 'openai', 'selected'):
            raise HTTPException(503, 'The version workflow supports TEASER_PROVIDER=openai or flux-demo.')
        if request.restart_from == 'render':
            with _lock:
                for step in _active_run(key)['steps']:
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
            plan = plan_openai(request) if provider != 'flux-demo' else plan_pollinations(request)
            _update(key,'prompt','Composing subject, composition, style, and revision instructions for the image model.',
                    scientificConcept=plan.get('scientificConcept'), visualMapping=plan.get('visualMapping'), promptSections=plan.get('promptSections'),
                    visualPlan=plan.get('groundingPlan'), sourceNotes=plan.get('sourceNotes',[]),
                    generationMode=plan.get('generationMode'), notes=plan.get('generationNotes',[]))
            prompt = plan['drawingBrief'] if provider != 'flux-demo' else build_flux_prompt(request,plan)
        provider_label = resolve_model(request.image_model, 'image').label if request.image_model else 'OpenAI' if provider == 'openai' else 'FLUX'
        _update(key,'render',f'Sending the drawing instructions to {provider_label}. The image may take a little while.',drawingPrompt=prompt)
        render = render_openai_prompt if provider == 'openai' else render_flux_prompt
        progress = lambda stage,message:_update(key,stage,message)
        result = render_image(prompt,plan,request.image_model,progress) if request.image_model else render(prompt,plan,progress)
        with _lock:
            run = _active_run(key)
            for step in run['steps']:
                if step['status'] == 'running':step['status'] = 'complete'
                elif step['status'] == 'pending':step['status'] = 'skipped'
            result.update(parentVersionId=request.parent_version_id or None, restartFrom=request.restart_from,
                          revisionFeedback=request.feedback, workflowSteps=deepcopy(run['steps']))
            run.update(status='complete',message='Image ready. Review it, then refine from any saved version.',result=result)
    except RunCancelled:
        return
    except Exception as error:
        _fail(key, error, 'This generation step failed unexpectedly. Your previous versions are safe; retry this step.')


def _fail(key, error, fallback):
    with _lock:
        run = _runs[key]
        if run['status'] == 'cancelled':
            return
        for step in run['steps']:
            if step['status'] == 'running':
                step['status'] = 'failed'
        message = str(error.detail) if isinstance(error, HTTPException) else fallback
        run.update(status='failed', message=message)
    if not isinstance(error, HTTPException):
        logger.exception("Generation run %s failed", key)


@router.post('/api/teaser/runs',status_code=202)
def start_run(request: WorkflowRequest, session: Annotated[Optional[dict], Depends(require_session)] = None):
    if request.image_model:
        resolve_model(request.image_model, 'image')
        if request.restart_from == 'plan': resolve_model(request.text_model, 'text')
    elif os.getenv('TEASER_PROVIDER', 'flux-demo').strip().lower() == 'openai':
        openai_key()
    if request.restart_from == 'render' and not request.drawing_prompt.strip():
        raise HTTPException(422,'A saved drawing prompt is required to restart rendering.')
    if request.restart_from == 'plan' and not any([request.paper.strip(),request.user_prompt.strip(),request.feedback.strip()]):
        raise HTTPException(422,'Add a paper or image request first.')
    return _enqueue(request, _work, STEPS, session)


def _execute(key, request, worker):
    try:
        with _lock:
            _active_run(key)
        worker(key, request)
    except RunCancelled:
        return
    finally:
        with _lock:
            _runs[key]['_future'] = None


def _enqueue(request, worker, steps, session):
    with _lock:
        now = time.monotonic()
        for key in list(_runs):
            run = _runs[key]
            if run['status'] in _TERMINAL and run['_future'] is None and now-run['created']>1800:
                _runs.pop(key)
        if sum(run['status'] not in _TERMINAL or (run['status'] == 'cancelled' and run['_future'] is not None) for run in _runs.values())>=4:
            raise HTTPException(429,'Several generations are already in progress. Please retry shortly.')
        # Bound completed image storage while never removing active work.
        if len(_runs)>=32:
            for key in list(_runs):
                if _runs[key]['status'] in _TERMINAL and _runs[key]['_future'] is None:
                    _runs.pop(key);break
        key = str(uuid4())
        _runs[key] = {'id':key,'created':now,'status':'queued','stage':None,
                      'message':'Waiting for a generation slot.', 'steps':[{'id':s,'label':label,'status':'pending'} for s,label in steps],
                      'events':[],'artifacts':{},'result':None, '_owner':session['user_id'] if session else None}
        _runs[key]['_future'] = _pool.submit(_execute, key, request, worker)
        return _public_run(_runs[key])


@router.get('/api/teaser/runs/{key}')
def get_run(key: str):
    with _lock:
        if key not in _runs:raise HTTPException(404,'This run expired or the server restarted. Your saved versions are still available; start a new run.')
        return _public_run(_runs[key])


@router.post('/api/teaser/runs/{key}/cancel')
def cancel_run(key: str, session: Annotated[dict, Depends(require_session)]):
    with _lock:
        run = _runs.get(key)
        if not run or run['_owner'] != session['user_id']:
            raise HTTPException(404, 'This generation is no longer available.')
        if run['status'] not in _TERMINAL:
            run.update(status='cancelled', message='Generation stopped.')
            for step in run['steps']:
                if step['status'] == 'running':
                    step['status'] = 'cancelled'
            future = run['_future']
            if future is not None and future.cancel():
                run['_future'] = None
        return {'id':key, 'status':run['status']}


@router.post('/api/teaser/concept-runs', status_code=202)
def start_concept_run(request: TeaserRequest, session: Annotated[Optional[dict], Depends(require_session)] = None):
    if not request.paper.strip():
        raise HTTPException(422, 'Add a paper before generating a concept.')
    resolve_model(request.text_model, 'text')
    return _enqueue(request, _concept_work, CONCEPT_STEPS, session)


def _concept_work(key, request):
    try:
        result = extract_concept_with_progress(request, lambda stage, message: _update(key, stage, message))
        with _lock:
            run = _active_run(key)
            for step in run['steps']:
                if step['status'] == 'running': step['status'] = 'complete'
                elif step['status'] == 'pending': step['status'] = 'skipped'
            run.update(status='complete', message='Concept ready. Edit the fields below, then generate your image.', result=result)
    except RunCancelled:
        return
    except Exception as error:
        _fail(key, error, 'Concept generation failed unexpectedly. Your previous concept is safe; try again.')
