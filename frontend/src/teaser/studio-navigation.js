import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

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
  const requestedView = useRef(view);
  const activeTransition = useRef(null);

  const changeView = useCallback(next=>{
    if (requestedView.current === next) return;
    requestedView.current = next;
    if (typeof document.startViewTransition !== 'function' ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setView(next);
      return;
    }
    activeTransition.current?.skipTransition();
    const root = document.documentElement;
    root.dataset.studioPageTransition = '';
    const transition = document.startViewTransition(()=>{
      if (requestedView.current === next) flushSync(()=>setView(next));
    });
    activeTransition.current = transition;
    transition.ready.catch(()=>{});
    const finish = ()=>{
      if (activeTransition.current !== transition) return;
      activeTransition.current = null;
      delete root.dataset.studioPageTransition;
    };
    transition.finished.then(finish,finish);
  },[]);

  useEffect(()=>{
    const sync = ()=>changeView(readView());
    window.addEventListener('popstate',sync);
    window.addEventListener('hashchange',sync);
    return ()=>{
      window.removeEventListener('popstate',sync);
      window.removeEventListener('hashchange',sync);
      activeTransition.current?.skipTransition();
    };
  },[changeView]);

  const navigate = useCallback(next=>{
    const href = studioHref(next);
    if (href !== location.pathname + location.search + location.hash) history.pushState(null,'',href);
    changeView(next);
  },[changeView]);
  return [view,navigate];
}
