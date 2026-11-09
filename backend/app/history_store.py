from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


MAX_TITLE_LENGTH = 120
MIN_PASSWORD_LENGTH = 6


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_json(value: Any) -> str:
    if value is None:
        return "{}"
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return "{}"


def _from_json(value: Optional[str]) -> Dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _from_json_any(value: Optional[str]) -> Any:
    if not value:
        return {}
    try:
        return json.loads(value)
    except Exception:
        return {}


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    normalized = normalized.strip("-")
    return normalized or "artifact"


def _normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def _normalize_username(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "", str(value or "").strip().lower())
    return normalized


def _artifact_payload_for_storage(payload: Dict[str, Any]) -> Dict[str, Any]:
    allowed_keys = {
        "id",
        "name",
        "type",
        "description",
        "code",
        "image",
        "text",
        "language",
        "prompt",
        "meta",
    }
    return {key: payload.get(key) for key in allowed_keys}


def _hash_tool_args(arguments: Dict[str, Any]) -> str:
    try:
        serialized = json.dumps(arguments or {}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        serialized = "{}"
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _hash_password(password: str) -> str:
    salt = str(os.getenv("AUTH_PASSWORD_SALT", "chat-canvas-local-salt-v1"))
    payload = f"{salt}|{password}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _summarize_tool_result(result: Any) -> str:
    if isinstance(result, dict):
        if result.get("error"):
            return str(result.get("error"))[:300]
        keys = sorted(str(key) for key in result.keys())
        summary = f"ok keys={','.join(keys[:8])}"
        if len(keys) > 8:
            summary += f"+{len(keys)-8}"
        return summary[:300]
    if isinstance(result, list):
        return f"ok list[{len(result)}]"
    text = str(result or "").strip()
    return text[:300] or "ok"


def _sanitize_tool_payload(value: Any, key_hint: str = "") -> Any:
    lowered_key = key_hint.lower()
    if isinstance(value, dict):
        cleaned: Dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            cleaned[key_text] = _sanitize_tool_payload(item, key_text)
        return cleaned
    if isinstance(value, list):
        return [_sanitize_tool_payload(item, key_hint) for item in value[:50]]
    if isinstance(value, str):
        if lowered_key in {"image", "mask", "data", "b64_json"}:
            return f"<omitted:{lowered_key or 'blob'}>"
        trimmed = value.strip()
        if trimmed.startswith("data:image/"):
            return "<omitted:data-image-uri>"
        if len(value) > 1200:
            return f"{value[:600]}...<truncated:{len(value)-600}>"
        return value
    return value


class ChatHistoryStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._prepare_path()
        self._init_schema()

    def _prepare_path(self) -> None:
        path = Path(self.db_path)
        if path.parent and not path.parent.exists():
            path.parent.mkdir(parents=True, exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _init_schema(self) -> None:
        with self._lock, self._connect() as connection:
            cursor = connection.cursor()

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    meta_json TEXT
                )
                """
            )
            cursor.execute("PRAGMA table_info(users)")
            user_columns = {str(row["name"]) for row in cursor.fetchall()}
            user_column_migrations = {
                "username": "ALTER TABLE users ADD COLUMN username TEXT",
                "email": "ALTER TABLE users ADD COLUMN email TEXT",
                "display_name": "ALTER TABLE users ADD COLUMN display_name TEXT",
                "password_hash": "ALTER TABLE users ADD COLUMN password_hash TEXT",
                "last_login_at": "ALTER TABLE users ADD COLUMN last_login_at TEXT",
            }
            for column, statement in user_column_migrations.items():
                if column not in user_columns:
                    cursor.execute(statement)
            cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(username)")
            cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email)")

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    meta_json TEXT,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)"
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    meta_json TEXT,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
                    UNIQUE(conversation_id, seq)
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq)"
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    logical_key TEXT NOT NULL,
                    latest_message_id TEXT,
                    type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    language TEXT,
                    latest_version_number INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    meta_json TEXT,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
                    FOREIGN KEY (latest_message_id) REFERENCES messages(id),
                    UNIQUE(conversation_id, logical_key)
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id)"
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS artifact_versions (
                    id TEXT PRIMARY KEY,
                    artifact_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    message_id TEXT,
                    parent_version_id TEXT,
                    operation TEXT NOT NULL,
                    prompt TEXT,
                    code TEXT,
                    image TEXT,
                    text TEXT,
                    meta_json TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
                    FOREIGN KEY (message_id) REFERENCES messages(id),
                    FOREIGN KEY (parent_version_id) REFERENCES artifact_versions(id),
                    UNIQUE(artifact_id, version_number)
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id, version_number)"
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS tool_runs (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    message_id TEXT,
                    tool_name TEXT NOT NULL,
                    args_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    latency_ms INTEGER NOT NULL DEFAULT 0,
                    output_summary TEXT,
                    raw_arguments_json TEXT,
                    raw_result_json TEXT,
                    meta_json TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
                    FOREIGN KEY (message_id) REFERENCES messages(id)
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_tool_runs_conversation ON tool_runs(conversation_id, created_at)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_tool_runs_tool_name ON tool_runs(tool_name, created_at)"
            )

            connection.commit()

    def ensure_user(self, user_id: Optional[str]) -> str:
        now = _utc_now()
        stable_user_id = str(user_id or "").strip() or f"user-{uuid.uuid4().hex[:12]}"
        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            cursor.execute(
                """
                INSERT INTO users (id, created_at, updated_at, meta_json)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
                """,
                (stable_user_id, now, now, "{}"),
            )
            connection.commit()
        return stable_user_id

    def _ensure_unique_username(self, cursor: sqlite3.Cursor, candidate: str) -> str:
        base = _normalize_username(candidate) or f"user-{uuid.uuid4().hex[:8]}"
        proposed = base
        suffix = 1
        while True:
            cursor.execute(
                "SELECT id FROM users WHERE username = ? LIMIT 1",
                (proposed,),
            )
            if cursor.fetchone() is None:
                return proposed
            suffix += 1
            proposed = f"{base}-{suffix}"

    def authenticate_or_register_user(
        self,
        username: Optional[str],
        email: Optional[str],
        password: str,
        display_name: Optional[str] = None,
    ) -> Dict[str, str]:
        normalized_username = _normalize_username(username or "")
        normalized_email = _normalize_email(email or "")
        raw_password = str(password or "")
        preferred_name = str(display_name or "").strip()
        if not normalized_username and not normalized_email:
            raise ValueError("Please provide a username or email.")
        if normalized_email and "@" not in normalized_email:
            raise ValueError("If provided, email must be valid.")
        if len(raw_password) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")

        now = _utc_now()
        password_hash = _hash_password(raw_password)

        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            existing = None
            if normalized_username:
                cursor.execute(
                    """
                    SELECT id, username, email, display_name, password_hash
                    FROM users
                    WHERE username = ?
                    LIMIT 1
                    """,
                    (normalized_username,),
                )
                existing = cursor.fetchone()

            if existing is None and normalized_email:
                cursor.execute(
                    """
                    SELECT id, username, email, display_name, password_hash
                    FROM users
                    WHERE email = ?
                    LIMIT 1
                    """,
                    (normalized_email,),
                )
                existing = cursor.fetchone()

            if existing is None and normalized_username and normalized_email:
                cursor.execute(
                    """
                    SELECT id, username, email, display_name, password_hash
                    FROM users
                    WHERE username = ? OR email = ?
                    LIMIT 1
                    """,
                    (normalized_username, normalized_email),
                )
                existing = cursor.fetchone()

            if existing is None:
                user_id = f"user-{uuid.uuid4()}"
                desired_username = normalized_username or normalized_email.split("@")[0]
                final_username = self._ensure_unique_username(cursor, desired_username)
                final_name = preferred_name or final_username
                cursor.execute(
                    """
                    INSERT INTO users (
                        id, created_at, updated_at, meta_json,
                        username, email, display_name, password_hash, last_login_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        now,
                        now,
                        _to_json({"auth": "local"}),
                        final_username,
                        normalized_email or None,
                        final_name,
                        password_hash,
                        now,
                    ),
                )
                connection.commit()
                return {
                    "user_id": user_id,
                    "username": final_username,
                    "email": normalized_email or "",
                    "display_name": final_name,
                }

            user_id = str(existing["id"])
            stored_password_hash = str(existing["password_hash"] or "").strip()
            if stored_password_hash and stored_password_hash != password_hash:
                raise PermissionError("Invalid username/email or password.")

            existing_username = str(existing["username"] or "").strip()
            existing_email = str(existing["email"] or "").strip().lower()
            final_username = existing_username or normalized_username or normalized_email.split("@")[0] or self._ensure_unique_username(cursor, "user")
            final_email = existing_email or normalized_email or None
            final_name = preferred_name or str(existing["display_name"] or "").strip() or final_username
            cursor.execute(
                """
                UPDATE users
                SET updated_at = ?,
                    last_login_at = ?,
                    username = ?,
                    display_name = ?,
                    password_hash = ?,
                    email = ?
                WHERE id = ?
                """,
                (now, now, final_username, final_name, password_hash, final_email, user_id),
            )
            connection.commit()
            return {
                "user_id": user_id,
                "username": final_username,
                "email": final_email or "",
                "display_name": final_name,
            }

    def ensure_conversation(
        self,
        user_id: str,
        conversation_id: Optional[str],
        title_hint: Optional[str] = None,
    ) -> str:
        now = _utc_now()
        stable_conversation_id = str(conversation_id or "").strip() or f"conv-{uuid.uuid4().hex}"
        title = (title_hint or "").strip()[:MAX_TITLE_LENGTH] or None

        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            cursor.execute(
                "SELECT id, user_id, title FROM conversations WHERE id = ?",
                (stable_conversation_id,),
            )
            existing = cursor.fetchone()

            if existing is None:
                cursor.execute(
                    """
                    INSERT INTO conversations (id, user_id, title, created_at, updated_at, meta_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (stable_conversation_id, user_id, title, now, now, "{}"),
                )
            else:
                resolved_user_id = str(existing["user_id"] or "")
                if resolved_user_id != user_id:
                    user_id = resolved_user_id
                next_title = str(existing["title"] or "").strip() or title
                cursor.execute(
                    """
                    UPDATE conversations
                    SET updated_at = ?, title = COALESCE(?, title)
                    WHERE id = ?
                    """,
                    (now, next_title, stable_conversation_id),
                )

            connection.commit()
        return stable_conversation_id

    def _next_message_seq(self, cursor: sqlite3.Cursor, conversation_id: str) -> int:
        cursor.execute(
            "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE conversation_id = ?",
            (conversation_id,),
        )
        row = cursor.fetchone()
        return int(row["next_seq"] if row and row["next_seq"] is not None else 0)

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        source: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        now = _utc_now()
        message_id = f"msg-{uuid.uuid4().hex}"
        payload = str(content or "")

        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            next_seq = self._next_message_seq(cursor, conversation_id)
            cursor.execute(
                """
                INSERT INTO messages (id, conversation_id, seq, role, content, source, created_at, meta_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    conversation_id,
                    next_seq,
                    role,
                    payload,
                    source,
                    now,
                    _to_json(metadata or {}),
                ),
            )
            cursor.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
            connection.commit()

        return message_id

    def add_tool_runs(
        self,
        conversation_id: str,
        message_id: Optional[str],
        tool_runs: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        now = _utc_now()
        records: List[Dict[str, Any]] = []
        if not tool_runs:
            return records

        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            for item in tool_runs:
                if not isinstance(item, dict):
                    continue
                tool_name = str(item.get("tool_name") or "").strip()
                if not tool_name:
                    continue
                arguments = item.get("arguments") if isinstance(item.get("arguments"), dict) else {}
                result = item.get("result")
                sanitized_arguments = _sanitize_tool_payload(arguments)
                sanitized_result = _sanitize_tool_payload(result)
                status = str(item.get("status") or "").strip().lower() or (
                    "error" if isinstance(result, dict) and result.get("error") else "ok"
                )
                latency_ms = int(item.get("latency_ms") or 0)
                args_hash = _hash_tool_args(arguments)
                output_summary = _summarize_tool_result(sanitized_result)
                tool_run_id = f"toolrun-{uuid.uuid4().hex}"

                meta = {}
                if item.get("tool_call_id"):
                    meta["tool_call_id"] = str(item.get("tool_call_id"))

                cursor.execute(
                    """
                    INSERT INTO tool_runs (
                        id, conversation_id, message_id, tool_name, args_hash, status,
                        latency_ms, output_summary, raw_arguments_json, raw_result_json, meta_json, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tool_run_id,
                        conversation_id,
                        message_id,
                        tool_name,
                        args_hash,
                        status,
                        latency_ms,
                        output_summary,
                        _to_json(sanitized_arguments),
                        _to_json(sanitized_result),
                        _to_json(meta),
                        now,
                    ),
                )
                records.append(
                    {
                        "id": tool_run_id,
                        "tool_name": tool_name,
                        "args_hash": args_hash,
                        "status": status,
                        "latency_ms": latency_ms,
                        "output_summary": output_summary,
                        "message_id": message_id,
                        "created_at": now,
                        "meta": meta,
                    }
                )

            cursor.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
            connection.commit()

        return records

    def upsert_artifact_version(
        self,
        conversation_id: str,
        message_id: Optional[str],
        artifact_payload: Dict[str, Any],
        prompt: Optional[str],
        operation: str,
        parent_logical_key: Optional[str] = None,
        parent_version_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        now = _utc_now()
        snapshot = _artifact_payload_for_storage(artifact_payload)

        artifact_type = str(snapshot.get("type") or "text").strip().lower()
        artifact_name = str(snapshot.get("name") or snapshot.get("id") or "Generated Artifact").strip()
        artifact_description = str(snapshot.get("description") or "").strip() or None
        artifact_language = str(snapshot.get("language") or "").strip() or None

        logical_key = str(parent_logical_key or "").strip()
        if not logical_key:
            logical_key = str(snapshot.get("id") or "").strip()
        if not logical_key:
            logical_key = f"{_slugify(artifact_name)}-{artifact_type}"

        with self._lock, self._connect() as connection:
            cursor = connection.cursor()

            cursor.execute(
                """
                SELECT id, latest_version_number
                FROM artifacts
                WHERE conversation_id = ? AND logical_key = ?
                """,
                (conversation_id, logical_key),
            )
            existing = cursor.fetchone()

            if existing is None:
                artifact_id = f"art-{uuid.uuid4().hex}"
                latest_version_number = 0
                cursor.execute(
                    """
                    INSERT INTO artifacts (
                        id, conversation_id, logical_key, latest_message_id,
                        type, name, description, language, latest_version_number,
                        created_at, updated_at, meta_json
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        artifact_id,
                        conversation_id,
                        logical_key,
                        message_id,
                        artifact_type,
                        artifact_name,
                        artifact_description,
                        artifact_language,
                        latest_version_number,
                        now,
                        now,
                        _to_json({"latest_snapshot": snapshot}),
                    ),
                )
            else:
                artifact_id = str(existing["id"])
                latest_version_number = int(existing["latest_version_number"] or 0)

            next_version = latest_version_number + 1

            resolved_parent_version_id = str(parent_version_id or "").strip() or None
            if resolved_parent_version_id:
                cursor.execute(
                    "SELECT id FROM artifact_versions WHERE id = ?",
                    (resolved_parent_version_id,),
                )
                if cursor.fetchone() is None:
                    resolved_parent_version_id = None

            if not resolved_parent_version_id:
                cursor.execute(
                    """
                    SELECT id
                    FROM artifact_versions
                    WHERE artifact_id = ? AND version_number = ?
                    """,
                    (artifact_id, latest_version_number),
                )
                parent_version_row = cursor.fetchone()
                resolved_parent_version_id = str(parent_version_row["id"]) if parent_version_row else None

            version_id = f"artv-{uuid.uuid4().hex}"
            cursor.execute(
                """
                INSERT INTO artifact_versions (
                    id, artifact_id, version_number, message_id, parent_version_id,
                    operation, prompt, code, image, text, meta_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version_id,
                    artifact_id,
                    next_version,
                    message_id,
                    resolved_parent_version_id,
                    operation,
                    str(prompt or ""),
                    snapshot.get("code"),
                    snapshot.get("image"),
                    snapshot.get("text"),
                    _to_json(snapshot.get("meta") or {}),
                    now,
                ),
            )

            cursor.execute(
                """
                UPDATE artifacts
                SET latest_message_id = ?,
                    type = ?,
                    name = ?,
                    description = ?,
                    language = ?,
                    latest_version_number = ?,
                    updated_at = ?,
                    meta_json = ?
                WHERE id = ?
                """,
                (
                    message_id,
                    artifact_type,
                    artifact_name,
                    artifact_description,
                    artifact_language,
                    next_version,
                    now,
                    _to_json({"latest_snapshot": snapshot}),
                    artifact_id,
                ),
            )

            cursor.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
            connection.commit()

        return {
            "artifact_id": artifact_id,
            "version_id": version_id,
            "version_number": next_version,
            "logical_key": logical_key,
        }

    def record_chat_turn(
        self,
        *,
        user_id: Optional[str],
        conversation_id: Optional[str],
        request_messages: List[Dict[str, Any]],
        reply: str,
        artifacts: List[Dict[str, Any]],
        parent_artifact_id: Optional[str] = None,
        parent_version_id: Optional[str] = None,
        artifact_parent_links: Optional[List[Dict[str, Any]]] = None,
        tool_runs: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        stable_user_id = self.ensure_user(user_id)
        title_hint = self._latest_user_message_content(request_messages)
        stable_conversation_id = self.ensure_conversation(stable_user_id, conversation_id, title_hint=title_hint)

        latest_user = title_hint
        latest_user_message_id = None
        if latest_user:
            latest_user_message_id = self.add_message(
                stable_conversation_id,
                role="user",
                content=latest_user,
                source="chat",
                metadata={
                    "message_count": len(request_messages),
                },
            )

        assistant_message_id = self.add_message(
            stable_conversation_id,
            role="assistant",
            content=str(reply or ""),
            source="chat",
            metadata={
                "message_count": len(request_messages),
                "input_messages": request_messages,
                "artifact_count": len(artifacts),
                "user_message_id": latest_user_message_id,
            },
        )
        tool_run_records = self.add_tool_runs(
            stable_conversation_id,
            assistant_message_id,
            [item for item in (tool_runs or []) if isinstance(item, dict)],
        )

        explicit_links = [item for item in (artifact_parent_links or []) if isinstance(item, dict)]
        link_by_artifact_id: Dict[str, Dict[str, Any]] = {}
        for link in explicit_links:
            artifact_id = str(link.get("artifact_id") or "").strip()
            if artifact_id:
                link_by_artifact_id[artifact_id] = link

        artifact_records: List[Dict[str, Any]] = []
        for index, artifact in enumerate(artifacts):
            if not isinstance(artifact, dict):
                continue
            artifact_child_id = str(artifact.get("id") or "").strip()
            link = link_by_artifact_id.get(artifact_child_id)
            if not link and len(explicit_links) == 1 and len(artifacts) == 1:
                link = explicit_links[0]
            parent_key = str(link.get("parent_artifact_id") or "").strip() if link else ""
            parent_version_for_record = str(link.get("parent_version_id") or "").strip() if link else ""

            if not parent_key and parent_artifact_id and index == 0 and str(artifact.get("type") or "").lower() == "image":
                parent_key = str(parent_artifact_id).strip()
            if not parent_version_for_record and parent_version_id and index == 0:
                parent_version_for_record = str(parent_version_id).strip()

            record = self.upsert_artifact_version(
                conversation_id=stable_conversation_id,
                message_id=assistant_message_id,
                artifact_payload=artifact,
                prompt=latest_user,
                operation="chat_generate",
                parent_logical_key=parent_key or None,
                parent_version_id=parent_version_for_record or None,
            )
            record["artifact_input_id"] = artifact_child_id
            artifact_records.append(record)

        return {
            "user_id": stable_user_id,
            "conversation_id": stable_conversation_id,
            "assistant_message_id": assistant_message_id,
            "artifact_records": artifact_records,
            "tool_run_records": tool_run_records,
        }

    def record_image_refine_turn(
        self,
        *,
        user_id: Optional[str],
        conversation_id: Optional[str],
        instruction: str,
        response_reply: str,
        artifact: Optional[Dict[str, Any]],
        parent_artifact_id: Optional[str] = None,
        parent_version_id: Optional[str] = None,
        request_payload: Optional[Dict[str, Any]] = None,
        tool_runs: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        stable_user_id = self.ensure_user(user_id)
        title_hint = str(instruction or "").strip() or "Image refinement"
        stable_conversation_id = self.ensure_conversation(stable_user_id, conversation_id, title_hint=title_hint)

        user_message_id = self.add_message(
            stable_conversation_id,
            role="user",
            content=title_hint,
            source="image_refine",
            metadata={
                "request_payload": request_payload or {},
            },
        )

        assistant_message_id = self.add_message(
            stable_conversation_id,
            role="assistant",
            content=str(response_reply or ""),
            source="image_refine",
            metadata={
                "user_message_id": user_message_id,
                "artifact_returned": bool(isinstance(artifact, dict)),
            },
        )
        tool_run_records = self.add_tool_runs(
            stable_conversation_id,
            assistant_message_id,
            [item for item in (tool_runs or []) if isinstance(item, dict)],
        )

        artifact_record = None
        if isinstance(artifact, dict):
            artifact_record = self.upsert_artifact_version(
                conversation_id=stable_conversation_id,
                message_id=assistant_message_id,
                artifact_payload=artifact,
                prompt=title_hint,
                operation="image_refine",
                parent_logical_key=parent_artifact_id,
                parent_version_id=parent_version_id,
            )

        return {
            "user_id": stable_user_id,
            "conversation_id": stable_conversation_id,
            "assistant_message_id": assistant_message_id,
            "artifact_record": artifact_record,
            "tool_run_records": tool_run_records,
        }

    def list_conversations(self, user_id: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 200))
        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            if user_id:
                cursor.execute(
                    """
                    SELECT
                        c.id,
                        c.user_id,
                        c.title,
                        c.created_at,
                        c.updated_at,
                        COUNT(m.id) AS message_count,
                        COUNT(DISTINCT a.id) AS artifact_count
                    FROM conversations c
                    LEFT JOIN messages m ON m.conversation_id = c.id
                    LEFT JOIN artifacts a ON a.conversation_id = c.id
                    WHERE c.user_id = ?
                    GROUP BY c.id
                    ORDER BY c.updated_at DESC
                    LIMIT ?
                    """,
                    (user_id, safe_limit),
                )
            else:
                cursor.execute(
                    """
                    SELECT
                        c.id,
                        c.user_id,
                        c.title,
                        c.created_at,
                        c.updated_at,
                        COUNT(m.id) AS message_count,
                        COUNT(DISTINCT a.id) AS artifact_count
                    FROM conversations c
                    LEFT JOIN messages m ON m.conversation_id = c.id
                    LEFT JOIN artifacts a ON a.conversation_id = c.id
                    GROUP BY c.id
                    ORDER BY c.updated_at DESC
                    LIMIT ?
                    """,
                    (safe_limit,),
                )
            rows = cursor.fetchall()

        return [dict(row) for row in rows]

    def get_conversation_messages(self, conversation_id: str, limit: int = 400) -> List[Dict[str, Any]]:
        safe_conversation_id = str(conversation_id or "").strip()
        if not safe_conversation_id:
            return []
        safe_limit = max(1, min(int(limit), 2000))
        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            cursor.execute(
                """
                SELECT id, seq, role, content, source, created_at, meta_json
                FROM messages
                WHERE conversation_id = ?
                ORDER BY seq DESC
                LIMIT ?
                """,
                (safe_conversation_id, safe_limit),
            )
            rows = cursor.fetchall()

        ordered = list(reversed(rows))
        messages: List[Dict[str, Any]] = []
        for row in ordered:
            item = dict(row)
            item["meta"] = _from_json(item.pop("meta_json", None))
            messages.append(item)
        return messages

    def get_conversation_detail(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            cursor.execute(
                """
                SELECT id, user_id, title, created_at, updated_at, meta_json
                FROM conversations
                WHERE id = ?
                """,
                (conversation_id,),
            )
            conversation_row = cursor.fetchone()
            if conversation_row is None:
                return None

            cursor.execute(
                """
                SELECT id, seq, role, content, source, created_at, meta_json
                FROM messages
                WHERE conversation_id = ?
                ORDER BY seq ASC
                """,
                (conversation_id,),
            )
            message_rows = cursor.fetchall()

            cursor.execute(
                """
                SELECT id, logical_key, type, name, description, language,
                       latest_version_number, created_at, updated_at, meta_json
                FROM artifacts
                WHERE conversation_id = ?
                ORDER BY updated_at DESC
                """,
                (conversation_id,),
            )
            artifact_rows = cursor.fetchall()

            artifacts: List[Dict[str, Any]] = []
            for artifact_row in artifact_rows:
                artifact = dict(artifact_row)
                artifact["meta"] = _from_json(artifact.pop("meta_json", None))
                cursor.execute(
                    """
                    SELECT id, version_number, message_id, parent_version_id,
                           operation, prompt, code, image, text, meta_json, created_at
                    FROM artifact_versions
                    WHERE artifact_id = ?
                    ORDER BY version_number ASC
                    """,
                    (artifact["id"],),
                )
                versions = []
                for version_row in cursor.fetchall():
                    version = dict(version_row)
                    version["meta"] = _from_json(version.pop("meta_json", None))
                    versions.append(version)
                artifact["versions"] = versions
                artifacts.append(artifact)

            cursor.execute(
                """
                SELECT id, message_id, tool_name, args_hash, status, latency_ms, output_summary,
                       raw_arguments_json, raw_result_json, created_at, meta_json
                FROM tool_runs
                WHERE conversation_id = ?
                ORDER BY created_at ASC
                """,
                (conversation_id,),
            )
            tool_run_rows = cursor.fetchall()

        return {
            "conversation": {
                **{k: conversation_row[k] for k in conversation_row.keys() if k != "meta_json"},
                "meta": _from_json(conversation_row["meta_json"]),
            },
            "messages": [
                {
                    **{k: row[k] for k in row.keys() if k != "meta_json"},
                    "meta": _from_json(row["meta_json"]),
                }
                for row in message_rows
            ],
            "artifacts": artifacts,
            "tool_runs": [
                {
                    **{
                        k: row[k]
                        for k in row.keys()
                        if k not in {"meta_json", "raw_arguments_json", "raw_result_json"}
                    },
                    "meta": {
                        **_from_json(row["meta_json"]),
                        "arguments": _from_json_any(row["raw_arguments_json"]),
                        "result": _from_json_any(row["raw_result_json"]),
                    },
                }
                for row in tool_run_rows
            ],
        }

    def restore_artifact_version(
        self,
        artifact_id: str,
        version_id: str,
    ) -> Optional[Dict[str, Any]]:
        now = _utc_now()
        with self._lock, self._connect() as connection:
            cursor = connection.cursor()
            cursor.execute(
                """
                SELECT id, conversation_id, logical_key, type, name, description, language, latest_version_number
                FROM artifacts
                WHERE id = ?
                LIMIT 1
                """,
                (artifact_id,),
            )
            artifact_row = cursor.fetchone()
            if artifact_row is None:
                return None

            cursor.execute(
                """
                SELECT id, artifact_id, version_number, prompt, code, image, text, meta_json
                FROM artifact_versions
                WHERE id = ? AND artifact_id = ?
                LIMIT 1
                """,
                (version_id, artifact_id),
            )
            source_version_row = cursor.fetchone()
            if source_version_row is None:
                return None

            conversation_id = str(artifact_row["conversation_id"])
            latest_version_number = int(artifact_row["latest_version_number"] or 0)
            next_version_number = latest_version_number + 1
            message_id = f"msg-{uuid.uuid4().hex}"
            next_seq = self._next_message_seq(cursor, conversation_id)
            restore_note = (
                f"Restored artifact {artifact_row['logical_key']} "
                f"to version {int(source_version_row['version_number'])}."
            )
            cursor.execute(
                """
                INSERT INTO messages (id, conversation_id, seq, role, content, source, created_at, meta_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    conversation_id,
                    next_seq,
                    "assistant",
                    restore_note,
                    "artifact_restore",
                    now,
                    _to_json(
                        {
                            "artifact_id": artifact_id,
                            "source_version_id": version_id,
                            "source_version_number": int(source_version_row["version_number"]),
                        }
                    ),
                ),
            )

            restored_version_id = f"artv-{uuid.uuid4().hex}"
            source_meta = _from_json(source_version_row["meta_json"])
            cursor.execute(
                """
                INSERT INTO artifact_versions (
                    id, artifact_id, version_number, message_id, parent_version_id,
                    operation, prompt, code, image, text, meta_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    restored_version_id,
                    artifact_id,
                    next_version_number,
                    message_id,
                    version_id,
                    "restore_version",
                    str(source_version_row["prompt"] or ""),
                    source_version_row["code"],
                    source_version_row["image"],
                    source_version_row["text"],
                    _to_json(source_meta),
                    now,
                ),
            )

            latest_snapshot = {
                "id": str(artifact_row["logical_key"]),
                "name": str(artifact_row["name"] or "Restored Artifact"),
                "type": str(artifact_row["type"] or "text"),
                "description": str(artifact_row["description"] or ""),
                "language": str(artifact_row["language"] or ""),
                "code": source_version_row["code"],
                "image": source_version_row["image"],
                "text": source_version_row["text"],
                "prompt": str(source_version_row["prompt"] or ""),
                "meta": source_meta,
            }
            cursor.execute(
                """
                UPDATE artifacts
                SET latest_message_id = ?,
                    latest_version_number = ?,
                    updated_at = ?,
                    meta_json = ?
                WHERE id = ?
                """,
                (
                    message_id,
                    next_version_number,
                    now,
                    _to_json({"latest_snapshot": latest_snapshot}),
                    artifact_id,
                ),
            )
            cursor.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
            connection.commit()

        return {
            "artifact_id": artifact_id,
            "logical_key": str(artifact_row["logical_key"]),
            "version_id": restored_version_id,
            "version_number": next_version_number,
            "parent_version_id": version_id,
            "conversation_id": conversation_id,
            "snapshot": latest_snapshot,
        }

    @staticmethod
    def _latest_user_message_content(messages: List[Dict[str, Any]]) -> str:
        for message in reversed(messages):
            if str(message.get("role") or "").strip().lower() == "user":
                return str(message.get("content") or "").strip()
        return ""


_store_singleton: Optional[ChatHistoryStore] = None
_store_lock = threading.Lock()


def get_history_store() -> ChatHistoryStore:
    global _store_singleton
    if _store_singleton is not None:
        return _store_singleton

    with _store_lock:
        if _store_singleton is not None:
            return _store_singleton

        default_path = Path(__file__).resolve().parent.parent / "data" / "chat_history.db"
        configured = os.getenv("CHAT_HISTORY_DB_PATH", str(default_path))
        _store_singleton = ChatHistoryStore(configured)
        return _store_singleton
