import React, { useEffect, useRef, useState } from 'react';
import { loginUser } from '../api.js';
import { API_BASE } from './workspace.js';
import { createProject } from './projects.js';
const KEY = 'research-board-session';
export function readSession() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); return s?.expiresAt > Date.now() ? s : null; } catch { return null; }
}
export async function boardRequest(path, session, method='GET', body) {
  const response = await fetch(`${API_BASE}/api/boards${path}`, {method, headers: {'Content-Type':'application/json', Authorization:`Bearer ${session?.token || ''}`}, ...(body ? {body:JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not sync board. Please retry.');
  return data;
}
export function useBoard(project, setProject, session) {
  const [status,setStatus] = useState('');
  const latest = useRef(project); latest.current = project;
  const board = project.sharedBoardId;
  useEffect(() => {
    if (!board || !session) {setStatus(board ? 'Sign in to sync' : 'Private · saved on this device');return;}
    let stopped = false, timer;
    async function sync() {
      try {
        const remote = await boardRequest(`/${board}`,session);
        const known = new Set(remote.snapshots.map(s=>s.id));
        const pending = latest.current.canvasImages.filter(s=>!known.has(s.id) && s.creator?.userId === session.userId);
        for (const snapshot of pending) {
          if(stopped)return;
          await boardRequest(`/${board}/snapshots/${snapshot.id}`,session,'PUT',snapshot);
        }
        if(stopped)return;
        setProject(prev => {
          if(prev.sharedBoardId !== board)return prev;
          const merged = new Map(prev.canvasImages.map(s=>[s.id,s]));
          remote.snapshots.forEach(s=>merged.set(s.id,s));
          const images = [...merged.values()];
          return JSON.stringify(images) === JSON.stringify(prev.canvasImages) ? prev : {...prev,canvasImages:images};
        });
        setStatus('Synced · refreshes every 3s');
      } catch(error) {if(!stopped)setStatus(error.message);}
      finally {if(!stopped)timer=setTimeout(sync,3000);}
    }
    setStatus('Syncing…');sync();
    return ()=>{stopped=true;clearTimeout(timer);};
  },[board,session,setProject]);
  async function move(id,position) {
    setProject(prev=>({...prev,canvasImages:prev.canvasImages.map(s=>s.id===id?{...s,position}:s)}));
    if(board)try {await boardRequest(`/${board}/snapshots/${id}/position`,session,'PATCH',position);}catch(error){setStatus(error.message);}
  }
  return {status,move};
}
export default function Collaboration({project,setProject,session,setSession,disabled,status,onJoin}) {
  const [open,setOpen]=useState(false), [error,setError]=useState(''), [working,setWorking]=useState(false);
  const [join,setJoin]=useState(()=>new URLSearchParams(location.search).get('board') || '');
  async function login(event) {
    event.preventDefault();setWorking(true);setError('');
    const values=Object.fromEntries(new FormData(event.currentTarget));
    try {
      const user=await loginUser(values);
      const next={userId:user.user_id,displayName:user.display_name || user.username,token:user.session_token,expiresAt:Date.parse(user.session_expires_at)};
      localStorage.setItem(KEY,JSON.stringify(next));setSession(next);setOpen(false);
    } catch(e){setError(e.message);}finally{setWorking(false);}
  }
  async function boardAction(create) {
    setWorking(true);setError('');
    try {
      const board=await boardRequest(create?'':`/${encodeURIComponent(join.trim())}`,session,create?'POST':'GET',create?{name:project.projectName}:undefined);
      setProject(prev=>create?{...prev,sharedBoardId:board.id}:{...createProject(board.name),sharedBoardId:board.id,canvasImages:board.snapshots});
      if(!create)onJoin?.();
      setJoin('');
    }catch(e){setError(e.message);}finally{setWorking(false);}
  }
  async function copy() {
    const url=new URL(location.href);url.searchParams.set('board',project.sharedBoardId);
    try {await navigator.clipboard.writeText(url.toString());setError('Invite link copied.');}catch{setError(`Board ID: ${project.sharedBoardId}`);}
  }
  return <div className="collaboration-bar">
    <div className="collaboration-identity"><span className="person-avatar">{(session?.displayName || '?').slice(0,1).toUpperCase()}</span><strong>{session?.displayName || 'Guest workspace'}</strong><button disabled={disabled || working} onClick={()=>setOpen(!open)}>{session?'Switch user':'Sign in'}</button></div>
    {open && <form className="collaboration-login" onSubmit={login}><label>Username<input name="username" required autoComplete="username"/></label><label>Display name / role<input name="display_name" placeholder="Designer Hanna"/></label><label>Password<input name="password" type="password" required autoComplete="current-password"/></label><button disabled={working} className="secondary-action">Sign in / create account</button></form>}
    <p role="status">{status}</p>
    {session && <div className="board-actions"><button disabled={disabled || working || !!project.sharedBoardId} onClick={()=>boardAction(true)}>Create shared board</button>{project.sharedBoardId && <button onClick={copy}>Copy invite link</button>}<label>Join board<input aria-label="Shared board ID" value={join} onChange={e=>setJoin(e.target.value)} placeholder="Paste board ID"/></label><button disabled={disabled || working || !join.trim()} onClick={()=>boardAction(false)}>Join</button><small>Anyone signed in with the invite can view snapshots, saved papers and briefs, and move cards. Drafts stay personal. New snapshots sync automatically.</small></div>}
    {error && <p role="status">{error}</p>}
  </div>;
}
