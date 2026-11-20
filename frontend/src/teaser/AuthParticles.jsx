import React, { useEffect, useRef } from 'react';

const FADE_DISTANCE = 180;
const SPACING = 7;
const JITTER = .8;
// Neighboring centers stay at least 7 - .8 - 2 * 2 = 2.2px apart,
// greater than the maximum combined particle diameter of 1.7px.
const WANDER = 2;

export default function AuthParticles() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let particles = [];
    let width = 0;
    let height = 0;
    let frame;

    function render(now = 0) {
      context.clearRect(0, 0, width, height);
      const time = reducedMotion.matches ? 0 : now / 1000;
      for (const particle of particles) {
        const { x, y, radius, fade, phase, speed } = particle;
        const dx = WANDER * (.65 * Math.sin(time * speed + phase)
          + .35 * Math.sin(time * speed * 1.73 + phase * 2));
        const dy = WANDER * (.65 * Math.cos(time * speed * .83 + phase)
          + .35 * Math.sin(time * speed * 1.37 + phase * 3));
        context.fillStyle = `rgba(0,0,0,${.95 * Math.pow(fade, .7)})`;
        context.beginPath();
        context.arc(x + dx, y + dy, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    function draw() {
      ({ width, height } = canvas.getBoundingClientRect());
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      particles = [];

      // A repeatable jittered grid guarantees separation without visible rows.
      let seed = 731;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let row = 4; row < height; row += SPACING) {
        for (let column = 4; column < width; column += SPACING) {
          const x = column + (random() - .5) * JITTER;
          const y = row + (random() - .5) * JITTER;
          const radius = .55 + random() * .3;
          const sample = random();
          const phase = random() * Math.PI * 2;
          const speed = .8 + random();
          const distance = Math.max(FADE_DISTANCE - x, x - (width - FADE_DISTANCE),
            FADE_DISTANCE - y, y - (height - FADE_DISTANCE), 0);
          if (distance === 0) continue;
          const fade = Math.max(0, 1 - distance / FADE_DISTANCE);
          if (sample > .85 * fade * fade) continue;
          particles.push({ x, y, radius, fade, phase, speed });
        }
      }
      render(performance.now());
    }

    function animate(now) {
      render(now);
      frame = requestAnimationFrame(animate);
    }

    function updateAnimation() {
      cancelAnimationFrame(frame);
      render(performance.now());
      if (!reducedMotion.matches && !document.hidden) frame = requestAnimationFrame(animate);
    }

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    window.addEventListener('resize', draw);
    draw();
    updateAnimation();
    reducedMotion.addEventListener('change', updateAnimation);
    document.addEventListener('visibilitychange', updateAnimation);
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion.removeEventListener('change', updateAnimation);
      document.removeEventListener('visibilitychange', updateAnimation);
      observer.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, []);

  return <canvas ref={canvasRef} className="auth-particles" aria-hidden="true" />;
}
