import unittest
from unittest.mock import patch
from fastapi import HTTPException
from backend.app.teaser import TeaserRequest, extract_concept, plan_openai, lock_instructions
from backend.app.scientific_concept import ScientificConcept, VisualPlan
from test_scientific_concept import CONCEPT, PLAN

class ParameterLockTests(unittest.TestCase):
    def test_regeneration_overrides_model_changes_only_for_locked_fields(self):
        request=TeaserRequest(user_prompt='Revise',previous_concept=CONCEPT,parameter_locks=['scientificConcept.finding'])
        revised={**CONCEPT,'finding':'Model changed a locked value','mechanism':'New mechanism'}
        with patch('backend.app.teaser.openai_key',return_value='test'),patch('backend.app.teaser.OpenAI'),patch('backend.app.teaser.structured_analysis',return_value=ScientificConcept.model_validate(revised)) as analyze:
            result=extract_concept(request)
        self.assertEqual(result['finding'],CONCEPT['finding']);self.assertEqual(result['mechanism'],'New mechanism')
        self.assertEqual(analyze.call_args.args[2]['locked_fields'],{'finding':CONCEPT['finding']})

    def test_all_locked_fields_skip_model_call(self):
        req=TeaserRequest(user_prompt='Revise',previous_concept=CONCEPT,parameter_locks=['scientificConcept.'+key for key in CONCEPT])
        with patch('backend.app.teaser.structured_analysis') as analyze:
            self.assertEqual(extract_concept(req),CONCEPT)
        analyze.assert_not_called()

    def test_empty_locked_field_is_rejected_before_call(self):
        with patch('backend.app.teaser.structured_analysis') as analyze:
            with self.assertRaises(HTTPException) as error:
                extract_concept(TeaserRequest(user_prompt='Revise',parameter_locks=['scientificConcept.finding']))
        self.assertEqual(error.exception.status_code,422);analyze.assert_not_called()

    def test_locked_visual_setting_reaches_plan_and_exact_render_prompt(self):
        req=TeaserRequest(user_prompt='Leaf',scientific_concept=CONCEPT,visual={'layout':'split'},parameter_locks=['visual.layout'],feedback='Use a central scene')
        with patch('backend.app.teaser.structured_analysis',return_value=VisualPlan.model_validate(PLAN)) as analyze:
            result=plan_openai(req)
        self.assertEqual(analyze.call_args.args[2]['locked_parameters'],{'visual.layout':'split'})
        self.assertIn(lock_instructions(req),result['drawingBrief'])
        self.assertEqual(len(result['promptSections']),6)
