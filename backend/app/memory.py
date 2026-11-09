from __future__ import annotations

import math
import re
from typing import Any, Dict, List


TOKEN_RE = re.compile(r"[a-zA-Z0-9]{2,}")
WHITESPACE_RE = re.compile(r"\s+")
REVISION_SCAFFOLD_RE = re.compile(r"(?is)\brevision mode constraints:\b.*$")

STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "have",
    "how",
    "i",
    "if",
    "in",
    "is",
    "it",
    "its",
    "me",
    "my",
    "of",
    "on",
    "or",
    "our",
    "that",
    "the",
    "their",
    "them",
    "there",
    "they",
    "this",
    "to",
    "we",
    "with",
    "you",
    "your",
}

DOMAIN_KEYWORDS = {
    "chart": {
        "chart",
        "graph",
        "plot",
        "dashboard",
        "bar",
        "line",
        "scatter",
        "axis",
        "axes",
        "legend",
        "tooltip",
        "sales",
        "kpi",
    },
    "code": {
        "code",
        "javascript",
        "python",
        "function",
        "script",
        "snippet",
        "factorial",
        "refactor",
        "algorithm",
        "validation",
    },
    "weather": {
        "weather",
        "forecast",
        "temperature",
        "rain",
        "precipitation",
        "humidity",
        "wind",
        "seattle",
        "daily",
        "weekly",
    },
    "text": {
        "text",
        "summary",
        "bullet",
        "bullets",
        "tone",
        "professional",
        "rewrite",
        "shorter",
        "longer",
        "concise",
    },
    "image": {
        "image",
        "photo",
        "portrait",
        "illustration",
        "style",
        "lighting",
        "mood",
        "edit",
        "mask",
        "inpaint",
    },
}


def _normalize_text(value: Any) -> str:
    return WHITESPACE_RE.sub(" ", str(value or "")).strip()


def _truncate(value: str, limit: int) -> str:
    text = _normalize_text(value)
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return f"{text[:limit - 3]}..."


def _tokenize(text: str) -> List[str]:
    tokens = [token.lower() for token in TOKEN_RE.findall(str(text or "").lower())]
    return [token for token in tokens if token not in STOPWORDS]


def _strip_revision_scaffold(text: str) -> str:
    source = str(text or "")
    stripped = REVISION_SCAFFOLD_RE.sub("", source)
    return _normalize_text(stripped)


def _detect_domain(text: str) -> str:
    tokens = set(_tokenize(text))
    if not tokens:
        return "general"
    scores: Dict[str, int] = {}
    for domain, keywords in DOMAIN_KEYWORDS.items():
        scores[domain] = len(tokens.intersection(keywords))

    # Bridge intent: requests like "text summary of chart trends" should route to chart,
    # not generic text, so relevant chart branches are eligible.
    if scores.get("text", 0) > 0:
        for preferred in ("chart", "code", "weather", "image"):
            if scores.get(preferred, 0) > 0:
                return preferred

    best_domain = "general"
    best_score = 0
    for domain, score in scores.items():
        if score > best_score:
            best_score = score
            best_domain = domain
    return best_domain if best_score > 0 else "general"


def _term_freq(tokens: List[str]) -> Dict[str, float]:
    tf: Dict[str, float] = {}
    if not tokens:
        return tf
    inv = 1.0 / len(tokens)
    for token in tokens:
        tf[token] = tf.get(token, 0.0) + inv
    return tf


def _inverse_doc_freq(tokenized_docs: List[List[str]]) -> Dict[str, float]:
    doc_count = max(1, len(tokenized_docs))
    freq: Dict[str, int] = {}
    for doc in tokenized_docs:
        for token in set(doc):
            freq[token] = freq.get(token, 0) + 1
    return {
        token: math.log((1.0 + doc_count) / (1.0 + count)) + 1.0
        for token, count in freq.items()
    }


def _tfidf_vector(tokens: List[str], idf: Dict[str, float]) -> Dict[str, float]:
    tf = _term_freq(tokens)
    return {token: value * idf.get(token, 1.0) for token, value in tf.items()}


def _cosine_similarity(left: Dict[str, float], right: Dict[str, float]) -> float:
    if not left or not right:
        return 0.0
    dot = 0.0
    for token, value in left.items():
        dot += value * right.get(token, 0.0)
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    if left_norm <= 0.0 or right_norm <= 0.0:
        return 0.0
    return dot / (left_norm * right_norm)


def extract_latest_user_message(messages: List[Dict[str, Any]]) -> str:
    for message in reversed(messages):
        if str(message.get("role") or "").strip().lower() == "user":
            return _normalize_text(message.get("content"))
    return ""


