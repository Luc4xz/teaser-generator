import React, { useLayoutEffect, useRef } from 'react';

export default function AutoGrowTextarea({ value, ...props }) {
  const input = useRef(null);
  const resize = () => {
    const node = input.current;
    if (!node) return;
    const style = getComputedStyle(node);
    node.style.height = '0px';
    node.style.height = `${node.scrollHeight + parseFloat(style.borderTopWidth || 0) + parseFloat(style.borderBottomWidth || 0)}px`;
  };
  useLayoutEffect(resize, [value]);
  useLayoutEffect(() => {
    const node = input.current;
    let width = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width;
      if (next !== width) { width = next; resize(); }
    });
    observer.observe(node);
    let active = true;
    document.fonts?.ready.then(() => { if (active) resize(); });
    return () => { active = false; observer.disconnect(); };
  }, []);
  return <textarea {...props} ref={input} value={value} className="concept-auto-textarea"/>;
}
