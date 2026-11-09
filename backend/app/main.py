from __future__ import annotations

import os
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .artifacts import list_artifacts
from .history_store import get_history_store
from .llm import LLMClient
from .teaser import router as teaser_router
from .workflow import router as workflow_router
from .memory import build_localized_memory_context, extract_latest_user_message
from .models import (
    Artifact,
    ArtifactListResponse,
    ArtifactVersionRestoreRequest,
    ArtifactVersionRestoreResponse,
    AuthLoginRequest,
    AuthLoginResponse,
    ChatRequest,
    ChatResponse,
    ConversationDetailResponse,
    ConversationListResponse,
    CodeSimulateRequest,
    CodeSimulateResponse,
    ImageRefineRequest,
    ImageRefineResponse,
)


load_dotenv()

app = FastAPI(title="Chat Canvas Backend")
app.include_router(teaser_router)
app.include_router(workflow_router)
history_store = get_history_store()


def _env_int(name: str, default: int, low: int, high: int) -> int:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = int(raw)
    except Exception:
        value = default
    return max(low, min(high, value))


def _env_float(name: str, default: float, low: float, high: float) -> float:
    raw = str(os.getenv(name, str(default))).strip()
    try:
        value = float(raw)
    except Exception:
        value = default
    return max(low, min(high, value))


def _build_llm_messages(
    request_messages: List[Dict[str, Any]],
    memory_context: str = "",
) -> List[Dict[str, str]]:
    prepared: List[Dict[str, str]] = []
    for message in request_messages:
        role = str(message.get("role") or "").strip().lower()
        content = str(message.get("content") or "").strip()
        if role == "system" and content:
            prepared.append({"role": "system", "content": content})

    memory = str(memory_context or "").strip()
    if memory:
        prepared.append({"role": "system", "content": memory})

    latest_user = extract_latest_user_message(request_messages)
    if latest_user:
        prepared.append({"role": "user", "content": latest_user})
        return prepared

    for message in reversed(request_messages):
        role = str(message.get("role") or "").strip().lower()
        content = str(message.get("content") or "").strip()
        if role in {"assistant", "user"} and content:
            prepared.append({"role": role, "content": content})
            break
    return prepared


def _with_history_meta(artifact: Artifact, history_record: Optional[Dict[str, Any]]) -> Artifact:
    if not history_record:
        return artifact
    base_meta = artifact.meta.copy() if isinstance(artifact.meta, dict) else {}
    base_meta["history"] = {
        "artifact_db_id": history_record.get("artifact_id"),
        "logical_key": history_record.get("logical_key"),
        "version_id": history_record.get("version_id"),
        "version_number": history_record.get("version_number"),
    }
    artifact.meta = base_meta
    return artifact


def _auth_session_seconds() -> int:
    raw = str(os.getenv("LOGIN_SESSION_HOURS", "6")).strip()
    try:
        hours = float(raw)
    except Exception:
        hours = 6.0
    hours = max(4.0, min(6.0, hours))
    return int(hours * 3600)

cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in cors_origins if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "chat_history": "enabled"}


@app.get("/api/artifacts", response_model=ArtifactListResponse)
async def get_artifacts() -> ArtifactListResponse:
    items = [Artifact(**item) for item in list_artifacts()]
    return ArtifactListResponse(items=items)


