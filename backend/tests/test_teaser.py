import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from backend.app.teaser import TeaserRequest, paper_chunks, summarize_paper, PAPER_CHUNK_CHARS, openai_error_detail


class LongPaperTests(unittest.TestCase):
    def test_chunks_preserve_every_character(self):
        for paper in ['word\n' * 30000, '研究' * 70000, 'x' * 140000]:
            chunks = paper_chunks(paper)
            self.assertEqual(''.join(chunks), paper)
            self.assertTrue(all(len(chunk) <= PAPER_CHUNK_CHARS for chunk in chunks))

    def test_long_paper_is_accepted_and_all_sections_analyzed(self):
        paper = 'a' * 130000 + 'FINAL SECTION: evidence limitations'
        request = TeaserRequest(paper=paper, factors=dict(insight='i', mechanism='m', audience='a', keepFixed='k'),
                               visual=dict(headline='h', analogy='a', rationale='r'))
        client = MagicMock()
        client.chat.completions.create.return_value = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Evidence notes.'))])
        notes = summarize_paper(client, request.paper, 'test')
        calls = client.chat.completions.create.call_args_list
        self.assertEqual(len(calls), len(paper_chunks(paper)))
        self.assertIn('FINAL SECTION', calls[-1].kwargs['messages'][1]['content'])
        self.assertIn('Evidence notes.', notes)

    def test_short_papers_do_not_need_summary_call(self):
        client = MagicMock()
        self.assertEqual(summarize_paper(client, 'Short paper', 'test'), 'Short paper')
        client.chat.completions.create.assert_not_called()

    def test_large_notes_are_reduced_again(self):
        client = MagicMock()
        client.chat.completions.create.return_value = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='n' * 5000))])
        notes = summarize_paper(client, 'x' * 130000, 'test')
        self.assertLessEqual(len(notes), PAPER_CHUNK_CHARS)
        self.assertGreater(client.chat.completions.create.call_count, 6)


class ErrorDetailTests(unittest.TestCase):
    def test_sdk_credit_error_is_not_a_temporary_rate_limit(self):
        exc = SimpleNamespace(status_code=429, body={'code':'credit_balance_exhausted', 'type':'insufficient_quota'})
        self.assertIn('credits are exhausted', openai_error_detail(exc))

    def test_http_image_error_uses_nested_code(self):
        response = MagicMock(status_code=429)
        response.json.return_value = {'error':{'code':'project_spend_limit_exceeded', 'type':'insufficient_quota'}}
        self.assertIn('project has reached its spending limit', openai_error_detail(SimpleNamespace(response=response)))

    def test_rate_limit_and_unknown_429_remain_distinct(self):
        self.assertIn('temporarily rate-limited', openai_error_detail(SimpleNamespace(status_code=429, body={'code':'rate_limit_exceeded'})))
        self.assertIn('did not identify', openai_error_detail(SimpleNamespace(status_code=429, body={})))


if __name__ == '__main__':
    unittest.main()
