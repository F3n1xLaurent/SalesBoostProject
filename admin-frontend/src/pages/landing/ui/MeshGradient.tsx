import { useEffect, useRef } from 'react';

const VERT = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_colorBack;
uniform vec3 u_colorFront;

float hash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

void main() {
  float t = 0.5 * u_time;
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 shapeUV = (uv - 0.5) * vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0) * 3.2;

  for (float i = 1.0; i < 6.0; i++) {
    shapeUV.x += 0.6 / i * cos(i * 2.5 * shapeUV.y + t);
    shapeUV.y += 0.6 / i * cos(i * 1.5 * shapeUV.x + t);
  }

  float shape = 0.15 / max(0.001, abs(sin(t - shapeUV.y - shapeUV.x)));
  shape = smoothstep(0.02, 1.0, shape);
  float dither = step(hash21(gl_FragCoord.xy), shape);

  vec3 color = mix(u_colorBack, u_colorFront, dither);
  gl_FragColor = vec4(color, 1.0);
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

export function MeshGradient({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    root.prepend(canvas);

    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) {
      canvas.remove();
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return;

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'u_resolution');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uBack = gl.getUniformLocation(program, 'u_colorBack');
    const uFront = gl.getUniformLocation(program, 'u_colorFront');
    gl.uniform3f(uBack, 0.937, 0.404, 0.11);
    gl.uniform3f(uFront, 1.0, 0.776, 0.569);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let start = performance.now();
    let disposed = false;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(root.clientWidth * dpr));
      const h = Math.max(1, Math.round(root.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const draw = (now: number) => {
      if (disposed) return;
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduce ? 0 : (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    const ro = new ResizeObserver(() => {
      if (reduce) draw(start);
    });
    ro.observe(root);
    raf = requestAnimationFrame(draw);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
    };
  }, []);

  return <div ref={ref} className={className} aria-hidden />;
}
