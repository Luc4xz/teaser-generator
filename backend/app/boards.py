"""Durable, link-shared boards. Append-only snapshots; atomic position updates."""
import hashlib
import json
import secrets
import sqlite3
import time
from typing import Literal, Optional
from contextlib import contextmanager
from datetime import datetime, timezone
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from .history_store import get_history_store

router = APIRouter(prefix='/api/boards', tags=['boards'])


@contextmanager
def connect():
    db = sqlite3.connect(get_history_store().db_path, timeout=15)
    db.row_factory = sqlite3.Row
    db.executescript('''
    CREATE TABLE IF NOT EXISTS board_sessions (token TEXT PRIMARY KEY, profile TEXT NOT NULL, expires REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS board_snapshots (board TEXT, id TEXT, payload TEXT NOT NULL, position TEXT, PRIMARY KEY(board,id));
    CREATE TABLE IF NOT EXISTS board_members (
        board TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(board,user_id)
    );
    CREATE TABLE IF NOT EXISTS figure_reviews (
        board TEXT NOT NULL, snapshot TEXT NOT NULL, author TEXT NOT NULL, reviewer TEXT NOT NULL,
        caption TEXT NOT NULL, alt_text TEXT NOT NULL, status TEXT NOT NULL,
        requested_at TEXT NOT NULL, decided_at TEXT, PRIMARY KEY(board,snapshot)
    );
    CREATE TABLE IF NOT EXISTS figure_review_comments (
        id INTEGER PRIMARY KEY, board TEXT NOT NULL, snapshot TEXT NOT NULL, author TEXT NOT NULL,
        name TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS figure_review_comment_lookup ON figure_review_comments(board,snapshot,id);
    ''')
    try:
        with db:
            yield db
    finally:
        db.close()


