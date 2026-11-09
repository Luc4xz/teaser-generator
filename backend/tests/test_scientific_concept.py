import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import HTTPException
from pydantic import ValidationError
from backend.app.scientific_concept import ScientificConcept, VisualPlan, prompt_sections
from backend.app.teaser import TeaserRequest, extract_concept, plan_openai, structured_analysis

CONCEPT = dict(core_concept='Leaf gas exchange', entities='Leaf and stomata', mechanism='Pores regulate exchange', finding='No experimental finding supplied', evidence='No paper supplied', limitations='Concept illustration, not experimental evidence')
PLAN = dict(mappings=[dict(concept_field='mechanism', depiction='Two pores with arrows for gas exchange', rationale='Arrows show exchange through pores')], composition='One central leaf', style='Simple line drawing', labels=['Leaf'], exclusions='No invented measurements')

@patch.dict(os.environ, {'OPENAI_API_KEY':'test-key'})
class ConceptTests(unittest.TestCase):
    def test_missing_or_blank_concept_section_is_rejected(self):
        for concept in [{k:v for k,v in CONCEPT.items() if k!='evidence'}, {**CONCEPT,'mechanism':'  '}]:
            with self.assertRaises(ValidationError):ScientificConcept.model_validate(concept)

    def test_mapping_must_reference_a_known_concept_field(self):
        with self.assertRaises(ValidationError):
            VisualPlan.model_validate({**PLAN,'mappings':[{**PLAN['mappings'][0],'concept_field':'invented_fact'}]})

    def test_reviewed_concept_is_preserved_and_compiled_in_six_sections(self):
        req=TeaserRequest(user_prompt='Show exchange', scientific_concept=CONCEPT, visual={'density':'none'})
        with patch('backend.app.teaser.structured_analysis',return_value=VisualPlan.model_validate(PLAN)) as analyze, patch('backend.app.teaser.extract_concept') as extract:
            result=plan_openai(req)
        extract.assert_not_called()
        self.assertEqual(analyze.call_args.args[2]['concept'],CONCEPT)
        self.assertEqual(result['scientificConcept'],CONCEPT)
        self.assertEqual(len(result['promptSections']),6)
        for section in result['promptSections']:
            self.assertIn(section['title']+'\n'+section['content'],result['drawingBrief'])
        self.assertEqual(result['visualMapping']['labels'],[])
        self.assertIn('No text or labels.',result['drawingBrief'])

    def test_concept_extraction_never_renders_an_image(self):
        with patch('backend.app.teaser.OpenAI'),patch('backend.app.teaser.structured_analysis',return_value=ScientificConcept.model_validate(CONCEPT)),patch('backend.app.teaser.render_openai_prompt') as render:
            self.assertEqual(extract_concept(TeaserRequest(user_prompt='Leaf gas exchange')),CONCEPT)
        render.assert_not_called()

    def test_empty_request_cannot_extract(self):
        with self.assertRaises(HTTPException) as error:extract_concept(TeaserRequest())
        self.assertEqual(error.exception.status_code,422)

    def test_structured_output_is_validated_before_use(self):
        choice=SimpleNamespace(finish_reason='stop',message=SimpleNamespace(content='{"core_concept":"Leaf"}',refusal=None))
        with patch('backend.app.teaser.OpenAI') as factory:
            factory.return_value.__enter__.return_value.chat.completions.create.return_value=SimpleNamespace(choices=[choice])
            with self.assertRaises(HTTPException) as error:structured_analysis(ScientificConcept,'Extract concept',{})
        self.assertEqual(error.exception.status_code,502)

    def test_truncation_does_not_produce_partial_plan(self):
        choice=SimpleNamespace(finish_reason='length',message=SimpleNamespace(content='{}',refusal=None))
        with patch('backend.app.teaser.OpenAI') as factory:
            factory.return_value.__enter__.return_value.chat.completions.create.return_value=SimpleNamespace(choices=[choice])
            with self.assertRaises(HTTPException):structured_analysis(VisualPlan,'Plan',{})
