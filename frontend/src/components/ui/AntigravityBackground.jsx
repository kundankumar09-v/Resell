import { useEffect, useRef } from 'react';

const PALETTE = [
  [102, 113, 248],
  [246, 73, 107],
  [139, 92, 246],
  [6, 182, 212],
  [249, 115, 22],
  [236, 72, 153],
  [16, 185, 129],
];

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function createParticle(w, h, initial) {
  const type = Math.random() < 0.3 ? 'dash' : 'dot';
  return {
    x: rand(0, w),
    y: initial ? rand(0, h) : h + rand(10, 60),
    depth: rand(0.25, 1),
    size:
      type === 'dot'
        ? rand(1.2, 4)
        : rand(7, 22),
    thickness: rand(1, 2.4),
    angle: rand(-0.5, 0.5) + (Math.random() < 0.5 ? -0.35 : 0.35),
    spin: rand(-0.0004, 0.0004),
    vy: rand(0.08, 0.45) * rand(0.5, 1),
    vx: rand(-0.12, 0.12),
    swayAmp: rand(8, 30),
    swayFreq: rand(0.0004, 0.0012),
    phase: rand(0, Math.PI * 2),
    twinkleSpeed: rand(0.0006, 0.002),
    color: pick(PALETTE),
    opacity: rand(0.18, 0.65),
    type,
  };
}

export default function AntigravityBackground({
  className = '',
  density = 1,
  interactive = true,
}) {
  const canvasRef = useRef(null);
  const mouse = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let particles = [];
    let raf = 0;
    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const area = w * h;
      const base = window.innerWidth < 768 ? 26000 : 16000;
      const count = Math.min(140, Math.max(28, Math.round(area / base))) * density;
      particles = Array.from({ length: count }, () => createParticle(w, h, true));
    };

    const onMouseMove = (e) => {
      mouse.current.tx = e.clientX / window.innerWidth;
      mouse.current.ty = e.clientY / window.innerHeight;
    };

    let last = performance.now();

    const draw = (now) => {
      const dt = Math.min(now - last, 50);
      last = now;

      // ease mouse for smooth parallax
      mouse.current.x += (mouse.current.tx - mouse.current.x) * 0.04;
      mouse.current.y += (mouse.current.ty - mouse.current.y) * 0.04;
      const px = (mouse.current.x - 0.5) * 2;
      const py = (mouse.current.y - 0.5) * 2;

      ctx.clearRect(0, 0, w, h);

      for (const p of particles) {
        p.phase += p.swayFreq * dt;
        p.y -= p.vy * p.depth * dt * 0.06 * 16;
        p.x += p.vx * p.depth * dt * 0.06 * 16 + Math.cos(p.phase) * 0.15 * p.depth;
        if (p.angle !== undefined) p.angle += p.spin * dt;

        if (p.y < -40) {
          Object.assign(p, createParticle(w, h, false));
          continue;
        }
        if (p.x < -60) p.x = w + 40;
        if (p.x > w + 60) p.x = -40;

        const twinkle = 0.55 + 0.45 * Math.sin(now * p.twinkleSpeed + p.phase * 3);
        const alpha = p.opacity * twinkle;
        const parX = interactive ? px * 26 * p.depth : 0;
        const parY = interactive ? py * 18 * p.depth : 0;
        const x = p.x + parX;
        const y = p.y + parY;

        ctx.save();
        ctx.globalAlpha = alpha;
        if (p.type === 'dot') {
          ctx.fillStyle = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size * p.depth, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.translate(x, y);
          ctx.rotate(p.angle);
          ctx.strokeStyle = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
          ctx.lineWidth = p.thickness;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-p.size / 2, 0);
          ctx.lineTo(p.size / 2, 0);
          ctx.stroke();
        }
        ctx.restore();
      }

      raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    if (!coarse && !reduced && interactive) {
      window.addEventListener('mousemove', onMouseMove, { passive: true });
    }
    if (reduced) {
      draw(performance.now());
      cancelAnimationFrame(raf);
    } else {
      raf = requestAnimationFrame(draw);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, [density, interactive]);

  return (
    <div
      className={`pointer-events-none overflow-hidden ${className}`}
      aria-hidden="true"
    >
      {/* soft atmosphere blobs */}
      <div className="absolute inset-0">
        <div className="ag-blob ag-blob-1" />
        <div className="ag-blob ag-blob-2" />
        <div className="ag-blob ag-blob-3" />
        <div className="ag-blob ag-blob-4" />
      </div>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* vignette to keep edges soft */}
      <div
        className="absolute inset-0"
        style={{
          background: 'var(--rs-vignette, radial-gradient(ellipse at center, transparent 55%, rgba(250,250,252,0.9) 100%))',
        }}
      />
    </div>
  );
}
