import React, { useEffect, useRef, useState } from 'react';
import { API_BASE } from './workspace.js';
import { createProject } from './projects.js';
import { readSession, checkSessionResponse } from './session.js';
import { parseBoardInvite } from './board-invite.js';
import { withRequestTimeout } from './request-timeout.js';
import StudioFoldMark from './StudioFoldMark.jsx';
import Icon from './StudioIcon.jsx';
export { readSession };
const EMPTY_REVIEW_STATE = {members:[], reviews:[]};
export function boardRequest(path, session, method='GET', body) {
  return withRequestTimeout(async signal=>{
    let response;
    try {
      response = await fetch(`${API_BASE}/api/boards${path}`, {method, signal, headers: {'Content-Type':'application/json', Authorization:`Bearer ${session?.token || ''}`}, ...(body ? {body:JSON.stringify(body)} : {})});
    } catch {
      throw new Error('Could not reach the board server. Check your connection and try again.');
    }
    checkSessionResponse(response);
    const data = await response.json().catch(()=>{
      throw new Error('The board service is unavailable at this app address. Check that you opened the correct app.');
    });
    if (!response.ok) throw Object.assign(
      new Error(typeof data?.detail === 'string' ? data.detail : 'Could not sync board. Please retry.'),
      {status:response.status},
    );
    return data;
  });
}
export function useBoard(project, setProject, session) {
  const [status,setStatus] = useState('');
  const [reviewState,setReviewState] = useState(EMPTY_REVIEW_STATE);
  const latest = useRef(project); latest.current = project;
  const moveQueues = useRef(new Map());
  const reviewRevision = useRef(0);
  const board = project.sharedBoardId;
  useEffect(() => {
    if (!board || !session) {setStatus(board ? 'Sign in to sync' : 'Private · saved on this device');return;}
    let stopped = false, timer;
    async function sync() {
      try {
        const queueAtStart = moveQueues.current.get(board);
        const savingAtStart = queueAtStart?.pending;
        const reviewAtStart = reviewRevision.current;
        const remote = await boardRequest(`/${board}`,session);
        if(stopped)return;
        if (reviewAtStart === reviewRevision.current) {
          setReviewState({board,members:remote.members || [],reviews:remote.reviews || []});
        }
        const known = new Set(remote.snapshots.map(s=>s.id));
        const pending = latest.current.canvasImages.filter(s=>!known.has(s.id) && s.creator?.userId === session.userId);
        for (const snapshot of pending) {
          if(stopped)return;
          await boardRequest(`/${board}/snapshots/${snapshot.id}`,session,'PUT',snapshot);
        }
        if(stopped)return;
        // A read that overlaps a write may report the card's previous position.
        if (queueAtStart !== moveQueues.current.get(board) || savingAtStart) return;
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
  async function createSharedBoard() {
    const created = await boardRequest('',session,'POST',{name:project.projectName});
    setProject(previous=>previous.projectId === project.projectId && !previous.sharedBoardId
      ? {...previous,sharedBoardId:created.id} : previous);
    return created.id;
  }
  async function changeReview(snapshot, suffix, details) {
    if (!board) throw new Error('Create or join a shared board to request a review.');
    const path = `/${encodeURIComponent(board)}/snapshots/${encodeURIComponent(snapshot.id)}`;
    reviewRevision.current++;
    try {
      if (suffix === '') await boardRequest(path,session,'PUT',snapshot);
      const review = await boardRequest(`${path}/review${suffix}`,session,'POST',details);
      if (latest.current.sharedBoardId === board) {
        setReviewState(previous=>({
          board,
          members:previous.board === board ? previous.members : [],
          reviews:[review,...(previous.board === board ? previous.reviews.filter(item=>item.snapshotId !== snapshot.id) : [])],
        }));
      }
      return review;
    } finally {
      reviewRevision.current++;
    }
  }
  function moveMany(moves) {
    if (!moves.length) return;
    const positions = new Map(moves.map(({id,position})=>[id,position]));
    setProject(prev=>prev.projectId !== project.projectId ? prev : {
      ...prev,canvasImages:prev.canvasImages.map(item=>positions.has(item.id) ? {...item,position:positions.get(item.id)} : item),
    });
    if (!board) return;
    const previous = moveQueues.current.get(board);
    const queue = {pending:true};
    moveQueues.current.set(board,queue);
    queue.task = Promise.resolve(previous?.task).then(async()=>{
      for (const {id,position} of moves) {
        const path = `/${board}/snapshots/${encodeURIComponent(id)}`;
        try {
          await boardRequest(`${path}/position`,session,'PATCH',position);
        } catch (error) {
          const snapshot = project.canvasImages.find(item=>item.id === id && item.creator?.userId === session.userId);
          if (error.status === 404 && snapshot) {
            try {
              await boardRequest(path,session,'PUT',{...snapshot,position});
              await boardRequest(`${path}/position`,session,'PATCH',position);
              continue;
            } catch (retryError) { error = retryError; }
          }
          if (latest.current.sharedBoardId === board) setStatus(error.message);
        }
      }
    }).finally(()=>{queue.pending=false;});
  }
  const currentReviews = reviewState.board === board ? reviewState : EMPTY_REVIEW_STATE;
  return {status,moveMany,createSharedBoard,changeReview,...currentReviews};
}
export async function copyBoardInvite(board) {
  const url = new URL(location.href);
  url.searchParams.set('board',board);
  url.hash='';
  await navigator.clipboard.writeText(url.toString());
}

export default function Collaboration({project,setProject,session,setSession,disabled,status,onJoin,onCreateBoard}) {
  const [join,setJoin]=useState(()=>new URLSearchParams(location.search).get('board') || '');
  const [open,setOpen]=useState(()=>Boolean(join));
  const [message,setMessage]=useState(''), [error,setError]=useState(''), [action,setAction]=useState(null);
  const working = action !== null;
  const container = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    function dismissOutside(event) {
      if (!container.current?.contains(event.target)) setOpen(false);
    }
    function dismissOnEscape(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  async function boardAction(inviteId) {
    setAction(inviteId ? 'join' : 'create');setMessage('');setError('');
    try {
      if (!inviteId) await onCreateBoard();
      else {
        const board = await boardRequest(`/${encodeURIComponent(inviteId)}`,session);
        const url = new URL(location.href);
        if (url.searchParams.has('board')) {
          url.searchParams.delete('board');
          history.replaceState(history.state,'',url);
        }
        const switched = project.sharedBoardId !== board.id;
        if (switched) setProject({...createProject(board.name),sharedBoardId:board.id,canvasImages:board.snapshots});
        onJoin?.(switched);
        setJoin('');
        setMessage(`Opened ${board.name}.`);
      }
    } catch (failure) {
      setError(inviteId && failure.status === 404
        ? 'Board not found on this server. Open the invite in the same app where the board was created, or ask the owner for a current invite.'
        : failure.message);
    } finally { setAction(null); }
  }
  async function copy() {
    setMessage('');setError('');
    try {await copyBoardInvite(project.sharedBoardId);setMessage('Invite link copied.');}
    catch {setError('Could not copy the invite link. You can copy the board ID above.');}
  }
  return <div className="collaboration-menu" ref={container} onBlur={event=>{
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" className="new-project-button collaboration-toggle" ref={trigger} aria-label="Collaboration" title="Collaboration"
      aria-expanded={open} aria-controls="collaboration-panel" onClick={()=>setOpen(value=>!value)}>
      <Icon name="people" size={15}/><span className="studio-topbar-label">Collaboration</span><StudioFoldMark open={open}/>
    </button>
    <div className="collaboration-panel" id="collaboration-panel" hidden={!open}>
      <div className="collaboration-identity">
        <span className="person-avatar" aria-hidden="true">{(session?.displayName || '?').slice(0,1).toUpperCase()}</span>
        <strong>{session?.displayName || 'Guest workspace'}</strong>
        <button type="button" disabled={disabled || working} onClick={()=>setSession(null)}>Switch user</button>
      </div>
      <p role="status">{status}</p>
      {project.sharedBoardId ? <div className="board-share">
        <label>Board ID<input readOnly value={project.sharedBoardId} onFocus={event=>event.target.select()}/></label>
        <button type="button" onClick={copy}>Copy invite link</button>
      </div> : <div className="board-share">
        <button type="button" disabled={disabled || working} onClick={()=>boardAction()}>{action === 'create' ? 'Creating board…' : 'Create shared board'}</button>
      </div>}
      <form className="board-join" onSubmit={event=>{
        event.preventDefault();
        if (disabled || working || !join.trim()) return;
        const id = parseBoardInvite(join,location.origin);
        if (id) boardAction(id);
        else {setMessage('');setError('Paste a board ID or an invite link that contains a board ID.');}
      }}>
        <label>Join another board<input value={join} disabled={working} onChange={event=>{setJoin(event.target.value);setError('');}} placeholder="Paste board ID or invite link"/></label>
        <button type="submit" aria-busy={action === 'join'} disabled={disabled || working || !join.trim()}>{action === 'join' ? 'Joining…' : 'Join'}</button>
      </form>
      <p>Anyone signed in with the invite can view snapshots, saved papers and briefs, and move cards. Drafts stay personal.</p>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}
