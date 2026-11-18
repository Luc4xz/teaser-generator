import React, { useEffect, useState } from 'react';
import { loginUser } from '../api.js';
import { API_BASE } from './workspace.js';
import { readSession, saveSession, SESSION_EXPIRED } from './session.js';
import { withRequestTimeout } from './request-timeout.js';

export default function AuthGate({children}) {
  const [session, setSession] = useState(readSession);
  const [verified, setVerified] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  function updateSession(next) { saveSession(next); setVerified(false); setWorking(false); setSession(next); }
  useEffect(() => {
    const expire = () => { updateSession(null); setError('Your session expired. Sign in to continue.'); };
    window.addEventListener(SESSION_EXPIRED, expire);
    const timer = setInterval(() => { if (session && session.expiresAt <= Date.now()) expire(); }, 1000);
    return () => { clearInterval(timer); window.removeEventListener(SESSION_EXPIRED, expire); };
  }, [session]);
  useEffect(() => {
    if (!session) return;
    let active = true;
    setWorking(true); setError('');
    withRequestTimeout(signal=>fetch(`${API_BASE}/api/auth/session`, {headers:{Authorization:`Bearer ${session.token}`},signal}))
      .then(response => {
        if (!active) return;
        if (response.status === 401) { updateSession(null); return; }
        if (!response.ok) throw new Error('Could not verify your session. Please retry.');
        setVerified(true);
      }).catch(failure=>{
        if (active) setError(failure instanceof TypeError ? 'Could not reach the sign-in server. Check your connection and retry.' : failure.message);
      })
      .finally(() => { if (active) setWorking(false); });
    return () => { active = false; };
  }, [session, attempt]);
  async function login(event) {
    event.preventDefault(); setWorking(true); setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const user = await withRequestTimeout(signal=>loginUser(values,signal));
      updateSession({userId:user.user_id, username:user.username, displayName:user.display_name || user.username, token:user.session_token, expiresAt:Date.parse(user.session_expires_at)});
    } catch (failure) {
      setError(failure instanceof TypeError || failure instanceof SyntaxError
        ? 'Could not reach the sign-in server. Check your connection and retry.' : failure.message);
    }
    finally { setWorking(false); }
  }
  if (session && verified) return children(session, updateSession);
  return <main className="auth-screen"><section className="auth-card" aria-labelledby="auth-heading">
    <span className="auth-step">01 / SIGN IN</span><h1 id="auth-heading">Illustrate your paper</h1>
    <p>{new URLSearchParams(location.search).has('board')
      ? 'Sign in to join the shared board.' : 'Sign in to upload your paper, shape its concept, and create illustrations.'}</p>
    {session ? <div><p role="status">{working ? 'Checking your session…' : 'Session verification required.'}</p><button className="generate-button" disabled={working} onClick={()=>setAttempt(value=>value+1)}>Retry connection</button><button className="secondary-action" onClick={()=>updateSession(null)}>Use another account</button></div> :
      <form className="collaboration-login" onSubmit={login}><fieldset disabled={working}>
        <label>Username<input name="username" required autoComplete="username" autoFocus/></label>
        <label>Display name / role <span>(optional)</span><input name="display_name" autoComplete="nickname" placeholder="Designer Hanna"/></label>
        <label>Password<input name="password" type="password" required autoComplete="current-password"/></label>
        <button className="generate-button" type="submit">{working ? 'Signing in…' : 'Sign in / create account'}</button>
      </fieldset></form>}
    {error && <p className="workspace-notice" role="alert">{error}</p>}
  </section></main>;
}