@app.post("/api/auth/login", response_model=AuthLoginResponse)
async def auth_login(request: AuthLoginRequest) -> AuthLoginResponse:
    try:
        profile = history_store.authenticate_or_register_user(
            username=request.username,
            email=request.email,
            password=request.password,
            display_name=request.display_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Login failed: {exc}") from exc

    expires_in_seconds = _auth_session_seconds()
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
    return AuthLoginResponse(
        ok=True,
        user_id=str(profile.get("user_id") or ""),
        username=str(profile.get("username") or request.username or ""),
        email=str(profile.get("email") or request.email or ""),
        display_name=str(profile.get("display_name") or request.display_name or ""),
        session_expires_at=expires_at.isoformat(),
        expires_in_seconds=expires_in_seconds,
    )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    if not request.messages:
        return ChatResponse(
            reply="Tell me what you want to build, and I can propose a live artifact.",
            user_id=request.user_id,
            conversation_id=request.conversation_id,
        )

    try:
        client = LLMClient()
    except RuntimeError:
        return ChatResponse(
            reply=(
                "LLM is not configured. Set OPENAI_API_KEY, or AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY "
                "to enable generated artifacts."
            ),
            artifacts=[],
            user_id=request.user_id,
            conversation_id=request.conversation_id,
        )

    request_messages = [message.dict() for message in request.messages]
    latest_user_text = extract_latest_user_message(request_messages)
    llm_messages = _build_llm_messages(request_messages)

    memory_tool_run: Optional[Dict[str, Any]] = None
    safe_conversation_id = str(request.conversation_id or "").strip()
    if safe_conversation_id and latest_user_text:
        started_at = time.perf_counter()
        try:
            memory_messages = history_store.get_conversation_messages(
                safe_conversation_id,
                limit=_env_int("MEMORY_MAX_MESSAGES", 400, 50, 2000),
            )
            memory_pack = build_localized_memory_context(
                memory_messages,
                latest_user_text,
                max_branches=_env_int("MEMORY_MAX_BRANCHES", 4, 1, 8),
                max_context_chars=_env_int("MEMORY_MAX_CONTEXT_CHARS", 3600, 600, 12000),
                min_score=_env_float("MEMORY_MIN_SCORE", 0.08, 0.0, 1.0),
                min_overlap=_env_float("MEMORY_MIN_OVERLAP", 0.05, 0.0, 1.0),
                strong_score=_env_float("MEMORY_STRONG_SCORE", 0.24, 0.0, 1.0),
            )
            memory_context = str(memory_pack.get("context") or "").strip()
            llm_messages = _build_llm_messages(request_messages, memory_context)
            memory_tool_run = {
                "tool_name": "localized_memory_context",
                "arguments": {
                    "conversation_id": safe_conversation_id,
                    "latest_user": latest_user_text[:180],
                },
                "result": {
                    "candidate_count": int(memory_pack.get("candidate_count") or 0),
                    "selected": memory_pack.get("selected") or [],
                    "context_chars": len(memory_context),
                    "llm_message_count": len(llm_messages),
                    "top_score": float(memory_pack.get("top_score") or 0.0),
                    "top_overlap": float(memory_pack.get("top_overlap") or 0.0),
                },
                "status": "ok",
                "latency_ms": int((time.perf_counter() - started_at) * 1000),
            }
        except Exception as exc:
            memory_tool_run = {
                "tool_name": "localized_memory_context",
                "arguments": {
                    "conversation_id": safe_conversation_id,
                    "latest_user": latest_user_text[:180],
                },
                "result": {
                    "error": str(exc),
                    "llm_message_count": len(llm_messages),
                },
                "status": "error",
                "latency_ms": int((time.perf_counter() - started_at) * 1000),
            }

    response = client.chat(llm_messages)
    reply = str(response.get("reply", ""))
    artifacts_payload = response.get("artifacts") or []
    tool_runs_payload = response.get("tool_runs") or []
    if isinstance(memory_tool_run, dict):
        tool_runs_payload = [memory_tool_run, *[item for item in tool_runs_payload if isinstance(item, dict)]]

    artifacts: List[Artifact] = []
    for item in artifacts_payload:
        if not isinstance(item, dict):
            continue
        try:
            artifacts.append(Artifact(**item))
        except Exception:
            continue

    history = {
        "user_id": request.user_id,
        "conversation_id": request.conversation_id,
    }
    try:
        history = history_store.record_chat_turn(
            user_id=request.user_id,
            conversation_id=request.conversation_id,
            request_messages=request_messages,
            reply=reply,
            artifacts=[artifact.dict() for artifact in artifacts],
            parent_artifact_id=request.parent_artifact_id,
            parent_version_id=request.parent_version_id,
            artifact_parent_links=[item.dict() for item in request.artifact_parent_links],
            tool_runs=[item for item in tool_runs_payload if isinstance(item, dict)],
        )
    except Exception:
        pass

    artifact_records = history.get("artifact_records") if isinstance(history, dict) else []
    if isinstance(artifact_records, list) and artifact_records:
        record_by_input_id = {
            str(item.get("artifact_input_id") or ""): item
            for item in artifact_records
            if isinstance(item, dict)
        }
        for index, artifact in enumerate(artifacts):
            matched = record_by_input_id.get(str(artifact.id or ""))
            if not matched and index < len(artifact_records) and isinstance(artifact_records[index], dict):
                matched = artifact_records[index]
            _with_history_meta(artifact, matched if isinstance(matched, dict) else None)

    return ChatResponse(
        reply=reply,
        artifacts=artifacts,
        user_id=history["user_id"],
        conversation_id=history["conversation_id"],
    )


@app.post("/api/image/refine", response_model=ImageRefineResponse)
async def refine_image(request: ImageRefineRequest) -> ImageRefineResponse:
    try:
        client = LLMClient()
    except RuntimeError:
        return ImageRefineResponse(
            reply=(
                "LLM is not configured. Set OPENAI_API_KEY, or AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY "
                "to enable generated artifacts."
            ),
            artifact=None,
            user_id=request.user_id,
            conversation_id=request.conversation_id,
        )

    payload = client.refine_image(request.dict())
    reply = str(payload.get("reply", ""))
    artifact_payload = payload.get("artifact")
    tool_runs_payload = payload.get("tool_runs") or []
    artifact: Artifact | None = None
    if isinstance(artifact_payload, dict):
        try:
            artifact = Artifact(**artifact_payload)
        except Exception:
            artifact = None
    history = {
        "user_id": request.user_id,
        "conversation_id": request.conversation_id,
    }
    try:
        history = history_store.record_image_refine_turn(
            user_id=request.user_id,
            conversation_id=request.conversation_id,
            instruction=request.instruction,
            response_reply=reply,
            artifact=artifact.dict() if artifact is not None else None,
            parent_artifact_id=request.artifact_id,
            parent_version_id=request.parent_version_id,
            request_payload=request.dict(),
            tool_runs=[item for item in tool_runs_payload if isinstance(item, dict)],
        )
    except Exception:
        pass
    if artifact is not None and isinstance(history, dict):
        _with_history_meta(artifact, history.get("artifact_record"))
    return ImageRefineResponse(
        reply=reply,
        artifact=artifact,
        user_id=history["user_id"],
        conversation_id=history["conversation_id"],
    )


@app.get("/api/history/conversations", response_model=ConversationListResponse)
async def list_conversations(user_id: str | None = None, limit: int = 50) -> ConversationListResponse:
    items = history_store.list_conversations(user_id=user_id, limit=limit)
    return ConversationListResponse(items=items)


@app.get("/api/history/conversations/{conversation_id}", response_model=ConversationDetailResponse)
async def conversation_detail(conversation_id: str) -> ConversationDetailResponse:
    payload = history_store.get_conversation_detail(conversation_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationDetailResponse(**payload)


@app.post("/api/history/artifacts/{artifact_id}/restore", response_model=ArtifactVersionRestoreResponse)
async def restore_artifact_version(
    artifact_id: str,
    request: ArtifactVersionRestoreRequest,
) -> ArtifactVersionRestoreResponse:
    restored = history_store.restore_artifact_version(
        artifact_id=artifact_id,
        version_id=request.version_id,
    )
    if restored is None:
        raise HTTPException(status_code=404, detail="Artifact or version not found")
    return ArtifactVersionRestoreResponse(**restored)


@app.post("/api/code/simulate", response_model=CodeSimulateResponse)
async def simulate_code(request: CodeSimulateRequest) -> CodeSimulateResponse:
    code = str(request.code or "")
    language = str(request.language or "text").strip().lower()
    if not code.strip():
        return CodeSimulateResponse(
            ok=False,
            language=language or "text",
            stderr="No code was provided.",
            exit_code=1,
        )

    if language in {"py", "python3"}:
        language = "python"
    elif language in {"js", "node", "javascript"}:
        language = "javascript"

    command: List[str]
    note = None

    if language == "python":
        python_bin = shutil.which("python3") or shutil.which("python")
        if not python_bin:
            return CodeSimulateResponse(
                ok=False,
                language=language,
                stderr="Python runtime is not available on the server.",
                exit_code=127,
            )
        command = [python_bin, "-I", "-c", code]
    elif language == "javascript":
        node_bin = shutil.which("node")
        if not node_bin:
            return CodeSimulateResponse(
                ok=False,
                language=language,
                stderr="Node.js runtime is not available on the server.",
                exit_code=127,
            )
        command = [node_bin, "-e", code]
    else:
        return CodeSimulateResponse(
            ok=False,
            language=language or "text",
            stderr=(
                "Simulation currently supports `python` and `javascript` code cards. "
                "Try requesting one of those languages."
            ),
            exit_code=2,
        )

    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=6,
            check=False,
            env={
                "PATH": os.environ.get("PATH", ""),
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUNBUFFERED": "1",
            },
        )
    except subprocess.TimeoutExpired:
        return CodeSimulateResponse(
            ok=False,
            language=language,
            stderr="Execution timed out after 6 seconds.",
            exit_code=124,
        )
    except Exception as exc:
        return CodeSimulateResponse(
            ok=False,
            language=language,
            stderr=f"Simulation failed to start: {exc}",
            exit_code=1,
        )

    stdout = (completed.stdout or "")[:12000]
    stderr = (completed.stderr or "")[:12000]
    if language == "python":
        note = "Executed in isolated mode (`python -I`) with a 6s timeout."
    elif language == "javascript":
        note = "Executed via Node.js with a 6s timeout."

    return CodeSimulateResponse(
        ok=completed.returncode == 0,
        language=language,
        stdout=stdout,
        stderr=stderr,
        exit_code=int(completed.returncode),
        note=note,
    )