def issue_session(profile, seconds):
    token = secrets.token_urlsafe(32)
    with connect() as db:
        db.execute('DELETE FROM board_sessions WHERE expires < ?', (time.time(),))
        db.execute('INSERT INTO board_sessions VALUES (?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), json.dumps(profile), time.time()+seconds))
    return token


def identity(authorization):
    token = (authorization or '').removeprefix('Bearer ')
    with connect() as db:
        row = db.execute('SELECT profile FROM board_sessions WHERE token=? AND expires>?', (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
    if not row:
        raise HTTPException(401, 'Sign in again to access the workspace.')
    return json.loads(row['profile'])


def require_session(authorization: Optional[str] = Header(default=None)):
    return identity(authorization)


def require_board(db, board):
    row = db.execute('SELECT * FROM boards WHERE id=?', (board,)).fetchone()
    if not row:
        raise HTTPException(404, 'Board not found. Check the shared board ID.')
    return row


class BoardInput(BaseModel):
    name: str = Field(default='Shared research board', max_length=200)


class Position(BaseModel):
    x: float = Field(allow_inf_nan=False, ge=-100000, le=100000)
    y: float = Field(allow_inf_nan=False, ge=-100000, le=100000)


class ReviewRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    reviewer_id: str = Field(min_length=1, max_length=100)
    caption: str = Field(min_length=1, max_length=2000)
    alt_text: str = Field(min_length=1, max_length=1200)


class ReviewComment(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    message: str = Field(min_length=1, max_length=2000)


class ReviewDecision(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    decision: Literal['approved', 'changes_requested']
    message: str = Field(default='', max_length=2000)


def display_name(user):
    return user.get('display_name') or user.get('username') or user['user_id']


def remember_member(db, board, user):
    user_id, name = user['user_id'], display_name(user)
    stored = db.execute('SELECT name FROM board_members WHERE board=? AND user_id=?', (board, user_id)).fetchone()
    if stored is None or stored['name'] != name:
        db.execute('''
            INSERT INTO board_members(board,user_id,name) VALUES (?,?,?)
            ON CONFLICT(board,user_id) DO UPDATE SET name=excluded.name
        ''', (board, user_id, name))


def list_reviews(db, board, snapshot_id=None):
    where = 'WHERE board=?'
    params = (board,)
    if snapshot_id is not None:
        where += ' AND snapshot=?'
        params += (snapshot_id,)
    members = {row['user_id']:row['name'] for row in db.execute(
        'SELECT user_id,name FROM board_members WHERE board=?', (board,)
    )}
    comments = {}
    for row in db.execute(f'SELECT * FROM figure_review_comments {where} ORDER BY id', params):
        comments.setdefault(row['snapshot'], []).append({
            'id':row['id'], 'authorId':row['author'], 'authorName':row['name'],
            'text':row['message'], 'createdAt':row['created_at'],
        })
    return [{
        'snapshotId':row['snapshot'], 'authorId':row['author'],
        'authorName':members.get(row['author'], 'Snapshot author'), 'reviewerId':row['reviewer'],
        'reviewerName':members.get(row['reviewer'], 'Reviewer'), 'status':row['status'],
        'caption':row['caption'], 'altText':row['alt_text'], 'requestedAt':row['requested_at'],
        'decidedAt':row['decided_at'], 'comments':comments.get(row['snapshot'], []),
    } for row in db.execute(f'SELECT * FROM figure_reviews {where} ORDER BY requested_at DESC', params)]


def require_review(db, board, snapshot_id):
    require_board(db, board)
    review = db.execute('SELECT * FROM figure_reviews WHERE board=? AND snapshot=?', (board, snapshot_id)).fetchone()
    if review is None:
        raise HTTPException(404, 'This version has no review request.')
    return review


def add_review_comment(db, board, snapshot_id, user, message):
    count = db.execute('SELECT COUNT(*) FROM figure_review_comments WHERE board=? AND snapshot=?', (board, snapshot_id)).fetchone()[0]
    if count >= 100:
        raise HTTPException(409, 'This version has reached its comment limit.')
    db.execute('''
        INSERT INTO figure_review_comments(board,snapshot,author,name,message,created_at)
        VALUES (?,?,?,?,?,?)
    ''', (board, snapshot_id, user['user_id'], display_name(user), message, datetime.now(timezone.utc).isoformat()))


@router.post('')
def create_board(body: BoardInput, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    board = secrets.token_urlsafe(24)
    with connect() as db:
        db.execute('INSERT INTO boards VALUES (?,?)', (board, body.name))
        remember_member(db, board, user)
    return {'id': board, 'name': body.name}


@router.get('/{board}')
def read_board(board: str, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    with connect() as db:
        record = require_board(db, board)
        remember_member(db, board, user)
        rows = db.execute('SELECT payload,position FROM board_snapshots WHERE board=? ORDER BY rowid', (board,)).fetchall()
        members = [{'id':row['user_id'], 'name':row['name']} for row in db.execute(
            'SELECT user_id,name FROM board_members WHERE board=? ORDER BY name COLLATE NOCASE,user_id', (board,)
        )]
        reviews = list_reviews(db, board)
    return {'id': board, 'name': record['name'], 'members':members, 'reviews':reviews,
            'snapshots': [{**json.loads(r['payload']), **({'position': json.loads(r['position'])} if r['position'] else {})} for r in rows]}


@router.put('/{board}/snapshots/{snapshot_id}')
def publish_snapshot(board: str, snapshot_id: str, body: dict, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    if body.get('id') != snapshot_id or len(snapshot_id) > 100:
        raise HTTPException(422, 'Invalid snapshot ID.')
    if not str(body.get('image', '')).startswith(('data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,')):
        raise HTTPException(422, 'Snapshot must contain a generated image.')
    payload = {**body, 'creator': {'userId': user['user_id'], 'displayName': display_name(user)}, 'publishedAt': datetime.now(timezone.utc).isoformat()}
    encoded = json.dumps(payload)
    if len(encoded) > 25_000_000:
        raise HTTPException(413, 'Snapshot is too large.')
    with connect() as db:
        require_board(db, board)
        db.execute('INSERT OR IGNORE INTO board_snapshots(board,id,payload) VALUES (?,?,?)', (board, snapshot_id, encoded))
    return {'ok': True}


@router.post('/{board}/snapshots/{snapshot_id}/review')
def request_review(board: str, snapshot_id: str, body: ReviewRequest, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        require_board(db, board)
        row = db.execute('SELECT payload FROM board_snapshots WHERE board=? AND id=?', (board, snapshot_id)).fetchone()
        if row is None:
            raise HTTPException(404, 'This version has not synced to the board.')
        if json.loads(row['payload']).get('creator', {}).get('userId') != user['user_id']:
            raise HTTPException(403, 'Only the snapshot author can request a review.')
        if body.reviewer_id == user['user_id']:
            raise HTTPException(422, 'Choose a coauthor to review this version.')
        if db.execute('SELECT 1 FROM board_members WHERE board=? AND user_id=?', (board, body.reviewer_id)).fetchone() is None:
            raise HTTPException(422, 'The reviewer must open this board first.')
        existing = list_reviews(db, board, snapshot_id)
        if existing:
            review = existing[0]
            if (review['reviewerId'], review['caption'], review['altText']) == (body.reviewer_id, body.caption, body.alt_text):
                return review
            raise HTTPException(409, 'This version already has a review. Save a new version to start another review.')
        db.execute('''
            INSERT INTO figure_reviews(board,snapshot,author,reviewer,caption,alt_text,status,requested_at)
            VALUES (?,?,?,?,?,?,?,?)
        ''', (board, snapshot_id, user['user_id'], body.reviewer_id, body.caption, body.alt_text,
              'pending', datetime.now(timezone.utc).isoformat()))
        return list_reviews(db, board, snapshot_id)[0]


@router.post('/{board}/snapshots/{snapshot_id}/review/comments')
def comment_review(board: str, snapshot_id: str, body: ReviewComment, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        review = require_review(db, board, snapshot_id)
        if user['user_id'] not in (review['author'], review['reviewer']):
            raise HTTPException(403, 'Only the author and assigned reviewer can comment.')
        if review['status'] != 'pending':
            raise HTTPException(409, 'This review is closed.')
        add_review_comment(db, board, snapshot_id, user, body.message)
        return list_reviews(db, board, snapshot_id)[0]


@router.post('/{board}/snapshots/{snapshot_id}/review/decision')
def decide_review(board: str, snapshot_id: str, body: ReviewDecision, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        review = require_review(db, board, snapshot_id)
        if user['user_id'] != review['reviewer']:
            raise HTTPException(403, 'Only the assigned reviewer can make a decision.')
        if review['status'] == body.decision:
            return list_reviews(db, board, snapshot_id)[0]
        if review['status'] != 'pending':
            raise HTTPException(409, 'This review is closed.')
        if body.message:
            add_review_comment(db, board, snapshot_id, user, body.message)
        db.execute('UPDATE figure_reviews SET status=?, decided_at=? WHERE board=? AND snapshot=?',
                   (body.decision, datetime.now(timezone.utc).isoformat(), board, snapshot_id))
        return list_reviews(db, board, snapshot_id)[0]


@router.patch('/{board}/snapshots/{snapshot_id}/position')
def move_snapshot(board: str, snapshot_id: str, body: Position, authorization: Optional[str] = Header(default=None)):
    identity(authorization)
    with connect() as db:
        require_board(db, board)
        result = db.execute('UPDATE board_snapshots SET position=? WHERE board=? AND id=?', (body.model_dump_json(), board, snapshot_id))
        if not result.rowcount:
            raise HTTPException(404, 'Snapshot has not synced yet. Try moving it again.')
    return {'ok': True}
