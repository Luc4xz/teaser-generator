import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';

const STORAGE_KEY = 'research-illustration-appearance';
export const PALETTES = [
  {id:'graphite',label:'Graphite'},
  {id:'ocean',label:'Ocean'},
  {id:'forest',label:'Forest'},
  {id:'plum',label:'Plum'},
];

export function readStudioAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      mode:saved?.mode === 'dark' ? 'dark' : 'light',
      palette:PALETTES.some(({id})=>id === saved?.palette) ? saved.palette : 'graphite',
    };
  } catch {
    return {mode:'light',palette:'graphite'};
  }
}

export function applyStudioAppearance({mode,palette}) {
  const root = document.documentElement;
  root.dataset.studioMode = mode;
  root.dataset.studioPalette = palette;
}

function rippleOrigin(control) {
  const point = control?.getBoundingClientRect();
  const x = point ? point.left + point.width / 2 : window.innerWidth / 2;
  const y = point ? point.top + point.height / 2 : window.innerHeight / 2;
  const radius = Math.ceil(Math.hypot(Math.max(x,window.innerWidth-x),Math.max(y,window.innerHeight-y)));
  return {x,y,radius};
}

function setRippleOrigin(element,{x,y,radius}) {
  element.style.setProperty('--studio-ripple-x',`${x}px`);
  element.style.setProperty('--studio-ripple-y',`${y}px`);
  element.style.setProperty('--studio-ripple-end',`${radius}px`);
}

export function useStudioAppearance() {
  const [appearance,setAppearance] = useState(readStudioAppearance);
  const requested = useRef(appearance);
  const active = useRef(null);

  function changeAppearance(change,control) {
    const previous = requested.current;
    const next = {...previous,...change};
    if (previous.mode === next.mode && previous.palette === next.palette) return;
    requested.current = next;

    const root = document.documentElement;
    active.current?.skipTransition();
    active.current = null;
    delete root.dataset.studioRipple;

    function commit() {
      if (requested.current !== next) return;
      flushSync(()=>{
        applyStudioAppearance(next);
        setAppearance(next);
      });
      try { localStorage.setItem(STORAGE_KEY,JSON.stringify(next)); }
      catch { /* Keep the current appearance when browser storage is unavailable. */ }
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      commit();
      return;
    }

    const origin = rippleOrigin(control);
    if (typeof document.startViewTransition === 'function') {
      setRippleOrigin(root,origin);
      root.dataset.studioRipple = '';
      const transition = document.startViewTransition(commit);
      active.current = transition;
      transition.ready.catch(()=>{});
      const finish = ()=>{
        if (active.current !== transition) return;
        active.current = null;
        delete root.dataset.studioRipple;
      };
      transition.finished.then(finish,finish);
      return;
    }

    commit();
    const overlay = document.createElement('div');
    overlay.className = 'studio-theme-ripple-fallback';
    overlay.setAttribute('aria-hidden','true');
    setRippleOrigin(overlay,origin);
    overlay.addEventListener('animationend',()=>overlay.remove(),{once:true});
    overlay.addEventListener('animationcancel',()=>overlay.remove(),{once:true});
    document.body.append(overlay);
  }

  return [appearance,changeAppearance];
}
