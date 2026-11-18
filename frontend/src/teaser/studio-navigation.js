import { useCallback, useEffect, useState } from 'react';

const VIEW_HASHES = {
  workspace: '',
  controlCenter: '#control-center',
  history: '#control-center/history',
  chat: '#ai-chat',
};

function readView() {
  return Object.keys(VIEW_HASHES).find(view=>VIEW_HASHES[view] === location.hash) || 'workspace';
}

export function studioHref(view) {
  return location.pathname + location.search + VIEW_HASHES[view];
}

export function useStudioView() {
  const [view,setView] = useState(readView);
  useEffect(()=>{
    const sync = ()=>setView(readView());
    window.addEventListener('popstate',sync);
    window.addEventListener('hashchange',sync);
    return ()=>{
      window.removeEventListener('popstate',sync);
      window.removeEventListener('hashchange',sync);
    };
  },[]);

  const navigate = useCallback(next=>{
    const href = studioHref(next);
    if (href !== location.pathname + location.search + location.hash) history.pushState(null,'',href);
    setView(next);
  },[]);
  return [view,navigate];
}
