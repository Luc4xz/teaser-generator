const KEY = 'research-board-session';
export const SESSION_EXPIRED = 'research-session-expired';
export function readSession() {
  try {
    const session = JSON.parse(localStorage.getItem(KEY));
    return session?.token && session.expiresAt > Date.now() ? session : null;
  } catch { return null; }
}
export function saveSession(session) {
  if (session) localStorage.setItem(KEY, JSON.stringify(session));
  else localStorage.removeItem(KEY);
}
export function authHeaders() {
  const session = readSession();
  return session ? {Authorization: `Bearer ${session.token}`} : {};
}
export function checkSessionResponse(response) {
  if (response.status === 401 && typeof window !== 'undefined') {
    saveSession(null);
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
}
