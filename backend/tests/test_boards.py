import tempfile
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from fastapi import HTTPException
from app import boards


class BoardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = patch.object(boards, 'get_history_store', return_value=SimpleNamespace(db_path=self.temp.name+'/boards.db'))
        self.store.start()
        self.a = 'Bearer '+boards.issue_session({'user_id':'a','username':'yifang','display_name':'Yifang'}, 3600)
        self.b = 'Bearer '+boards.issue_session({'user_id':'b','username':'hanna','display_name':'Designer Hanna'}, 3600)
        self.board = boards.create_board(boards.BoardInput(name='Study'),self.a)['id']

    def tearDown(self):
        self.store.stop()
        self.temp.cleanup()

    def publish(self, id, auth):
        return boards.publish_snapshot(self.board,id,{'id':id,'image':'data:image/png;base64,AA==','creator':{'displayName':'Spoofed'},'inputSnapshot':{'scientificConcept':{'finding':'Original'}}},auth)

    def test_concurrent_contributions_survive_and_creator_is_authenticated(self):
        with ThreadPoolExecutor(2) as pool:
            list(pool.map(lambda args:self.publish(*args), [('first',self.a),('second',self.b)]))
        items=boards.read_board(self.board,self.a)['snapshots']
        self.assertEqual(len(items),2)
        self.assertEqual({x['creator']['displayName'] for x in items},{'Yifang','Designer Hanna'})
        self.publish('first',self.b)
        first=next(s for s in boards.read_board(self.board,self.b)['snapshots'] if s['id']=='first')
        self.assertEqual(first['creator']['userId'],'a')
        self.assertEqual(first['inputSnapshot']['scientificConcept']['finding'],'Original')

    def test_positions_persist_without_replacing_snapshot(self):
        self.publish('first',self.a)
        boards.move_snapshot(self.board,'first',boards.Position(x=130,y=260),self.b)
        item=boards.read_board(self.board,self.a)['snapshots'][0]
        self.assertEqual(item['position'],{'x':130,'y':260})
        self.assertEqual(item['creator']['userId'],'a')

    def test_auth_expiry_and_missing_board(self):
        with self.assertRaises(HTTPException) as caught:
            boards.read_board(self.board,'Bearer wrong')
        self.assertEqual(caught.exception.status_code,401)
        expired='Bearer '+boards.issue_session({'user_id':'a'},-1)
        with self.assertRaises(HTTPException): boards.read_board(self.board,expired)
        with self.assertRaises(HTTPException) as caught: boards.read_board('missing',self.a)
        self.assertEqual(caught.exception.status_code,404)

    def test_invalid_image_not_persisted(self):
        with self.assertRaises(HTTPException):
            boards.publish_snapshot(self.board,'bad',{'id':'bad','image':'https://example.com'},self.a)
        self.assertEqual(boards.read_board(self.board,self.a)['snapshots'],[])

    def test_review_has_one_bound_reviewer_and_preserves_approved_metadata(self):
        self.publish('original',self.a)
        request = boards.ReviewRequest(reviewer_id='b',caption='Comparison of the two groups.',alt_text='Two boxes connected by a line.')
        with self.assertRaises(HTTPException) as unjoined:
            boards.request_review(self.board,'original',request,self.a)
        self.assertEqual(unjoined.exception.status_code,422)
        member_ids = {member['id'] for member in boards.read_board(self.board,self.b)['members']}
        self.assertEqual(member_ids,{'a','b'})
        with self.assertRaises(HTTPException) as non_author:
            boards.request_review(self.board,'original',request,self.b)
        self.assertEqual(non_author.exception.status_code,403)
        review = boards.request_review(self.board,'original',request,self.a)
        self.assertEqual(review['reviewerName'],'Designer Hanna')
        self.assertEqual(review['status'],'pending')
        self.assertEqual(boards.request_review(self.board,'original',request,self.a),review)
        decision = boards.ReviewDecision(decision='approved',message='The labels match the paper.')
        with self.assertRaises(HTTPException) as non_reviewer:
            boards.decide_review(self.board,'original',decision,self.a)
        self.assertEqual(non_reviewer.exception.status_code,403)
        boards.comment_review(self.board,'original',boards.ReviewComment(message='Please check the label.'),self.a)
        approved = boards.decide_review(self.board,'original',decision,self.b)
        self.assertEqual(approved['caption'],request.caption)
        self.assertEqual(approved['altText'],request.alt_text)
        self.assertEqual(approved['status'],'approved')
        self.assertEqual(len(approved['comments']),2)
        self.assertEqual(boards.decide_review(self.board,'original',decision,self.b),approved)
        with self.assertRaises(HTTPException) as closed:
            boards.request_review(self.board,'original',request.model_copy(update={'caption':'Different caption'}),self.a)
        self.assertEqual(closed.exception.status_code,409)
        self.publish('edited',self.a)
        board = boards.read_board(self.board,self.a)
        self.assertEqual([review['snapshotId'] for review in board['reviews']],['original'])

    def test_review_can_request_changes_with_reviewer_comment(self):
        self.publish('version',self.a)
        boards.read_board(self.board,self.b)
        boards.request_review(self.board,'version',boards.ReviewRequest(
            reviewer_id='b',caption='Caption',alt_text='Description'
        ),self.a)
        result = boards.decide_review(self.board,'version',boards.ReviewDecision(
            decision='changes_requested',message='Replace the arrow with a plain connector.'
        ),self.b)
        self.assertEqual(result['status'],'changes_requested')
        self.assertEqual(result['comments'][0]['authorId'],'b')
