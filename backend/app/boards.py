"""Durable, link-shared boards. Append-only snapshots; atomic position updates."""
import asyncio
import hashlib
import json
import secrets
import sqlite3
import time
from typing import Literal, Optional
from contextlib import contextmanager
from datetime import datetime, timezone
from threading import Lock
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field
from .history_store import get_history_store

router = APIRouter(prefix='/api/boards', tags=['boards'])
_listeners = {}
_listeners_lock = Lock()


@contextmanager
def connect(changed_board=None):
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
    CREATE TABLE IF NOT EXISTS board_changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        board TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL, UNIQUE(board,kind,item)
    );
    CREATE INDEX IF NOT EXISTS board_change_revision ON board_changes(board,revision);
    ''')
    try:
        with db:
            yield db
        if changed_board and db.total_changes:
            with _listeners_lock:
                for loop, signal in _listeners.get(changed_board, ()):
                    loop.call_soon_threadsafe(signal.set)
    finally:
        db.close()


def record_change(db, board, kind, item=''):
    db.execute('INSERT OR REPLACE INTO board_changes(board,kind,item) VALUES (?,?,?)', (board, kind, item))


def board_revision(db, board):
    return db.execute('SELECT COALESCE(MAX(revision),0) FROM board_changes WHERE board=?', (board,)).fetchone()[0]


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
        record_change(db, board, 'members')


def list_members(db, board):
    return [{'id':row['user_id'], 'name':row['name']} for row in db.execute(
        'SELECT user_id,name FROM board_members WHERE board=? ORDER BY name COLLATE NOCASE,user_id', (board,)
    )]


def snapshot_data(rows):
    return [{**json.loads(row['payload']), **({'position':json.loads(row['position'])} if row['position'] else {})}
            for row in rows]


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
    with connect(board) as db:
        record = require_board(db, board)
        remember_member(db, board, user)
        db.commit()
        db.execute('BEGIN')
        revision = board_revision(db, board)
        rows = db.execute('SELECT payload,position FROM board_snapshots WHERE board=? ORDER BY rowid', (board,)).fetchall()
        members, reviews = list_members(db, board), list_reviews(db, board)
    return {'id':board, 'name':record['name'], 'revision':revision, 'members':members,
            'reviews':reviews, 'snapshots':snapshot_data(rows)}


def read_changes(board, after):
    with connect() as db:
        db.execute('BEGIN')
        require_board(db, board)
        revision = board_revision(db, board)
        if revision <= after:
            return None
        kinds = {row['kind'] for row in db.execute(
            'SELECT DISTINCT kind FROM board_changes WHERE board=? AND revision>?', (board, after)
        )}
        result = {'revision':revision}
        if 'snapshot' in kinds:
            rows = db.execute('''
                SELECT s.payload,s.position FROM board_snapshots s
                JOIN board_changes c ON c.board=s.board AND c.item=s.id
                WHERE c.board=? AND c.kind='snapshot' AND c.revision>? ORDER BY s.rowid
            ''', (board, after)).fetchall()
            result['snapshots'] = snapshot_data(rows)
        if 'position' in kinds:
            result['positions'] = [{'id':row['id'], 'position':json.loads(row['position'])} for row in db.execute('''
                SELECT s.id,s.position FROM board_snapshots s
                JOIN board_changes c ON c.board=s.board AND c.item=s.id
                WHERE c.board=? AND c.kind='position' AND c.revision>?
            ''', (board, after))]
        if 'members' in kinds:
            result['members'] = list_members(db, board)
        if 'review' in kinds or 'members' in kinds:
            result['reviews'] = list_reviews(db, board)
        return result


@router.get('/{board}/updates')
async def wait_for_board_update(board: str, after: int = Query(ge=0), _user: dict = Depends(require_session)):
    loop = asyncio.get_running_loop()
    signal = asyncio.Event()
    listener = (loop, signal)
    with _listeners_lock:
        _listeners.setdefault(board, set()).add(listener)
    deadline = loop.time() + 20
    try:
        while True:
            signal.clear()
            update = await run_in_threadpool(read_changes, board, after)
            if update:
                return update
            if loop.time() >= deadline:
                return Response(status_code=204)
            try:
                await asyncio.wait_for(signal.wait(), deadline - loop.time())
            except asyncio.TimeoutError:
                # Recheck SQLite before renewing, including writes from another process.
                pass
    finally:
        with _listeners_lock:
            _listeners[board].remove(listener)
            if not _listeners[board]:
                del _listeners[board]


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
    with connect(board) as db:
        require_board(db, board)
        inserted = db.execute('INSERT OR IGNORE INTO board_snapshots(board,id,payload) VALUES (?,?,?)', (board, snapshot_id, encoded))
        if inserted.rowcount:
            record_change(db, board, 'snapshot', snapshot_id)
    return {'ok': True}


@router.post('/{board}/snapshots/{snapshot_id}/review')
def request_review(board: str, snapshot_id: str, body: ReviewRequest, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    with connect(board) as db:
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
        record_change(db, board, 'review')
        return list_reviews(db, board, snapshot_id)[0]


@router.post('/{board}/snapshots/{snapshot_id}/review/comments')
def comment_review(board: str, snapshot_id: str, body: ReviewComment, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    with connect(board) as db:
        db.execute('BEGIN IMMEDIATE')
        review = require_review(db, board, snapshot_id)
        if user['user_id'] not in (review['author'], review['reviewer']):
            raise HTTPException(403, 'Only the author and assigned reviewer can comment.')
        if review['status'] != 'pending':
            raise HTTPException(409, 'This review is closed.')
        add_review_comment(db, board, snapshot_id, user, body.message)
        record_change(db, board, 'review')
        return list_reviews(db, board, snapshot_id)[0]


@router.post('/{board}/snapshots/{snapshot_id}/review/decision')
def decide_review(board: str, snapshot_id: str, body: ReviewDecision, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    with connect(board) as db:
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
        record_change(db, board, 'review')
        return list_reviews(db, board, snapshot_id)[0]


@router.patch('/{board}/snapshots/{snapshot_id}/position')
def move_snapshot(board: str, snapshot_id: str, body: Position, authorization: Optional[str] = Header(default=None)):
    identity(authorization)
    with connect(board) as db:
        require_board(db, board)
        result = db.execute('UPDATE board_snapshots SET position=? WHERE board=? AND id=?', (body.model_dump_json(), board, snapshot_id))
        if not result.rowcount:
            raise HTTPException(404, 'Snapshot has not synced yet. Try moving it again.')
        record_change(db, board, 'position', snapshot_id)
    return {'ok': True}
