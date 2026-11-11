"""Durable, link-shared boards. Append-only snapshots; atomic position updates."""
import hashlib
import json
import secrets
import sqlite3
import time
from typing import Optional
from contextlib import contextmanager
from datetime import datetime, timezone
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
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
        raise HTTPException(401, 'Sign in again to access shared boards.')
    return json.loads(row['profile'])


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


@router.post('')
def create_board(body: BoardInput, authorization: Optional[str] = Header(default=None)):
    identity(authorization)
    board = secrets.token_urlsafe(24)
    with connect() as db:
        db.execute('INSERT INTO boards VALUES (?,?)', (board, body.name))
    return {'id': board, 'name': body.name}


@router.get('/{board}')
def read_board(board: str, authorization: Optional[str] = Header(default=None)):
    identity(authorization)
    with connect() as db:
        record = require_board(db, board)
        rows = db.execute('SELECT payload,position FROM board_snapshots WHERE board=? ORDER BY rowid', (board,)).fetchall()
    return {'id': board, 'name': record['name'], 'snapshots': [{**json.loads(r['payload']), **({'position': json.loads(r['position'])} if r['position'] else {})} for r in rows]}


@router.put('/{board}/snapshots/{snapshot_id}')
def publish_snapshot(board: str, snapshot_id: str, body: dict, authorization: Optional[str] = Header(default=None)):
    user = identity(authorization)
    if body.get('id') != snapshot_id or len(snapshot_id) > 100:
        raise HTTPException(422, 'Invalid snapshot ID.')
    if not str(body.get('image', '')).startswith(('data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,')):
        raise HTTPException(422, 'Snapshot must contain a generated image.')
    payload = {**body, 'creator': {'userId': user['user_id'], 'displayName': user.get('display_name') or user['username']}, 'publishedAt': datetime.now(timezone.utc).isoformat()}
    encoded = json.dumps(payload)
    if len(encoded) > 25_000_000:
        raise HTTPException(413, 'Snapshot is too large.')
    with connect() as db:
        require_board(db, board)
        db.execute('INSERT OR IGNORE INTO board_snapshots(board,id,payload) VALUES (?,?,?)', (board, snapshot_id, encoded))
    return {'ok': True}


@router.patch('/{board}/snapshots/{snapshot_id}/position')
def move_snapshot(board: str, snapshot_id: str, body: Position, authorization: Optional[str] = Header(default=None)):
    identity(authorization)
    with connect() as db:
        require_board(db, board)
        result = db.execute('UPDATE board_snapshots SET position=? WHERE board=? AND id=?', (body.model_dump_json(), board, snapshot_id))
        if not result.rowcount:
            raise HTTPException(404, 'Snapshot has not synced yet. Try moving it again.')
    return {'ok': True}
