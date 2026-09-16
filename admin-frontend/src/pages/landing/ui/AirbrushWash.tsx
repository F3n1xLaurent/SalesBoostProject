import { useEffect, useRef } from 'react';

const VERT = `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;

float blob(vec2 p, vec2 c, float r) {
  vec2 d = p - c;
  return exp(-dot(d, d) / max(r * r, 0.0001));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float t = u_time;

  vec3 greige = vec3(0.820, 0.808, 0.784);
  vec3 yellow = vec3(1.000, 0.949, 0.000);
  vec3 pink = vec3(1.000, 0.714, 0.824);
  vec3 lavender = vec3(0.847, 0.784, 1.000);
  vec3 mint = vec3(0.720, 0.960, 0.940);

  vec2 yellowA = vec2(0.02 + 0.04 * sin(t * 0.18), -0.06 + 0.03 * cos(t * 0.14));
  vec2 yellowB = vec2(0.22 + 0.03 * cos(t * 0.11), -0.18 + 0.04 * sin(t * 0.16));
  vec2 pinkL = vec2(-0.42 + 0.03 * sin(t * 0.13), 0.04 + 0.03 * cos(t * 0.17));
  vec2 pinkR = vec2(0.46 + 0.03 * cos(t * 0.15), -0.02 + 0.03 * sin(t * 0.12));
  vec2 lavL = vec2(-0.52 + 0.02 * cos(t * 0.10), 0.18 + 0.02 * sin(t * 0.19));
  vec2 lavR = vec2(0.50 + 0.02 * sin(t * 0.12), 0.16 + 0.02 * cos(t * 0.11));
  vec2 mintA = vec2(-0.18 + 0.02 * sin(t * 0.21), 0.12 + 0.02 * cos(t * 0.09));

  float y = blob(p, yellowA, 0.62) * 0.95 + blob(p, yellowB, 0.48) * 0.72;
  float pk = blob(p, pinkL, 0.40) * 0.42 + blob(p, pinkR, 0.36) * 0.34;
  float lv = blob(p, lavL, 0.30) * 0.28 + blob(p, lavR, 0.26) * 0.22;
  float mn = blob(p, mintA, 0.22) * 0.12;

  vec3 col = greige;
  col = mix(col, mint, clamp(mn, 0.0, 1.0));
  col = mix(col, lavender, clamp(lv, 0.0, 1.0));
  col = mix(col, pink, clamp(pk, 0.0, 1.0));
  col = mix(col, yellow, clamp(y, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function AirbrushWash({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'u_resolution');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();
    let raf = 0;
    let disposed = false;
    let inView = true;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const draw = (now: number) => {
      raf = 0;
      if (disposed || !inView) return;
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduce ? 0 : (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    const ro = new ResizeObserver(() => {
      if (reduce) draw(start);
      else if (raf === 0) raf = requestAnimationFrame(draw);
    });
    ro.observe(canvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting ?? true;
        if (inView && raf === 0) raf = requestAnimationFrame(draw);
      },
      { rootMargin: '80px' },
    );
    io.observe(canvas.parentElement ?? canvas);
    raf = requestAnimationFrame(draw);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%' }}
      aria-hidden
    />
  );
}