def _build_qa_branches(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    branches: List[Dict[str, Any]] = []
    pending_user: Dict[str, Any] | None = None

    for message in messages:
        role = str(message.get("role") or "").strip().lower()
        content = _normalize_text(message.get("content"))
        if not content:
            continue

        if role == "user":
            if pending_user is not None:
                branches.append(
                    {
                        "user_id": str(pending_user.get("id") or ""),
                        "assistant_id": "",
                        "user_seq": int(pending_user.get("seq") or 0),
                        "assistant_seq": 0,
                        "user": _normalize_text(pending_user.get("content")),
                    "assistant": "",
                    "source": str(pending_user.get("source") or ""),
                    "domain": _detect_domain(_normalize_text(pending_user.get("content"))),
                }
            )
            pending_user = message
            continue

        if role == "assistant" and pending_user is not None:
            branches.append(
                {
                    "user_id": str(pending_user.get("id") or ""),
                    "assistant_id": str(message.get("id") or ""),
                    "user_seq": int(pending_user.get("seq") or 0),
                    "assistant_seq": int(message.get("seq") or 0),
                    "user": _normalize_text(pending_user.get("content")),
                    "assistant": content,
                    "source": str(message.get("source") or pending_user.get("source") or ""),
                    "domain": _detect_domain(f"{_normalize_text(pending_user.get('content'))} {content}"),
                }
            )
            pending_user = None

    if pending_user is not None:
        branches.append(
            {
                "user_id": str(pending_user.get("id") or ""),
                "assistant_id": "",
                "user_seq": int(pending_user.get("seq") or 0),
                "assistant_seq": 0,
                "user": _normalize_text(pending_user.get("content")),
                "assistant": "",
                "source": str(pending_user.get("source") or ""),
                "domain": _detect_domain(_normalize_text(pending_user.get("content"))),
            }
        )
    return branches


def build_localized_memory_context(
    messages: List[Dict[str, Any]],
    query_text: str,
    *,
    max_branches: int = 4,
    max_context_chars: int = 3600,
    min_score: float = 0.08,
    min_overlap: float = 0.05,
    strong_score: float = 0.24,
) -> Dict[str, Any]:
    branches = _build_qa_branches(messages)
    query = _strip_revision_scaffold(query_text)
    if not branches or not query:
        return {
            "context": "",
            "selected": [],
            "candidate_count": len(branches),
        }

    query_tokens = _tokenize(query)
    if not query_tokens:
        return {
            "context": "",
            "selected": [],
            "candidate_count": len(branches),
        }

    docs: List[List[str]] = []
    for branch in branches:
        docs.append(_tokenize(f"{branch['user']} {branch['assistant']}"))
    docs.append(query_tokens)

    idf = _inverse_doc_freq(docs)
    query_vec = _tfidf_vector(query_tokens, idf)
    query_set = set(query_tokens)
    query_domain = _detect_domain(query)

    scored: List[Dict[str, Any]] = []
    total = max(1, len(branches))
    for idx, branch in enumerate(branches):
        branch_tokens = docs[idx]
        if not branch_tokens:
            continue
        branch_vec = _tfidf_vector(branch_tokens, idf)
        cosine = _cosine_similarity(query_vec, branch_vec)
        overlap = len(query_set.intersection(set(branch_tokens))) / max(1, len(query_set))
        recency = (idx + 1) / total
        branch_domain = str(branch.get("domain") or "general")
        domain_match = query_domain == "general" or branch_domain == "general" or branch_domain == query_domain
        domain_factor = 1.0 if domain_match else 0.35
        score = ((0.72 * cosine) + (0.20 * overlap) + (0.08 * recency)) * domain_factor
        scored.append(
            {
                **branch,
                "score": score,
                "cosine": cosine,
                "overlap": overlap,
                "recency": recency,
                "domain_match": domain_match,
                "turn_index": idx + 1,
            }
        )

    scored.sort(key=lambda item: item["score"], reverse=True)
    cap = max(1, min(int(max_branches), 8))
    selected = [
        item
        for item in scored
        if (
            item["score"] >= min_score
            and (item["overlap"] >= min_overlap or item["score"] >= strong_score)
            and (
                item["domain_match"]
                or item["overlap"] >= max(min_overlap, 0.22)
                or item["score"] >= max(strong_score, 0.40)
            )
        )
    ][:cap]

    if not selected:
        return {
            "context": "",
            "selected": [],
            "candidate_count": len(branches),
            "top_score": round(float(scored[0]["score"]), 4) if scored else 0.0,
            "top_overlap": round(float(scored[0]["overlap"]), 4) if scored else 0.0,
            "query_domain": query_domain,
        }

    lines: List[str] = [
        "Localized conversation memory (relevant prior QA branches):",
        "Use only if relevant to the user's latest request. Prefer current user instruction if conflict exists.",
    ]
    for rank, item in enumerate(selected, start=1):
        lines.append(f"[Memory {rank} | turn {item['turn_index']} | relevance {item['score']:.2f}]")
        lines.append(f"User: {_truncate(item['user'], 420)}")
        assistant = _truncate(item["assistant"], 680)
        if assistant:
            lines.append(f"Assistant: {assistant}")

    context = ""
    for line in lines:
        candidate = f"{context}\n{line}".strip() if context else line
        if len(candidate) > max_context_chars:
            break
        context = candidate

    slim_selected: List[Dict[str, Any]] = []
    for item in selected:
        slim_selected.append(
            {
                "turn_index": int(item.get("turn_index") or 0),
                "score": round(float(item.get("score") or 0.0), 4),
                "user_seq": int(item.get("user_seq") or 0),
                "assistant_seq": int(item.get("assistant_seq") or 0),
                "user_id": str(item.get("user_id") or ""),
                "assistant_id": str(item.get("assistant_id") or ""),
                "source": str(item.get("source") or ""),
                "domain": str(item.get("domain") or "general"),
                "user_preview": _truncate(str(item.get("user") or ""), 120),
                "assistant_preview": _truncate(str(item.get("assistant") or ""), 120),
            }
        )

    return {
        "context": context,
        "selected": slim_selected,
        "candidate_count": len(branches),
        "top_score": round(float(scored[0]["score"]), 4) if scored else 0.0,
        "top_overlap": round(float(scored[0]["overlap"]), 4) if scored else 0.0,
        "query_domain": query_domain,
    }
