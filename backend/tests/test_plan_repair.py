import json
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from backend.app.free_images import plan_pollinations, _plans
from backend.app.grounding import validate_plan, PlanFormatError
from backend.tests.test_free_images import sample, valid_plan, text_response


def raw_response(raw, finish='stop'):
    return httpx.Response(200, json={'choices':[{'message':{'content':raw},'finish_reason':finish}]})


class PlanRepairTests(unittest.TestCase):
    def setUp(self):
        _plans.clear()

    def test_field_paths_are_precise_without_echoing_rejected_values(self):
        invalid=valid_plan();invalid['elements'][0]['depiction']='x'*401
        with self.assertRaises(PlanFormatError) as caught:
            validate_plan(json.dumps(invalid),sample().paper)
        self.assertIn('elements[0].depiction',caught.exception.detail)
        self.assertIn('400',caught.exception.detail)
        self.assertNotIn('x'*100,caught.exception.detail)

    def test_missing_field_repaired_with_source_and_actual_error(self):
        invalid=valid_plan();del invalid['composition']
        with patch('backend.app.free_images.public_request',side_effect=[text_response(invalid),text_response()]) as network:
            result=plan_pollinations(sample())
            self.assertTrue(result['formatRepairApplied'])
            self.assertIn('composition',result['repairedFormatProblems'][0])
            self.assertEqual(network.call_count,2)
            messages=network.call_args.kwargs['json']['messages']
            self.assertIn(sample().paper,messages[1]['content'])
            self.assertIn('Field required',messages[-1]['content'])
            self.assertIn('invalid_plan',messages[-1]['content'])
            self.assertEqual(plan_pollinations(sample()),result)
            self.assertEqual(network.call_count,2)

    def test_malformed_json_repaired_once(self):
        with patch('backend.app.free_images.public_request',side_effect=[raw_response('{broken'),text_response()]) as network:
            result=plan_pollinations(sample())
            self.assertTrue(result['formatRepairApplied'])
            self.assertIn('line 1, column',result['repairedFormatProblems'][0])
            self.assertEqual(network.call_count,2)

    def test_empty_or_truncated_responses_are_repairable(self):
        for first in [raw_response(None),httpx.Response(200,json={}),raw_response('{',finish='length')]:
            _plans.clear()
            with patch('backend.app.free_images.public_request',side_effect=[first,text_response()]) as network:
                self.assertTrue(plan_pollinations(sample())['formatRepairApplied'])
                self.assertEqual(network.call_count,2)

    def test_failed_repair_is_bounded_and_uses_direct_prompt(self):
        invalid=valid_plan();invalid['elements'][0]['fact_ids']='wrong type'
        with patch('backend.app.free_images.public_request',side_effect=[raw_response('bad JSON'),text_response(invalid)]) as network:
            result=plan_pollinations(sample())
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertIsNone(result['groundingPlan'])
            self.assertEqual(network.call_count,2)

    def test_repaired_plan_with_invalid_evidence_uses_direct_prompt(self):
        invalid=valid_plan();invalid['facts'][0]['quote']='Invented claim that is absent from this paper.'
        with patch('backend.app.free_images.public_request',side_effect=[raw_response('invalid'),text_response(invalid)]) as network:
            result=plan_pollinations(sample())
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertIsNone(result['groundingPlan'])
            self.assertEqual(network.call_count,2)

    def test_scientific_conflict_not_repaired_even_with_missing_fields(self):
        response=raw_response(json.dumps({'status':'needs_revision','issues':['The insight contradicts the paper.']}))
        with patch('backend.app.free_images.public_request',return_value=response) as network:
            result=plan_pollinations(sample())
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertEqual(network.call_count,1)

    def test_repair_network_error_uses_direct_prompt(self):
        invalid=valid_plan();del invalid['subject']
        with patch('backend.app.free_images.public_request',side_effect=[text_response(invalid),HTTPException(429,'Wait 45 seconds.')]):
            result=plan_pollinations(sample())
            self.assertEqual(result['generationMode'],'user-directed')
            self.assertIn('directly from your input', ' '.join(result['generationNotes']))

    def test_provider_refusal_is_not_repaired(self):
        with patch('backend.app.free_images.public_request',return_value=raw_response('',finish='content_filter')) as network:
            with self.assertRaises(HTTPException) as caught:plan_pollinations(sample())
            self.assertEqual(caught.exception.status_code,422)
            self.assertEqual(network.call_count,1)


if __name__ == '__main__':unittest.main()
