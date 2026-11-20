import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from openai import AzureOpenAI

from backend.app import cover_library as library, cover_quality as quality, model_providers as providers, teaser, workflow
from backend.app.scientific_concept import ScientificConcept


class CoverTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {'OPENAI_API_KEY': 'test', 'TEASER_MODELS_JSON': '',
            'TEASER_COVER_LIBRARY': '', 'TEASER_COVER_POLICY': '', 'TEASER_COVER_EVALUATOR_MODEL': ''})
        environment.start()
        self.addCleanup(environment.stop)
        self.request = teaser.TeaserRequest(output_kind='cover', user_prompt='A forming star with an accretion disk')
        self.policy = quality.load_policy()
        self.references = library.select_references(self.request)
        self.plan = {'outputKind': 'cover', 'coverReferenceIds': [item['id'] for item in self.references]}
        self.image = 'data:image/png;base64,' + base64.b64encode(library.read_reference(self.references[0])).decode()

    def review(self, flag=None, score=9):
        return quality.CoverReview(candidate_description='One physical scene', visible_text=[], scores=[quality.Score(id=d.id, score=score, evidence='Visible coherent focal subject') for d in self.policy.dimensions],
            exclusions=[quality.Violation(id=e.id, detected=e.id == flag, evidence='Inspected candidate pixels') for e in self.policy.exclusions if e.enabled],
            summary='A coherent scene', revision_instructions='Replace icons with one continuous physical scene.')

    def test_library_has_real_images_attribution_and_style_selection(self):
        entries = library.load_library()
        self.assertEqual(len(entries), 4)
        self.assertEqual(len({item['style_family'] for item in entries}), 4)
        self.assertEqual(self.references[0]['id'], 'stellar-birth')
        request = self.request.model_copy(update={'cover_style': 'sculptural-metaphor'})
        self.assertEqual(library.select_references(request)[0]['id'], 'marble-fates')
        with self.assertRaises(HTTPException):
            library.select_references(request.model_copy(update={'cover_style': 'unknown'}))
        for item in entries:
            self.assertTrue(item['author'] or item['cover_designer'])
            self.assertGreater(len(library.read_reference(item)), 1000)
            self.assertTrue(item['paper_url'].startswith('https://doi.org/'))

    def test_missing_or_corrupt_library_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'TEASER_COVER_LIBRARY': directory}):
            with self.assertRaises(HTTPException): library.load_library()
            folder = Path(directory) / self.references[0]['id']
            folder.mkdir()
            (folder / 'metadata.json').write_text(json.dumps(self.references[0]))
            (folder / 'image.png').write_bytes(b'not an image')
            with self.assertRaises(HTTPException): library.load_library()

    def test_high_scores_cannot_override_hard_exclusion(self):
        review = quality.assess_review(self.review(flag='icon_collage'), self.policy)
        self.assertEqual(review['weightedScore'], 9)
        self.assertFalse(review['accepted'])
        self.assertIn('icon_collage', review['rejectionReasons'])

    def test_dimension_floor_and_incomplete_or_duplicate_reviews_reject(self):
        review = self.review()
        review.scores[0].score = 5
        self.assertFalse(quality.assess_review(review, self.policy)['accepted'])
        for changes in ({'scores': review.scores[:-1]}, {'exclusions': []}, {'scores': review.scores + [review.scores[0]]}):
            with self.assertRaises(HTTPException): quality.assess_review(review.model_copy(update=changes), self.policy)

    def test_visible_text_is_reported_without_blocking_image(self):
        review = self.review()
        review.visible_text = ['NATURE']
        result = quality.assess_review(review, self.policy)
        self.assertTrue(result['accepted'])
        self.assertNotIn('rendered_text', result['rejectionReasons'])
        self.assertEqual(result['warnings'][0]['id'], 'rendered_text')
        self.assertIn('NATURE', result['warnings'][0]['evidence'])

    def test_text_warning_returns_first_candidate_without_paid_retry(self):
        from unittest.mock import Mock
        review = quality.assess_review(self.review(flag='rendered_text'), self.policy)
        render = Mock(return_value={'image': self.image})
        with patch.object(quality, 'evaluate_cover', return_value=review):
            result = quality.render_reviewed_cover(self.request, 'Draw', {}, render)
        self.assertEqual(render.call_count, 1)
        self.assertEqual(result['image'], self.image)
        self.assertEqual(result['coverReview']['warnings'][0]['id'], 'rendered_text')

    def test_policy_can_explicitly_restore_strict_text_rejection(self):
        policy = self.policy.model_copy(deep=True)
        next(item for item in policy.exclusions if item.id == 'rendered_text').hard_reject = True
        result = quality.assess_review(self.review(flag='rendered_text'), policy)
        self.assertFalse(result['accepted'])
        self.assertIn('rendered_text', result['rejectionReasons'])

    def test_policy_is_extensible_without_code_changes(self):
        policy = self.policy.model_copy(update={'exclusions': self.policy.exclusions + [quality.Exclusion(
            id='new_rule', enabled=True, hard_reject=True, description='A new visible condition', repair='Repair it.')]})
        review = self.review()
        review.exclusions.append(quality.Violation(id='new_rule', detected=True, evidence='Visible'))
        self.assertIn('new_rule', quality.assess_review(review, policy)['rejectionReasons'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'policy.json'
            data = self.policy.model_dump(); data['max_attempts'] = 100
            path.write_text(json.dumps(data))
            with patch.dict(os.environ, {'TEASER_COVER_POLICY': str(path)}), self.assertRaises(HTTPException): quality.load_policy()

    def test_evaluator_receives_generated_pixels_before_references(self):
        with patch.object(quality, 'complete_text', return_value=self.review().model_dump_json()) as complete:
            result = quality.evaluate_cover({'image':self.image}, self.plan, self.request, self.policy)
        self.assertTrue(result['accepted'])
        images = complete.call_args.kwargs['images']
        self.assertEqual(images[0], self.image)
        self.assertEqual(len(images), 3)
        with patch.object(quality, 'complete_text', return_value='{}'), self.assertRaises(HTTPException):
            quality.evaluate_cover({'image':self.image}, self.plan, self.request, self.policy)

    def test_repair_is_bounded_and_reports_both_reviews(self):
        rejected = quality.assess_review(self.review(flag='flowchart'), self.policy)
        accepted = quality.assess_review(self.review(), self.policy)
        artifacts = {}
        def render(prompt, plan, progress):
            return {**plan, 'drawingBrief': prompt, 'image': self.image}
        with patch.object(quality, 'evaluate_cover', side_effect=[rejected, accepted]), patch.object(quality, 'render_reviewed_cover', wraps=quality.render_reviewed_cover):
            result = quality.render_reviewed_cover(self.request, 'Draw', {}, render, report=artifacts.update)
        self.assertEqual(len(result['coverReviews']), 2)
        self.assertIn('REPAIR AFTER FAILED VISUAL REVIEW', result['drawingBrief'])
        self.assertEqual(len(result['coverReferences']), 2)
        self.assertTrue(artifacts['coverReviews'][-1]['accepted'])
        with patch.object(quality, 'evaluate_cover', return_value=rejected), patch('builtins.print'):
            from unittest.mock import Mock
            renderer = Mock(side_effect=render)
            result = quality.render_reviewed_cover(self.request, 'Draw', {}, renderer)
            self.assertFalse(result['coverReview']['accepted'])
            self.assertEqual(result['image'], self.image)
            self.assertEqual(renderer.call_count, 2)

    def test_evaluation_failure_never_accepts_or_retries_blindly(self):
        from unittest.mock import Mock
        render = Mock(return_value={'image':self.image})
        with patch.object(quality, 'evaluate_cover', side_effect=HTTPException(502, 'Vision unavailable')):
            with self.assertRaises(HTTPException): quality.render_reviewed_cover(self.request, 'Draw', {}, render)
        self.assertEqual(render.call_count, 1)

    def test_strict_policy_can_still_block_failed_quality(self):
        from unittest.mock import Mock
        policy = self.policy.model_copy(update={'on_rejection': 'fail'})
        rejected = quality.assess_review(self.review(flag='icon_collage', score=3), policy)
        render = Mock(return_value={'image': self.image})
        with patch.object(quality, 'load_policy', return_value=policy), patch.object(quality, 'evaluate_cover', return_value=rejected):
            with self.assertRaises(HTTPException):
                quality.render_reviewed_cover(self.request, 'Draw', {}, render)
        self.assertEqual(render.call_count, 2)

    def test_openai_sends_reference_files_to_edits_with_portrait_medium_quality(self):
        response = httpx.Response(200, json={'data':[{'b64_json': base64.b64encode(b'\xff\xd8\xff' + b'x' * 1200).decode()}]}, request=httpx.Request('POST', 'https://test'))
        with patch('backend.app.teaser.httpx.post', return_value=response) as post:
            teaser.render_openai_prompt('Original cover', self.plan)
        self.assertTrue(post.call_args.args[0].endswith('/images/edits'))
        self.assertEqual(len(post.call_args.kwargs['files']), 2)
        self.assertEqual(post.call_args.kwargs['data']['size'], '1024x1536')
        self.assertEqual(post.call_args.kwargs['data']['quality'], 'medium')

    def test_azure_real_sdk_transport_serializes_multiple_files(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'created':0,'data':[{'b64_json':self.image.split(',')[1]}]})
        entry = providers.ModelConfig(id='azure-image', label='Azure', provider='azure', kind='image', model='deployment', key_env='TEST_KEY')
        client = AzureOpenAI(api_key='test', azure_endpoint='https://example.openai.azure.com', api_version='2025-04-01-preview',
                             http_client=httpx.Client(transport=httpx.MockTransport(handler)))
        with patch.object(providers, 'resolve_model', return_value=entry), patch.object(providers, 'openai_client', return_value=client):
            providers.render_image('Original cover', self.plan, 'azure-image')
        self.assertIn('/deployments/deployment/images/edits', str(requests[0].url))
        self.assertEqual(requests[0].content.count(b'name="image[]"'), 2)

    def test_gemini_receives_reference_bytes_and_portrait_config(self):
        entry = providers.ModelConfig(id='gemini-image', label='Gemini', provider='gemini', kind='image', model='gemini-image', key_env='OPENAI_API_KEY')
        with patch.object(providers, 'resolve_model', return_value=entry), patch('google.genai.Client') as factory:
            generate = factory.return_value.__enter__.return_value.models.generate_content
            generate.return_value = NS(candidates=[NS(content=NS(parts=[NS(inline_data=NS(mime_type='image/jpeg',data=library.read_reference(self.references[0])))]))])
            providers.render_image('Original cover', self.plan, entry.id)
            self.assertEqual(len(generate.call_args.kwargs['contents']), 3)
            self.assertEqual(generate.call_args.kwargs['config']['image_config']['aspect_ratio'], '2:3')

    def test_vision_input_adapters_for_all_text_providers(self):
        messages = [{'role':'system','content':'Evaluate'}, {'role':'user','content':'Inspect pixels'}]
        for provider in ('openai', 'azure', 'anthropic', 'gemini'):
            entry = providers.ModelConfig(id=provider, label=provider, provider=provider, kind='text', model='vision', key_env='OPENAI_API_KEY')
            with self.subTest(provider=provider):
                if provider in ('openai', 'azure'):
                    with patch.object(providers, 'openai_client') as factory:
                        call = factory.return_value.__enter__.return_value.chat.completions.create
                        call.return_value = NS(choices=[NS(finish_reason='stop',message=NS(content='review',refusal=None))])
                        providers.complete_text(entry, messages, images=[self.image])
                        self.assertEqual(call.call_args.kwargs['messages'][-1]['content'][2]['image_url']['url'], self.image)
                elif provider == 'anthropic':
                    with patch('anthropic.Anthropic') as factory:
                        call = factory.return_value.__enter__.return_value.messages.create
                        call.return_value = NS(stop_reason='end_turn',content=[NS(type='text',text='review')])
                        providers.complete_text(entry, messages, images=[self.image])
                        self.assertEqual(call.call_args.kwargs['messages'][-1]['content'][2]['source']['type'], 'base64')
                else:
                    with patch('google.genai.Client') as factory:
                        call = factory.return_value.__enter__.return_value.models.generate_content
                        call.return_value = NS(candidates=[NS(finish_reason='STOP')],text='review')
                        providers.complete_text(entry, messages, images=[self.image])
                        self.assertEqual(len(call.call_args.kwargs['contents']), 3)
        self.assertIsInstance(messages[-1]['content'], str)

    def test_cover_workflow_reviews_render_restarts_and_keeps_audit(self):
        request = workflow.WorkflowRequest(output_kind='cover', restart_from='render', drawing_prompt='Saved art direction')
        with patch.object(workflow._pool, 'submit'):
            key = workflow.start_run(request)['id']
        accepted = quality.assess_review(self.review(), self.policy)
        with patch.object(workflow, 'render_image', side_effect=lambda prompt, plan, *args: {**plan,'image':self.image,'drawingBrief':prompt}), patch.object(quality, 'evaluate_cover', return_value=accepted):
            workflow._work(key, request)
        run = workflow.get_run(key)
        self.assertEqual(run['status'], 'complete')
        self.assertTrue(run['artifacts']['coverReviews'][0]['accepted'])
        self.assertEqual(run['steps'][-1]['id'], 'evaluate')
        workflow._runs.pop(key)

    def test_cover_planner_removes_labels_and_adds_direction(self):
        from backend.tests.test_scientific_concept import PLAN
        from backend.app.scientific_concept import VisualPlan
        request = self.request.model_copy(update={'scientific_concept':ScientificConcept(**{key:'Source detail' for key in ScientificConcept.model_fields})})
        with patch.object(teaser, 'structured_analysis', return_value=VisualPlan(**PLAN)) as analyze:
            result = teaser.plan_openai(request)
        self.assertEqual(result['visualMapping']['labels'], [])
        self.assertIn('COVER ART', analyze.call_args.args[1])
        self.assertIn('No text or labels.', result['drawingBrief'])

    def test_low_quality_workflow_returns_image_with_failed_review(self):
        request = workflow.WorkflowRequest(output_kind='cover', restart_from='render', drawing_prompt='Saved direction')
        with patch.object(workflow._pool, 'submit'):
            key = workflow.start_run(request)['id']
        rejected = quality.assess_review(self.review(flag='flowchart'), self.policy)
        with patch.object(workflow, 'render_image', return_value={'image':self.image}), patch.object(quality, 'evaluate_cover', return_value=rejected):
            workflow._work(key, request)
        run = workflow.get_run(key)
        self.assertEqual(run['status'], 'complete')
        self.assertEqual(run['result']['image'], self.image)
        self.assertFalse(run['result']['coverReview']['accepted'])
        self.assertIn('did not pass', run['message'])
        self.assertEqual(len(run['artifacts']['coverReviews']), 2)
        workflow._runs.pop(key)

    def test_synchronous_cover_endpoint_cannot_bypass_visual_review(self):
        rejected = quality.assess_review(self.review(flag='icon_collage'), self.policy)
        with patch.object(teaser, 'plan_openai', return_value={'drawingBrief':'Draw'}), patch.object(teaser, 'render_image', return_value={'image':self.image}) as render, patch.object(quality, 'evaluate_cover', return_value=rejected):
            result = teaser.generate_teaser(self.request)
            self.assertFalse(result['coverReview']['accepted'])
            self.assertEqual(result['image'], self.image)
        self.assertEqual(render.call_count, 2)


if __name__ == '__main__':
    unittest.main()
