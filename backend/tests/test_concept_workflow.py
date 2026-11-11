import os
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from backend.app.teaser import TeaserRequest
from backend.app.scientific_concept import ScientificConcept
from backend.app.workflow import start_concept_run, _concept_work, get_run, _runs, _lock

CONCEPT = {key: 'Research detail' for key in ScientificConcept.model_fields}

@patch.dict(os.environ, {'OPENAI_API_KEY': 'test-key'})
class ConceptWorkflowTests(unittest.TestCase):
    def setUp(self):
        with _lock: _runs.clear()

    def queued(self, request):
        with patch('backend.app.workflow._pool.submit'):
            return start_concept_run(request)['id']

    def test_real_extraction_stages_and_result_without_image_generation(self):
        request = TeaserRequest(paper='Research paper')
        key = self.queued(request)
        def analyze(*args):
            self.assertEqual(get_run(key)['stage'], 'concept')
            return ScientificConcept.model_validate(CONCEPT)
        with patch('backend.app.teaser.OpenAI'), patch('backend.app.teaser.structured_analysis', side_effect=analyze), patch('backend.app.workflow.render_openai_prompt') as render:
            _concept_work(key, request)
        run = get_run(key)
        self.assertEqual(run['status'], 'complete')
        self.assertEqual(run['result'], CONCEPT)
        self.assertEqual([event['stage'] for event in run['events']], ['source', 'summary', 'concept', 'check'])
        self.assertTrue(all(step['status'] == 'complete' for step in run['steps']))
        render.assert_not_called()

    def test_failure_marks_the_actual_stage_and_preserves_error(self):
        request = TeaserRequest(paper='Research paper')
        key = self.queued(request)
        with patch('backend.app.teaser.OpenAI'), patch('backend.app.teaser.structured_analysis', side_effect=HTTPException(502, 'Analysis provider unavailable')):
            _concept_work(key, request)
        run = get_run(key)
        self.assertEqual(run['status'], 'failed')
        self.assertEqual(run['message'], 'Analysis provider unavailable')
        self.assertEqual(next(step['status'] for step in run['steps'] if step['id'] == 'concept'), 'failed')
        self.assertIsNone(run['result'])

    def test_all_locked_fields_skip_model_work(self):
        request = TeaserRequest(paper='Paper', previous_concept=CONCEPT, parameter_locks=['scientificConcept.' + key for key in CONCEPT])
        key = self.queued(request)
        with patch('backend.app.teaser.structured_analysis') as analyze:
            _concept_work(key, request)
        analyze.assert_not_called()
        run = get_run(key)
        self.assertEqual(run['result'], CONCEPT)
        self.assertEqual([step['status'] for step in run['steps']], ['complete', 'skipped', 'skipped', 'complete'])

    def test_missing_paper_is_rejected_before_queueing(self):
        with self.assertRaises(HTTPException): self.queued(TeaserRequest())
        self.assertFalse(_runs)
