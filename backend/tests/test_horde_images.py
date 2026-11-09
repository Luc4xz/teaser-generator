import base64
import os
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from backend.app.horde_images import start_horde, horde_status, illustration_prompt, _jobs
from backend.app.teaser import TeaserRequest, generate_teaser

PLAN = {'groundingPlan':None, 'sourceNotes':['Leaves exchange gases through their stomata.'], 'drawingBrief':'Old planning essay', 'generationMode':'user-directed'}

class HordeTests(unittest.TestCase):
    def setUp(self):
        _jobs.clear()
        self.env = patch.dict(os.environ, {'TEASER_PROVIDER':'aihorde','AI_HORDE_MODEL':'stable_diffusion','AI_HORDE_API_KEY':''})
        self.env.start(); self.addCleanup(self.env.stop)

    def start(self):
        with patch('backend.app.horde_images.plan_pollinations', return_value=PLAN), patch('backend.app.horde_images._request',return_value={'id':'remote'}) as api:
            job = generate_teaser(TeaserRequest(user_prompt='A leaf with pores', visual={'density':'none'}))
            payload = api.call_args.kwargs['json']
            self.assertEqual(payload['models'], ['stable_diffusion'])
            self.assertEqual(payload['params']['n'], 1)
            self.assertIn('###',payload['prompt'])
            self.assertTrue(payload['shared'])
            return job

    def test_subject_first_prompt_omits_editor_essay_and_excludes_portraits(self):
        positive, negative = illustration_prompt(TeaserRequest(user_prompt='A leaf with pores'), PLAN)
        self.assertTrue(positive.startswith('A leaf with pores'))
        self.assertNotIn('Old planning essay', positive)
        self.assertIn('portrait', negative)

    def test_queue_then_image_then_cached_result(self):
        job = self.start()
        with patch('backend.app.horde_images._request',return_value={'done':False,'processing':0,'queue_position':7,'wait_time':60}):
            result = horde_status(job['jobId'])
            self.assertEqual(result['queuePosition'],7)
            self.assertNotIn('image',result)
        encoded=base64.b64encode(b'\xff\xd8\xff'+b'x'*1200).decode()
        with patch('backend.app.horde_images._request',side_effect=[{'done':True},{'generations':[{'model':'stable_diffusion','img':encoded,'censored':False}]}]):
            result = horde_status(job['jobId'])
            self.assertEqual(result['source'],'aihorde')
            self.assertTrue(result['image'].startswith('data:image/jpeg'))
            self.assertIn('negativePrompt',result)
        with patch('backend.app.horde_images._request') as api:
            self.assertEqual(horde_status(job['jobId']),result)
            api.assert_not_called()

    def test_censored_output_is_not_presented_as_success(self):
        job=self.start()
        with patch('backend.app.horde_images._request',side_effect=[{'done':True},{'generations':[{'censored':True}]}]):
            with self.assertRaises(HTTPException) as error:horde_status(job['jobId'])
            self.assertEqual(error.exception.status_code,422)

    def test_no_worker_cancels_job(self):
        with patch('backend.app.horde_images.plan_pollinations',return_value=PLAN), patch('backend.app.horde_images._request',side_effect=[{'id':'remote','warnings':[{'code':'NoAvailableWorker'}]},{}]) as api:
            with self.assertRaises(HTTPException):start_horde(TeaserRequest(user_prompt='Leaf'))
            self.assertEqual(api.call_args.args,('DELETE','/generate/status/remote'))

    def test_arbitrary_image_urls_are_not_fetched(self):
        job=self.start()
        with patch('backend.app.horde_images._request',side_effect=[{'done':True},{'generations':[{'model':'stable_diffusion','img':'http://127.0.0.1/private'}]}]), patch('backend.app.horde_images.httpx.get') as fetch:
            with self.assertRaises(HTTPException):horde_status(job['jobId'])
            fetch.assert_not_called()
