import base64
import os
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from backend.app.free_images import public_request, selected_evidence, _plans, plan_pollinations
from backend.app.teaser import TeaserRequest, generate_teaser
from backend.app.grounding import validate_plan, drawing_prompt


def sample():
    return TeaserRequest(paper='Leaves open stomata to exchange gases. Water loss rises when stomata open. This is a proposed mechanism, not a measured result.',
                         factors=dict(insight='Water loss rises when stomata open.', mechanism='Leaves open stomata to exchange gases.', audience='Researchers', keepFixed='Proposed mechanism only.'),
                         visual=dict(headline='Leaf gas exchange', analogy='A mixing console', rationale='Separate controls'))


def valid_plan():
    return {'status':'ready','issues':[],'subject':'Leaves and stomata',
            'facts':[{'id':'m','kind':'mechanism','claim':'Leaves open stomata to exchange gases.','quote':'Leaves open stomata to exchange gases.'},
                     {'id':'f','kind':'finding','claim':'Water loss rises when stomata open.','quote':'Water loss rises when stomata open.'}],
            'elements':[{'entity':'Leaves','depiction':'A magnified leaf surface with open pores.','fact_ids':['m']},
                        {'entity':'stomata','depiction':'Open pores with water vapor flowing outward.','fact_ids':['f']}],
            'composition':'Magnified leaf on left, vapor moving out to right.',
            'analogy_use':'Console omitted; use the literal leaf and stomata.'}


def text_response(plan=None):
    return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(plan or valid_plan())}}]})


