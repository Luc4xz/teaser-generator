import unittest
import os
from unittest.mock import patch
from fastapi import HTTPException
from backend.app.workflow import WorkflowRequest, start_run, get_run, _work, _runs, _lock

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {'TEASER_PROVIDER': 'flux-demo'})
        environment.start()
        self.addCleanup(environment.stop)
        with _lock:_runs.clear()

    @patch.dict(os.environ, {'TEASER_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test-key'})
    def test_openai_workflow_does_not_call_public_providers(self):
        req = WorkflowRequest(user_prompt='A leaf')
        key = self.queued(req)
        with patch('backend.app.workflow.plan_openai', return_value={'drawingBrief':'Draw a leaf'}) as planner, patch('backend.app.workflow.render_openai_prompt', side_effect=self.render), patch('backend.app.workflow.plan_pollinations') as public_plan, patch('backend.app.workflow.render_flux_prompt') as flux:
            _work(key, req)
        planner.assert_called_once()
        public_plan.assert_not_called()
        flux.assert_not_called()
        self.assertEqual(get_run(key)['status'], 'complete')
        self.assertEqual(get_run(key)['result']['drawingBrief'], 'Draw a leaf')

    @patch.dict(os.environ, {'TEASER_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test-key'})
    def test_openai_retry_uses_saved_prompt_without_planning(self):
        req = WorkflowRequest(restart_from='render', drawing_prompt='Saved drawing instructions')
        key = self.queued(req)
        with patch('backend.app.workflow.plan_openai') as planner, patch('backend.app.workflow.render_openai_prompt', side_effect=self.render), patch('backend.app.workflow.render_flux_prompt') as flux:
            _work(key, req)
        planner.assert_not_called()
        flux.assert_not_called()
        self.assertEqual(get_run(key)['result']['drawingBrief'], req.drawing_prompt)

    @patch.dict(os.environ, {'TEASER_PROVIDER': 'openai', 'OPENAI_API_KEY': ''})
    def test_missing_openai_key_rejected_before_queueing(self):
        with self.assertRaises(HTTPException) as error:
            self.queued(WorkflowRequest(user_prompt='A leaf'))
        self.assertEqual(error.exception.status_code, 503)
        self.assertFalse(_runs)

    def queued(self, request):
        with patch('backend.app.workflow._pool.submit'):
            return start_run(request)['id']

    def render(self,prompt,plan,progress):
        progress('render','Provider accepted the job')
        progress('check','Checking the image file')
        return {**plan,'image':'data:image/png;base64,eA==','drawingBrief':prompt}

    def test_actual_stages_and_intermediate_prompt_survive_completion(self):
        req=WorkflowRequest(user_prompt='Leaf',feedback='Show fewer elements',parent_version_id='v1')
        key=self.queued(req)
        with patch('backend.app.workflow.plan_pollinations',return_value={'drawingBrief':'Plan','groundingPlan':None,'generationMode':'user-directed'}),patch('backend.app.workflow.render_flux_prompt',side_effect=self.render):
            _work(key,req)
        run=get_run(key)
        self.assertEqual(run['status'],'complete')
        self.assertTrue(all(s['status']=='complete' for s in run['steps']))
        self.assertIn('Show fewer elements',run['artifacts']['drawingPrompt'])
        self.assertEqual(run['result']['parentVersionId'],'v1')
        self.assertEqual([e['stage'] for e in run['events']],['source','plan','prompt','render','render','check'])

    def test_render_restart_skips_planner_and_preserves_parent(self):
        req=WorkflowRequest(restart_from='render',drawing_prompt='Draw a leaf',feedback='Use a white background',parent_version_id='v2')
        key=self.queued(req)
        with patch('backend.app.workflow.plan_pollinations') as planner,patch('backend.app.workflow.render_flux_prompt',side_effect=self.render):
            _work(key,req)
            planner.assert_not_called()
        run=get_run(key)
        self.assertEqual(run['steps'][0]['status'],'skipped')
        self.assertEqual(run['steps'][1]['status'],'skipped')
        self.assertIn('Use a white background',run['result']['drawingBrief'])
        self.assertIsNone(run['result']['groundingPlan'])
        self.assertEqual(run['result']['parentVersionId'],'v2')

    def test_failed_render_keeps_prompt_for_retry_and_records_failed_step(self):
        req=WorkflowRequest(user_prompt='Leaf');key=self.queued(req)
        with patch('backend.app.workflow.plan_pollinations',return_value={'drawingBrief':'Plan','groundingPlan':None}),patch('backend.app.workflow.render_flux_prompt',side_effect=HTTPException(503,'Provider quota')):
            _work(key,req)
        run=get_run(key)
        self.assertEqual(run['status'],'failed')
        self.assertEqual(run['stage'],'render')
        self.assertEqual(run['message'],'Provider quota')
        self.assertIn('Leaf',run['artifacts']['drawingPrompt'])
        self.assertIsNone(run['result'])

    def test_missing_prompt_cannot_skip_planning(self):
        with self.assertRaises(HTTPException):start_run(WorkflowRequest(restart_from='render'))

    def test_reading_run_does_not_allow_mutating_stored_history(self):
        key=self.queued(WorkflowRequest(user_prompt='Leaf'))
        copy=get_run(key);copy['steps'][0]['status']='fake'
        self.assertEqual(get_run(key)['steps'][0]['status'],'pending')

    def test_concurrency_limit_rejects_excess_work(self):
        for _ in range(4):self.queued(WorkflowRequest(user_prompt='Leaf'))
        with self.assertRaises(HTTPException) as e:self.queued(WorkflowRequest(user_prompt='Leaf'))
        self.assertEqual(e.exception.status_code,429)
