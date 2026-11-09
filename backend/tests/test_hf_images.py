import unittest
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from backend.app.hf_images import generate_flux_demo, SPACE
from backend.app.teaser import TeaserRequest

class FluxDemoTests(unittest.TestCase):
    def client(self, events):
        client = MagicMock()
        client.post.return_value.json.return_value = {'event_id':'abc123'}
        client.post.return_value.status_code = 200
        client.stream.return_value.__enter__.return_value.iter_lines.return_value = events
        client.get.return_value.content = b'RIFF'+b'0000'+b'WEBP'+b'x'*1200
        return client

    def run_demo(self, client):
        with patch('backend.app.hf_images.plan_pollinations',return_value={'groundingPlan':None, 'sourceNotes':[], 'drawingBrief':'planning essay'}), patch('backend.app.hf_images.httpx.Client') as factory:
            factory.return_value.__enter__.return_value = client
            return generate_flux_demo(TeaserRequest(user_prompt='Three circles connect to a square',visual={'density':'none'}))

    def test_live_api_contract_and_exact_prompt_are_preserved(self):
        client=self.client(['event: heartbeat','data: null','event: complete', 'data: [{"url":"'+SPACE+'/gradio_api/file=/tmp/image.webp"},42]'])
        result=self.run_demo(client)
        sent=client.post.call_args.kwargs['json']['data']
        self.assertEqual(sent[0],result['drawingBrief'])
        self.assertTrue(sent[0].startswith('Three circles'))
        self.assertEqual(sent[3:],[768,512,4])
        self.assertEqual(result['model'],'FLUX.1-schnell')
        self.assertTrue(result['image'].startswith('data:image/webp'))
        self.assertEqual(result['seed'],42)

    def test_quota_error_is_not_a_fake_image(self):
        client=self.client(['event: error','data: null'])
        with self.assertRaises(HTTPException) as error:self.run_demo(client)
        self.assertEqual(error.exception.status_code,503)
        client.get.assert_not_called()

    def test_untrusted_download_url_is_rejected(self):
        client=self.client(['event: complete','data: [{"url":"http://127.0.0.1/private"}]'])
        with self.assertRaises(HTTPException):self.run_demo(client)
        client.get.assert_not_called()

    def test_html_response_is_not_saved_as_an_image(self):
        client=self.client(['event: complete','data: [{"url":"'+SPACE+'/gradio_api/file=/tmp/image.webp"}]'])
        client.get.return_value.content=b'<html>error</html>'
        with self.assertRaises(HTTPException):self.run_demo(client)
