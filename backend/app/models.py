from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class AuthLoginRequest(BaseModel):
    username: Optional[str] = None
    email: Optional[str] = None
    password: str
    display_name: Optional[str] = None


class AuthLoginResponse(BaseModel):
    ok: bool = True
    user_id: str
    username: str
    email: Optional[str] = None
    display_name: str
    session_expires_at: str
    expires_in_seconds: int


class ArtifactParentLink(BaseModel):
    artifact_id: str
    parent_artifact_id: Optional[str] = None
    parent_version_id: Optional[str] = None


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(default_factory=list)
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None
    parent_artifact_id: Optional[str] = None
    parent_version_id: Optional[str] = None
    artifact_parent_links: List[ArtifactParentLink] = Field(default_factory=list)


class Artifact(BaseModel):
    id: str
    name: str
    type: Literal["html", "image", "text", "code"]
    description: Optional[str] = None
    code: Optional[str] = None
    image: Optional[str] = None
    text: Optional[str] = None
    language: Optional[str] = None
    prompt: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None


class ChatResponse(BaseModel):
    reply: str
    artifacts: List[Artifact] = Field(default_factory=list)
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None


class ArtifactListResponse(BaseModel):
    items: List[Artifact]


class ImageRefineRequest(BaseModel):
    image: str
    mask: str
    instruction: str
    base_prompt: Optional[str] = None
    size: Optional[str] = None
    selections: Optional[Dict[str, str]] = None
    controls: Optional[List[Dict[str, Any]]] = None
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None
    artifact_id: Optional[str] = None
    parent_version_id: Optional[str] = None


class ImageRefineResponse(BaseModel):
    reply: str
    artifact: Optional[Artifact] = None
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None


class ArtifactVersionRestoreRequest(BaseModel):
    version_id: str


class ArtifactVersionRestoreResponse(BaseModel):
    ok: bool = True
    artifact_id: str
    logical_key: str
    version_id: str
    version_number: int
    parent_version_id: Optional[str] = None
    conversation_id: str
    snapshot: Dict[str, Any] = Field(default_factory=dict)


class CodeSimulateRequest(BaseModel):
    code: str
    language: Optional[str] = None


class CodeSimulateResponse(BaseModel):
    ok: bool
    language: str
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    note: Optional[str] = None


class ConversationSummary(BaseModel):
    id: str
    user_id: str
    title: Optional[str] = None
    created_at: str
    updated_at: str
    message_count: int = 0
    artifact_count: int = 0


class ConversationListResponse(BaseModel):
    items: List[ConversationSummary] = Field(default_factory=list)


class MessageRecord(BaseModel):
    id: str
    seq: int
    role: str
    content: str
    source: str
    created_at: str
    meta: Dict[str, Any] = Field(default_factory=dict)


class ArtifactVersionRecord(BaseModel):
    id: str
    version_number: int
    message_id: Optional[str] = None
    parent_version_id: Optional[str] = None
    operation: str
    prompt: Optional[str] = None
    code: Optional[str] = None
    image: Optional[str] = None
    text: Optional[str] = None
    created_at: str
    meta: Dict[str, Any] = Field(default_factory=dict)


class ToolRunRecord(BaseModel):
    id: str
    tool_name: str
    args_hash: str
    status: str
    latency_ms: int = 0
    output_summary: Optional[str] = None
    created_at: str
    message_id: Optional[str] = None
    meta: Dict[str, Any] = Field(default_factory=dict)


class ArtifactRecord(BaseModel):
    id: str
    logical_key: str
    type: str
    name: str
    description: Optional[str] = None
    language: Optional[str] = None
    latest_version_number: int
    created_at: str
    updated_at: str
    meta: Dict[str, Any] = Field(default_factory=dict)
    versions: List[ArtifactVersionRecord] = Field(default_factory=list)


class ConversationRecord(BaseModel):
    id: str
    user_id: str
    title: Optional[str] = None
    created_at: str
    updated_at: str
    meta: Dict[str, Any] = Field(default_factory=dict)


class ConversationDetailResponse(BaseModel):
    conversation: ConversationRecord
    messages: List[MessageRecord] = Field(default_factory=list)
    artifacts: List[ArtifactRecord] = Field(default_factory=list)
    tool_runs: List[ToolRunRecord] = Field(default_factory=list)
