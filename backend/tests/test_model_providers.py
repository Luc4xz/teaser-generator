import base64
import json
import os
import tempfile
import unittest
from concurrent.futures import Future
from types import SimpleNamespace as NS
from unittest.mock import patch

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from backend.app import boards, teaser, workflow
from backend.app.model_providers import ModelConfig, model_catalog, resolve_model, complete_text, render_image
from backend.app.scientific_concept import ScientificConcept

CONCEPT = {key:'Source detail' for key in ScientificConcept.model_fields}
MESSAGES = [{'role':'system','content':'Analyze the source.'}, {'role':'user','content':'Research paper.'}]
IMAGE = b'\xff\xd8\xff' + b'x' * 1100

def entry(provider, kind='text', id=None):
    return ModelConfig(id=id or f'{provider}-{kind}', label=f'{provider} {kind}', provider=provider, kind=kind, model=f'{provider}-model', key_env=f'{provider.upper()}_TEST_KEY')


class ProviderTests(unittest.TestCase):
    def setUp(self):
        models = [entry(provider, kind) for provider in ('openai','azure','anthropic','gemini') for kind in ('text','image') if (provider,kind)!=('anthropic','image')]
        self.environment = patch.dict(os.environ, {'TEASER_MODELS_JSON':json.dumps([model.model_dump() for model in models]),
            'OPENAI_TEST_KEY':'openai-secret','AZURE_TEST_KEY':'azure-secret','ANTHROPIC_TEST_KEY':'anthropic-secret','GEMINI_TEST_KEY':'gemini-secret',
            'AZURE_OPENAI_ENDPOINT':'https://test.openai.azure.com'}, clear=True)
        self.environment.start(); self.addCleanup(self.environment.stop)

    def test_catalog_never_exposes_credentials_and_rejects_unknown_or_wrong_kind(self):
        catalog = model_catalog()
        self.assertEqual(len(catalog['models']['text']),4)
        self.assertEqual(len(catalog['models']['image']),3)
        self.assertNotIn('secret',json.dumps(catalog)); self.assertNotIn('key_env',json.dumps(catalog))
        for id,kind in [('invented','text'),('anthropic-text','image')]:
            with self.assertRaises(HTTPException) as caught: resolve_model(id,kind)
            self.assertEqual(caught.exception.status_code,422)
        with patch.dict(os.environ, {'GEMINI_TEST_KEY':''}):
            self.assertNotIn('gemini-text',json.dumps(model_catalog()))
            with self.assertRaises(HTTPException) as caught:resolve_model('gemini-text')
            self.assertEqual(caught.exception.status_code,503)

    def test_openai_and_azure_use_distinct_keys_and_sdks(self):
        for provider, sdk in [('openai','OpenAI'),('azure','AzureOpenAI')]:
            with self.subTest(provider=provider), patch(f'backend.app.model_providers.{sdk}') as factory:
                create = factory.return_value.__enter__.return_value.chat.completions.create
                create.return_value = NS(choices=[NS(finish_reason='stop',message=NS(content=json.dumps(CONCEPT),refusal=None))])
                result = teaser.structured_analysis(ScientificConcept,'Extract',{},f'{provider}-text')
                self.assertEqual(result.model_dump(),CONCEPT)
                self.assertEqual(factory.call_args.kwargs['api_key'],f'{provider}-secret')
                self.assertEqual(create.call_args.kwargs['model'],f'{provider}-model')
                self.assertEqual(create.call_args.kwargs['response_format']['type'],'json_schema')
                if provider == 'azure': self.assertEqual(factory.call_args.kwargs['azure_endpoint'],'https://test.openai.azure.com')

    def test_anthropic_uses_messages_tool_and_validates_output(self):
        with patch('anthropic.Anthropic') as factory:
            create = factory.return_value.__enter__.return_value.messages.create
            create.return_value = NS(stop_reason='tool_use',content=[NS(type='tool_use',name='submit_analysis',input=CONCEPT)])
            self.assertEqual(teaser.structured_analysis(ScientificConcept,'Extract',{},'anthropic-text').model_dump(),CONCEPT)
            self.assertEqual(factory.call_args.kwargs['api_key'],'anthropic-secret')
            self.assertEqual(create.call_args.kwargs['tool_choice']['name'],'submit_analysis')
            self.assertEqual(create.call_args.kwargs['messages'][0]['role'],'user')
            create.return_value.content[0].input = {'core_concept':'Incomplete'}
            with self.assertRaises(HTTPException):teaser.structured_analysis(ScientificConcept,'Extract',{},'anthropic-text')

    def test_gemini_uses_its_sdk_and_rejects_truncated_content(self):
        with patch('google.genai.Client') as factory:
            generate = factory.return_value.__enter__.return_value.models.generate_content
            generate.return_value = NS(candidates=[NS(finish_reason='STOP')],text=json.dumps(CONCEPT))
            self.assertEqual(teaser.structured_analysis(ScientificConcept,'Extract',{},'gemini-text').model_dump(),CONCEPT)
            self.assertEqual(factory.call_args.kwargs['api_key'],'gemini-secret')
            self.assertEqual(generate.call_args.kwargs['config']['response_schema'],ScientificConcept)
            generate.return_value.candidates[0].finish_reason = 'MAX_TOKENS'
            with self.assertRaises(HTTPException):complete_text(entry('gemini'),MESSAGES)

    def test_long_paper_and_visual_plan_use_selected_text_model(self):
        from backend.tests.test_scientific_concept import PLAN
        from backend.app.scientific_concept import VisualPlan
        request = teaser.TeaserRequest(paper='Research evidence. '*2000,text_model='anthropic-text')
        with patch('backend.app.teaser.complete_text',return_value='Condensed evidence') as summarize, patch('backend.app.teaser.structured_analysis',return_value=ScientificConcept(**CONCEPT)) as analyze:
            teaser.extract_concept(request)
            self.assertGreater(summarize.call_count,1)
            self.assertTrue(all(call.args[0].id=='anthropic-text' for call in summarize.call_args_list))
            self.assertEqual(analyze.call_args.args[3],'anthropic-text')
        with patch('backend.app.teaser.structured_analysis',return_value=VisualPlan(**PLAN)) as analyze:
            teaser.plan_openai(request.model_copy(update={'scientific_concept':ScientificConcept(**CONCEPT)}))
            self.assertEqual(analyze.call_args.args[3],'anthropic-text')

    def test_image_providers_use_their_own_credentials(self):
        with patch('backend.app.teaser.httpx.post',return_value=httpx.Response(200,json={'data':[{'b64_json':base64.b64encode(IMAGE).decode()}]},request=httpx.Request('POST','https://test'))) as post:
            result=render_image('Draw',{},'openai-image')
            self.assertEqual(post.call_args.kwargs['headers']['Authorization'],'Bearer openai-secret')
            self.assertEqual(post.call_args.kwargs['json']['model'],'openai-model')
            self.assertEqual(result['imageModel'],'openai-image')
        with patch('backend.app.model_providers.AzureOpenAI') as factory:
            factory.return_value.__enter__.return_value.images.generate.return_value=NS(data=[NS(b64_json=base64.b64encode(IMAGE).decode())])
            self.assertEqual(render_image('Draw',{},'azure-image')['imageModel'],'azure-image')
            self.assertEqual(factory.call_args.kwargs['api_key'],'azure-secret')
        with patch('google.genai.Client') as factory:
            generate=factory.return_value.__enter__.return_value.models.generate_content
            generate.return_value=NS(candidates=[NS(content=NS(parts=[NS(inline_data=NS(mime_type='image/jpeg',data=IMAGE))]))])
            self.assertEqual(render_image('Draw',{},'gemini-image')['imageModel'],'gemini-image')
            self.assertEqual(factory.call_args.kwargs['api_key'],'gemini-secret')
            generate.return_value=NS(candidates=[])
            with self.assertRaises(HTTPException):render_image('Draw',{},'gemini-image')

    def test_selected_image_workflow_and_render_retry_do_not_fall_back(self):
        request=workflow.WorkflowRequest(paper='Paper',text_model='anthropic-text',image_model='gemini-image')
        with patch('backend.app.workflow._pool.submit'):
            id=workflow.start_run(request)['id']
        with patch('backend.app.workflow.plan_openai',return_value={'drawingBrief':'Draw'}) as plan, patch('backend.app.workflow.render_image',return_value={'image':'data:image/jpeg;base64,AA=='}) as render, patch('backend.app.workflow.render_flux_prompt') as fallback:
            workflow._work(id,request)
            self.assertEqual(plan.call_args.args[0].text_model,'anthropic-text')
            self.assertEqual(render.call_args.args[2],'gemini-image');fallback.assert_not_called()
            self.assertEqual(workflow.get_run(id)['status'],'complete')
        request=request.model_copy(update={'restart_from':'render','drawing_prompt':'Saved'})
        with patch('backend.app.workflow._pool.submit'):
            id=workflow.start_run(request)['id']
        with patch('backend.app.workflow.plan_openai') as plan, patch('backend.app.workflow.render_image',return_value={'image':'data:image/jpeg;base64,AA=='}) as render:
            workflow._work(id,request)
            plan.assert_not_called();self.assertEqual(render.call_args.args[0],'Saved')


class AuthBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        store=patch.object(boards,'get_history_store',return_value=NS(db_path=temporary.name+'/auth.db'))
        store.start();self.addCleanup(store.stop)
        app=FastAPI();app.include_router(teaser.router);app.include_router(workflow.router)
        self.client=TestClient(app)

    def test_unauthenticated_and_expired_sessions_cannot_access_workspace_apis(self):
        expired=boards.issue_session({'user_id':'a'},-1)
        with patch('backend.app.workflow._pool.submit') as submit:
            for headers in [{},{'Authorization':'Bearer forged'},{'Authorization':'Bearer '+expired}]:
                for path in ['/api/teaser/concept','/api/teaser/concept-runs','/api/teaser/runs','/api/teaser/generate']:
                    self.assertEqual(self.client.post(path,json={'paper':'Paper'},headers=headers).status_code,401)
                self.assertEqual(self.client.get('/api/teaser/models',headers=headers).status_code,401)
                self.assertEqual(self.client.get('/api/teaser/runs/unknown',headers=headers).status_code,401)
            submit.assert_not_called()

    def test_valid_session_can_load_models_and_queue_concept(self):
        token=boards.issue_session({'user_id':'a'},3600)
        headers={'Authorization':'Bearer '+token}
        with patch.dict(os.environ,{'OPENAI_API_KEY':'test','TEASER_MODELS_JSON':''}),patch('backend.app.workflow._pool.submit'):
            self.assertEqual(self.client.get('/api/teaser/models',headers=headers).status_code,200)
            response=self.client.post('/api/teaser/concept-runs',json={'paper':'Paper','text_model':'openai-text'},headers=headers)
            self.assertEqual(response.status_code,202)
            self.assertEqual(self.client.get('/api/teaser/runs/'+response.json()['id'],headers=headers).status_code,200)

    def test_queued_concept_can_only_be_cancelled_by_its_owner(self):
        owner = {'Authorization': 'Bearer ' + boards.issue_session({'user_id': 'author'}, 3600)}
        other = {'Authorization': 'Bearer ' + boards.issue_session({'user_id': 'other'}, 3600)}
        future = Future()
        with patch.dict(os.environ,{'OPENAI_API_KEY':'test','TEASER_MODELS_JSON':''}), patch(
            'backend.app.workflow._pool.submit', return_value=future,
        ):
            response = self.client.post('/api/teaser/concept-runs', json={'paper':'Paper','text_model':'openai-text'}, headers=owner)
        self.assertEqual(response.status_code, 202)
        path = '/api/teaser/runs/' + response.json()['id'] + '/cancel'
        self.assertEqual(self.client.post(path).status_code, 401)
        self.assertEqual(self.client.post(path, headers=other).status_code, 404)
        self.assertFalse(future.cancelled())
        self.assertEqual(self.client.post(path, headers=owner).json()['status'], 'cancelled')
        self.assertTrue(future.cancelled())
        self.assertEqual(self.client.post(path, headers=owner).json()['status'], 'cancelled')
