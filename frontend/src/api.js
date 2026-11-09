const RAW_API_BASE = String(import.meta.env.VITE_API_BASE_URL || '').trim();
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');

function apiUrl(path) {
  if (!API_BASE) return path;
  return `${API_BASE}${path}`;
}

export async function fetchArtifacts() {
  const response = await fetch(apiUrl('/api/artifacts'));
  if (!response.ok) {
    throw new Error('Failed to load artifacts');
  }
  return response.json();
}

export async function loginUser(payload) {
  const response = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    let detail = 'Login failed';
    try {
      const data = await response.json();
      detail = data?.detail || detail;
    } catch (_err) {
      // noop
    }
    throw new Error(detail);
  }

  return response.json();
}

export async function sendChat(messages, options = {}) {
  const {
    userId,
    conversationId,
    parentArtifactId,
    parentVersionId,
    artifactParentLinks,
  } = options || {};
  const response = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages,
      user_id: userId || undefined,
      conversation_id: conversationId || undefined,
      parent_artifact_id: parentArtifactId || undefined,
      parent_version_id: parentVersionId || undefined,
      artifact_parent_links: Array.isArray(artifactParentLinks) ? artifactParentLinks : undefined,
    }),
  });

  if (!response.ok) {
    throw new Error('Chat request failed');
  }

  return response.json();
}

export async function refineImage(payload, options = {}) {
  const {
    userId,
    conversationId,
    artifactId,
    parentVersionId,
  } = options || {};
  const response = await fetch(apiUrl('/api/image/refine'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...payload,
      user_id: userId || payload?.user_id || undefined,
      conversation_id: conversationId || payload?.conversation_id || undefined,
      artifact_id: artifactId || payload?.artifact_id || undefined,
      parent_version_id: parentVersionId || payload?.parent_version_id || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error('Image refine request failed');
  }

  return response.json();
}

export async function simulateCode(payload) {
  const response = await fetch(apiUrl('/api/code/simulate'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error('Code simulation request failed');
  }

  return response.json();
}

export async function fetchConversationDetail(conversationId) {
  const response = await fetch(apiUrl(`/api/history/conversations/${encodeURIComponent(conversationId)}`));
  if (!response.ok) {
    throw new Error('Failed to load conversation history');
  }
  return response.json();
}

export async function restoreArtifactVersion(artifactDbId, versionId) {
  const response = await fetch(apiUrl(`/api/history/artifacts/${encodeURIComponent(artifactDbId)}/restore`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version_id: versionId }),
  });
  if (!response.ok) {
    throw new Error('Failed to restore artifact version');
  }
  return response.json();
}