class FreeProviderTests(unittest.TestCase):
    def setUp(self):
        _plans.clear()
        self.provider = patch.dict(os.environ, {"TEASER_PROVIDER":"pollinations"})
        self.provider.start()
        self.addCleanup(self.provider.stop)

    def test_complete_free_generation_never_calls_openai(self):
        image = b'\xff\xd8\xff' + b'0' * 1200
        responses = [text_response(),
                     httpx.Response(200, content=image)]
        with patch.dict(os.environ, {'TEASER_PROVIDER':'pollinations'}), patch('backend.app.teaser.OpenAI') as paid, patch('backend.app.free_images.httpx.request', side_effect=responses) as network:
            result = generate_teaser(sample())
            paid.assert_not_called()
            self.assertEqual(result['source'], 'pollinations')
            self.assertEqual(base64.b64decode(result['image'].split(',')[1]), image)
            self.assertEqual(network.call_count, 2)
            self.assertNotIn('Authorization', str(network.call_args_list))

    def test_free_limit_honors_cooldown_then_succeeds(self):
        with patch('backend.app.free_images.httpx.request', side_effect=[httpx.Response(402,json={'error':{'code':'FREE_LIMIT','message':'Retry after 13s'}}),httpx.Response(200,text='ok')]), patch('backend.app.free_images.time.sleep') as sleep:
            self.assertEqual(public_request('GET','https://image.pollinations.ai/prompt/test').text,'ok')
            sleep.assert_called_once_with(14)

    def test_repeated_cooldown_is_bounded(self):
        with patch('backend.app.free_images.httpx.request', return_value=httpx.Response(429,json={})), patch('backend.app.free_images.time.sleep') as sleep:
            with self.assertRaises(HTTPException) as error:
                public_request('GET','https://image.pollinations.ai/prompt/test')
            self.assertEqual(error.exception.status_code,429)
            self.assertEqual(sleep.call_count,2)

    def test_auth_failure_does_not_trigger_paid_fallback(self):
        with patch.dict(os.environ, {'TEASER_PROVIDER':'pollinations'}), patch('backend.app.teaser.OpenAI') as paid, patch('backend.app.free_images.httpx.request', return_value=httpx.Response(401,json={})), patch('backend.app.free_images.time.sleep') as sleep:
            with self.assertRaises(HTTPException):generate_teaser(sample())
            paid.assert_not_called();sleep.assert_not_called()

    def test_html_is_not_saved_as_an_image(self):
        responses=[text_response(),httpx.Response(200,text='<html>Error</html>')]
        with patch.dict(os.environ, {'TEASER_PROVIDER':'pollinations'}), patch('backend.app.free_images.httpx.request', side_effect=responses):
            with self.assertRaises(HTTPException) as error:generate_teaser(sample())
            self.assertIn('no valid image',error.exception.detail)

    def test_selection_scans_beyond_the_start_of_a_long_paper(self):
        paper=('Unrelated background. ' * 3000)+'\n\nConclusion: Our control mechanism has limitations.'
        evidence, selected=selected_evidence(paper, {'mechanism':'control mechanism'})
        self.assertTrue(selected)
        self.assertIn('Our control mechanism has limitations.',evidence)
        self.assertLessEqual(len(evidence),14100)

    def test_conflicting_brief_uses_user_directed_plan(self):
        plan=valid_plan();plan.update(status='needs_revision',issues=['The paper concerns leaves, not mixing consoles.'])
        with patch('backend.app.free_images.httpx.request',return_value=text_response(plan)) as network:
            result=plan_pollinations(sample())
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertIsNone(result['groundingPlan'])
            self.assertEqual(network.call_count,1)

    def test_invented_quote_uses_user_directed_plan(self):
        plan=valid_plan();plan['facts'][0]['quote']='Researchers adjusted three mixing-console knobs.'
        with patch('backend.app.free_images.httpx.request',return_value=text_response(plan)) as network:
            result=plan_pollinations(sample())
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertEqual(network.call_count,1)

    def test_unrelated_entity_uses_user_directed_plan(self):
        plan=valid_plan();plan['elements'][0]['entity']='Scientist in laboratory'
        with patch('backend.app.free_images.httpx.request',return_value=text_response(plan)) as network:
            result=plan_pollinations(sample())
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertEqual(network.call_count,1)

    def test_review_reuses_exact_plan_and_changed_inputs_still_generate(self):
        with patch('backend.app.free_images.httpx.request',return_value=text_response()) as network:
            result=plan_pollinations(sample())
            self.assertEqual(network.call_count,1)
        req=sample();req.reviewed_plan_hash=result['planHash']
        with patch('backend.app.free_images.httpx.request',return_value=httpx.Response(200,content=b'\xff\xd8\xff'+b'0'*1200)) as network:
            drawn=generate_teaser(req)
            self.assertEqual(network.call_count,1)
            self.assertEqual(drawn['drawingBrief'],result['drawingBrief'])
            req.paper += ' Changed source.'
            with patch('backend.app.free_images.plan_pollinations',return_value={**result,'drawingBrief':'Updated prompt'}) as planner:
                changed=generate_teaser(req)
                planner.assert_called_once()
                self.assertEqual(changed['drawingBrief'],'Updated prompt')
            self.assertEqual(network.call_count,2)

    def test_source_coverage_survives_unrelated_brief_terms(self):
        paper='Abstract: leaves open stomata to exchange gases.\n\n'+('Console background. '*2000)+'\n\nLimitations: these results do not establish causation.'
        evidence,_=selected_evidence(paper,{'insight':'console background'})
        self.assertIn('Abstract: leaves open stomata',evidence)
        self.assertIn('do not establish causation',evidence)

    def test_limitation_is_preserved_without_an_invented_visual_object(self):
        plan=valid_plan()
        plan['facts'].append({'id':'limit','kind':'limitation','claim':'Proposed mechanism only.',
                              'quote':'This is a proposed mechanism, not a measured result.'})
        validated=validate_plan(json.dumps(plan),sample().paper)
        prompt=drawing_prompt(validated,'sage','stacked','balanced')
        self.assertIn('Preserve the limitation: Proposed mechanism only.',prompt)

    def test_singular_entity_matches_plural_source_without_allowing_other_subjects(self):
        plan=valid_plan();plan['elements'][0]['entity']='leaf'
        validate_plan(json.dumps(plan),sample().paper)
        plan['elements'][0]['entity']='laboratory'
        with self.assertRaises(HTTPException):validate_plan(json.dumps(plan),sample().paper)

    def test_numeric_provider_reference_ids_are_normalized(self):
        plan=valid_plan()
        plan['facts'][0]['id']=1;plan['facts'][1]['id']=2
        plan['elements'][0]['fact_ids']=[1];plan['elements'][1]['fact_ids']=[2]
        validated=validate_plan(json.dumps(plan),sample().paper)
        self.assertEqual(validated.facts[0].id,'1')
        self.assertEqual(validated.elements[1].fact_ids,['2'])

    def test_unverified_quote_still_generates_from_user_prompt(self):
        invalid=valid_plan();invalid['facts'][0]['quote']='This quotation does not exist in the source.'
        responses=[text_response(invalid),httpx.Response(200,content=b'\xff\xd8\xff'+b'0'*1200)]
        with patch('backend.app.free_images.httpx.request',side_effect=responses) as network:
            result=generate_teaser(sample())
            self.assertTrue(result['image'].startswith('data:image/jpeg'))
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertIn('A mixing console',result['drawingBrief'])
            self.assertIsNone(result['groundingPlan'])
            self.assertEqual(network.call_count,2)

    def test_prompt_only_needs_no_text_service_or_paper(self):
        req=TeaserRequest(user_prompt='A purple dragon reading a book')
        with patch('backend.app.free_images.httpx.request',return_value=httpx.Response(200,content=b'\xff\xd8\xff'+b'0'*1200)) as network:
            result=generate_teaser(req)
            self.assertEqual(network.call_count,1)
            self.assertEqual(network.call_args.args[0],'GET')
            self.assertIn(req.user_prompt,result['drawingBrief'])
            self.assertEqual(result['generationMode'],'user-directed')

    def test_text_service_failure_still_attempts_image_generation(self):
        responses=[httpx.Response(503,json={}),httpx.Response(200,content=b'\xff\xd8\xff'+b'0'*1200)]
        with patch('backend.app.free_images.httpx.request',side_effect=responses):
            self.assertIn('image',generate_teaser(sample()))

    def test_composition_and_no_text_preferences_reach_grounded_prompt(self):
        plan = validate_plan(json.dumps(valid_plan()), sample().paper)
        prompt = drawing_prompt(plan, 'neutral', 'split', 'none')
        self.assertIn('side-by-side visual comparison', prompt)
        self.assertIn('No text, headings, or labels.', prompt)

    def test_fallback_respects_rationale_and_no_text_without_adding_headline(self):
        req = TeaserRequest(user_prompt='A leaf', visual=dict(rationale='Show the exchange process', headline='Hidden heading', density='none'))
        result = plan_pollinations(req)
        self.assertIn('Show the exchange process', result['drawingBrief'])
        self.assertIn('No text, headings, or labels.', result['drawingBrief'])
        self.assertNotIn('Requested headline:', result['drawingBrief'])

    def test_fallback_excludes_front_matter_and_references_from_drawing(self):
        paper = ('A Study of Leaves\nAlice Example and Bob Sample\nExample University\nalice@example.edu\n'
                 'Abstract\nLeaves open stomata to exchange gases. Water loss rises when stomata open. '
                 'Our model shows the tradeoff between gas exchange and water conservation.\n'
                 'References\nSmith University. A different paper. 2020.')
        req = TeaserRequest(paper=paper, user_prompt='Show the leaf gas exchange tradeoff.', visual=dict(representation='abstract', purpose='evoke'))
        with patch('backend.app.free_images.httpx.request', return_value=httpx.Response(503, json={})):
            result = plan_pollinations(req)
        prompt = result['drawingBrief']
        for metadata in ('Alice Example', 'Example University', 'alice@example.edu', 'Smith University'):
            self.assertNotIn(metadata, prompt)
            self.assertNotIn(metadata, result['evidenceExcerpt'])
        self.assertIn('stomata', prompt)
        self.assertIn('abstract symbolic forms', prompt)
        self.assertIn('invites reflection', prompt)
        self.assertLessEqual(len(result['sourceNotes']), 3)
        self.assertIsNone(result['groundingPlan'])

    def test_grounded_prompt_uses_realistic_direction_and_only_cited_evidence(self):
        req = sample()
        req.visual.representation = 'realistic'
        req.visual.purpose = 'balance'
        with patch('backend.app.free_images.httpx.request', return_value=text_response()):
            result = plan_pollinations(req)
        self.assertIn('lifelike subjects', result['drawingBrief'])
        self.assertIn('visual hook', result['drawingBrief'])
        self.assertEqual(result['evidenceExcerpt'], '\n\n'.join(f['quote'] for f in valid_plan()['facts']))

    def test_empty_input_is_the_only_content_prerequisite(self):
        with patch('backend.app.free_images.httpx.request') as network:
            with self.assertRaises(HTTPException):generate_teaser(TeaserRequest())
            network.assert_not_called()


if __name__ == '__main__':unittest.main()
