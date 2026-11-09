import base64
import os
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from backend.app.teaser import render_openai_prompt


@patch.dict(os.environ, {'OPENAI_API_KEY': 'test-key', 'OPENAI_IMAGE_MODEL': 'gpt-image-1-mini'})
class OpenAIImageTests(unittest.TestCase):
    def response(self, content):
        response = MagicMock()
        response.json.return_value = {'data': [{'b64_json': base64.b64encode(content).decode()}]}
        return response

    def test_exact_prompt_and_valid_image_are_preserved(self):
        progress = MagicMock()
        with patch('backend.app.teaser.httpx.post', return_value=self.response(b'\xff\xd8\xff' + b'x' * 1200)) as post:
            result = render_openai_prompt('Draw a leaf', {'generationMode': 'user-directed'}, progress)
        self.assertEqual(post.call_args.kwargs['json']['prompt'], 'Draw a leaf')
        self.assertEqual(result['source'], 'openai-image')
        self.assertEqual(result['drawingBrief'], 'Draw a leaf')
        self.assertEqual(result['generationMode'], 'user-directed')
        self.assertEqual(progress.call_args.args[0], 'check')

    def test_encoded_error_page_is_rejected(self):
        with patch('backend.app.teaser.httpx.post', return_value=self.response(b'<html>' + b'x' * 1200)):
            with self.assertRaises(HTTPException):
                render_openai_prompt('Draw a leaf', {})

    def test_invalid_payload_is_rejected(self):
        response = MagicMock()
        response.json.return_value = {'data': [{'b64_json': 'not base64!'}]}
        with patch('backend.app.teaser.httpx.post', return_value=response):
            with self.assertRaises(HTTPException):
                render_openai_prompt('Draw a leaf', {})
