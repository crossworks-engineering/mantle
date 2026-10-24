import { parseColor, rgbToOklab, type Lab, type Rgb } from './color';
import {
  DRIFT_MAX_COLORS,
  DRIFT_STYLE_RESOLUTION,
  mulberry32,
  normalizeDriftOptions,
  type DriftColor,
  type DriftOptions,
  type DriftStyle,
} from './options';
import { COMPOSITE_SHADER, VERTEX_SHADER, fieldShader } from './shaders';

/**
 * Drift — an animated gradient background engine. Framework-free on purpose:
 * the React shell and a plain-script page (the /s reader) drive the same code.
 *
 * Where the frame budget goes, and where it does not:
 *
 *  - No geometry. One fullscreen triangle per pass; every style is a pure
 *    function of (position, time). Neat displaces a 240×240 mesh per frame.
 *  - The field is computed at `resolution` × CSS size (0.2–0.35 by style:
 *    8–25× fewer pixels) into a half-float texture where available, filtered up,
 *    then dithered at output size — no banding, no visible softness, because
 *    a gradient has no detail to lose.
 *  - The output canvas is capped at `maxDpr` (1): retina buys nothing for a
 *    filter-up and costs 4× the fill.
 *  - A `low-power` opaque context: laptops stay on the integrated GPU, and the
 *    compositor skips alpha blending the layer.
 *  - Frames only while they can be seen: off-screen (IntersectionObserver),
 *    hidden tab, speed 0 and prefers-reduced-motion all stop the loop
 *    entirely — a still background renders exactly once per change.
 *  - Frame cap (30 by default) and adaptive resolution when frames run late.
 *  - Option changes are uniform writes, never a context rebuild; a style
 *    switch compiles once and is cached. `destroy` releases the context
 *    immediately rather than waiting for GC (browsers cap live contexts).
 */

export type DriftStats = {
  /** Rendered frames per second over the last second. */
  fps: number;
  /** Field texture size, px. */
  fieldWidth: number;
  fieldHeight: number;
  /** Output canvas size, px. */
  outputWidth: number;
  outputHeight: number;
  /** Current effective resolution after adaptive drops. */
  resolution: number;
  /** Whether the field texture is half-float (band-free) or 8-bit. */
  halfFloat: boolean;
  /** Whether the loop is currently scheduling frames. */
  animating: boolean;
};

export type DriftHandle = {
  /** Merge new options. Cheap: uniforms only, or one cached program swap. */
  update: (next: Partial<DriftOptions>) => void;
  /** Draw one frame now — e.g. after the page's theme changed while still. */
  redraw: () => void;
  pause: () => void;
  resume: () => void;
  destroy: () => void;
  stats: () => DriftStats;
};

type Gl = WebGLRenderingContext | WebGL2RenderingContext;

type FieldProgram = {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
};

const FIELD_UNIFORMS = [
  'u_res',
  'u_time',
  'u_scale',
  'u_warp',
  'u_soft',
  'u_light',
  'u_sat',
  'u_rot',
  'u_ptr',
  'u_bg',
  'u_col',
  'u_w',
  'u_stop',
  'u_ph',
] as const;

const COMPOSITE_UNIFORMS = [
  'u_tex',
  'u_out',
  'u_px',
  'u_grain',
  'u_gseed',
  'u_vig',
  'u_bgs',
] as const;

/** Longest side of the field texture. Past this nothing improves. */
const FIELD_MAX = 1024;

function compile(gl: Gl, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    console.error('[drift] shader:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: Gl, fragment: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    console.error('[drift] link:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function locate<T extends string>(gl: Gl, program: WebGLProgram, names: readonly T[]) {
  const out = {} as Record<T, WebGLUniformLocation | null>;
  for (const name of names) {
    // Arrays are addressed by their first element.
    out[name] =
      gl.getUniformLocation(program, name) ?? gl.getUniformLocation(program, `${name}[0]`);
  }
  return out;
}

/** Everything the field shader needs that only changes with the options. */
type Derived = {
  bg: Lab;
  bgSrgb: [number, number, number];
  col: Float32Array; // 6 × vec3
  w: Float32Array; // 6
  stop: Float32Array; // 6
  ph: Float32Array; // 6 × vec4
  timeOffset: number;
  grainSeed: number;
};

function derive(o: DriftOptions): Derived {
  const fallback: Rgb = [0, 0, 0];
  const bgRgb = parseColor(o.background) ?? fallback;
  const entries = o.colors
    .map((c) => (typeof c === 'string' ? { color: c } : c) as DriftColor)
    .map((c) => ({ rgb: parseColor(c.color), weight: Math.max(0, Math.min(2, c.weight ?? 1)) }))
    .filter((c): c is { rgb: Rgb; weight: number } => c.rgb !== null);

  const col = new Float32Array(DRIFT_MAX_COLORS * 3);
  const w = new Float32Array(DRIFT_MAX_COLORS);
  const stop = new Float32Array(DRIFT_MAX_COLORS);
  const ph = new Float32Array(DRIFT_MAX_COLORS * 4);

  // Band centres along 0..1 from cumulative weight: a heavier colour claims a
  // wider band (silk, marble), a thicker layer (dunes), a wider lane (aurora).
  const total = entries.reduce((s, e) => s + e.weight, 0) || 1;
  let cum = 0;
  entries.forEach((e, i) => {
    const lab = rgbToOklab(e.rgb);
    col.set(lab, i * 3);
    w[i] = e.weight;
    stop[i] = (cum + e.weight / 2) / total;
    cum += e.weight;
  });

  // Seeded phases. xy is a home position spread around a jittered ring so the
  // mesh never clumps; zw are rates/phases in 0..1.
  const rnd = mulberry32(o.seed);
  const n = Math.max(1, entries.length);
  const turn = rnd() * Math.PI * 2;
  for (let i = 0; i < DRIFT_MAX_COLORS; i++) {
    const a = turn + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.9;
    const r = 0.35 + rnd() * 0.5;
    ph.set([Math.cos(a) * r, Math.sin(a) * r, rnd(), rnd()], i * 4);
  }

  return {
    bg: rgbToOklab(bgRgb),
    bgSrgb: [bgRgb[0] / 255, bgRgb[1] / 255, bgRgb[2] / 255],
    col,
    w,
    stop,
    ph,
    timeOffset: rnd() * 200,
    grainSeed: Math.floor(rnd() * 1000),
  };
}

/**
 * Start a Drift background on `canvas` (sized by CSS — it fills whatever box
 * it is given). Returns null when WebGL is unavailable; the element's own
 * background colour is the designed fallback.
 */
export function createDrift(
  canvas: HTMLCanvasElement,
  initial: Partial<DriftOptions>,
): DriftHandle | null {
  let opts = normalizeDriftOptions(initial);
  let derived = derive(opts);

  const attrs: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  };
  const gl: Gl | null =
    (canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null) ??
    (canvas.getContext('webgl', attrs) as WebGLRenderingContext | null);
  if (!gl) return null;
  const isGl2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  // ---- GL resources (rebuilt on context restore) -------------------------
  let vbo: WebGLBuffer | null = null;
  let fieldTex: WebGLTexture | null = null;
  let fbo: WebGLFramebuffer | null = null;
  let composite: FieldProgram | null = null;
  const programs = new Map<DriftStyle, FieldProgram | null>();
  let halfFloat = false;
  let texType: number = gl.UNSIGNED_BYTE;
  let texInternal: number = gl.RGBA;

  function pickTextureFormat() {
    halfFloat = false;
    texType = gl!.UNSIGNED_BYTE;
    texInternal = gl!.RGBA;
    if (isGl2) {
      const g2 = gl as WebGL2RenderingContext;
      if (
        g2.getExtension('EXT_color_buffer_float') ||
        g2.getExtension('EXT_color_buffer_half_float')
      ) {
        halfFloat = true;
        texType = g2.HALF_FLOAT;
        texInternal = g2.RGBA16F;
      }
    } else {
      const hf = gl!.getExtension('OES_texture_half_float');
      const lin = gl!.getExtension('OES_texture_half_float_linear');
      const cb = gl!.getExtension('EXT_color_buffer_half_float');
      if (hf && lin && cb) {
        halfFloat = true;
        texType = hf.HALF_FLOAT_OES;
      }
    }
  }

  function program(style: DriftStyle): FieldProgram | null {
    if (programs.has(style)) return programs.get(style) ?? null;
    const p = link(gl!, fieldShader(style));
    const entry = p ? { program: p, u: locate(gl!, p, FIELD_UNIFORMS) } : null;
    programs.set(style, entry);
    return entry;
  }

  function initGl(): boolean {
    pickTextureFormat();
    vbo = gl!.createBuffer();
    gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl!.STATIC_DRAW);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 0, 0);
    const cp = link(gl!, COMPOSITE_SHADER);
    if (!cp) return false;
    composite = { program: cp, u: locate(gl!, cp, COMPOSITE_UNIFORMS) };
    fieldTex = gl!.createTexture();
    fbo = gl!.createFramebuffer();
    programs.clear();
    fieldW = 0; // force a texture allocation on next resize
    return program(opts.style) !== null;
  }

  function freeGl() {
    for (const p of programs.values()) if (p) gl!.deleteProgram(p.program);
    programs.clear();
    if (composite) gl!.deleteProgram(composite.program);
    if (vbo) gl!.deleteBuffer(vbo);
    if (fieldTex) gl!.deleteTexture(fieldTex);
    if (fbo) gl!.deleteFramebuffer(fbo);
    composite = null;
    vbo = fieldTex = fbo = null;
  }

  // ---- sizing --------------------------------------------------------------
  // Hidden BEFORE the size read below: that read forces a style pass, so the
  // first frame's opacity change has a computed 0 to transition from.
  if (opts.fadeIn > 0) {
    canvas.style.opacity = '0';
    canvas.style.transition = `opacity ${opts.fadeIn}ms ease-out`;
  }
  let cssW = canvas.clientWidth;
  let cssH = canvas.clientHeight;
  // Nothing is drawn until the box has a real size: a zero-size first layout
  // would otherwise paint a 1×1 frame and fade in one flat colour.
  const hasSize = () => cssW > 0 && cssH > 0;
  let fieldW = 0;
  let fieldH = 0;
  let adaptiveScale = 1;

  function allocField(w: number, h: number) {
    gl!.bindTexture(gl!.TEXTURE_2D, fieldTex);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, texInternal, w, h, 0, gl!.RGBA, texType, null);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, fieldTex, 0);
    if (halfFloat && gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) {
      // Advertised but not renderable on this driver: fall back to 8-bit
      // (the composite dither still hides the steps).
      halfFloat = false;
      texType = gl!.UNSIGNED_BYTE;
      texInternal = gl!.RGBA;
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, w, h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
    }
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
  }

  const baseResolution = () => opts.resolution || DRIFT_STYLE_RESOLUTION[opts.style];

  function applySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr);
    const outW = Math.max(1, Math.round(cssW * dpr));
    const outH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }
    const res = baseResolution() * adaptiveScale;
    let w = Math.max(8, Math.round(cssW * res));
    let h = Math.max(8, Math.round(cssH * res));
    const over = Math.max(w, h) / FIELD_MAX;
    if (over > 1) {
      w = Math.round(w / over);
      h = Math.round(h / over);
    }
    if (w !== fieldW || h !== fieldH) {
      fieldW = w;
      fieldH = h;
      allocField(w, h);
    }
  }

  // ---- drawing -------------------------------------------------------------
  let time = 0;
  let ptrX = 0.5;
  let ptrY = 0.5;
  let ptrStrength = 0;
  let ptrTargetX = 0.5;
  let ptrTargetY = 0.5;
  let ptrInside = false;
  let ptrClientX = Number.NaN;
  let ptrClientY = 0;

  /** Resolve the last pointer position against the canvas — once per frame,
   *  not once per pointermove (which can fire 120+ times a second, each a
   *  layout read). */
  function resolvePointer() {
    if (Number.isNaN(ptrClientX)) return;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const x = (ptrClientX - r.left) / r.width;
    const y = 1 - (ptrClientY - r.top) / r.height;
    ptrInside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    ptrTargetX = Math.min(1, Math.max(0, x));
    ptrTargetY = Math.min(1, Math.max(0, y));
  }

  function draw() {
    if (gl!.isContextLost() || !composite || !hasSize()) return;
    applySize();
    const fp = program(opts.style);
    if (!fp) return;
    const d = derived;
    const u = fp.u;

    // Pass 1: the field, small.
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.viewport(0, 0, fieldW, fieldH);
    gl!.useProgram(fp.program);
    const rad = (opts.angle * Math.PI) / 180;
    gl!.uniform2f(u.u_res!, fieldW, fieldH);
    gl!.uniform1f(u.u_time!, time + d.timeOffset);
    gl!.uniform1f(u.u_scale!, opts.scale);
    gl!.uniform1f(u.u_warp!, opts.warp);
    gl!.uniform1f(u.u_soft!, opts.softness);
    gl!.uniform1f(u.u_light!, opts.lighting);
    gl!.uniform1f(u.u_sat!, opts.saturation);
    gl!.uniform2f(u.u_rot!, Math.cos(rad), Math.sin(rad));
    gl!.uniform3f(u.u_ptr!, ptrX, ptrY, ptrStrength * opts.pointer);
    gl!.uniform3f(u.u_bg!, d.bg[0], d.bg[1], d.bg[2]);
    gl!.uniform3fv(u.u_col!, d.col);
    gl!.uniform1fv(u.u_w!, d.w);
    gl!.uniform1fv(u.u_stop!, d.stop);
    gl!.uniform4fv(u.u_ph!, d.ph);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    // Pass 2: filter up, vignette, grain, dither.
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    const c = composite;
    gl!.useProgram(c.program);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, fieldTex);
    gl!.uniform1i(c.u.u_tex!, 0);
    gl!.uniform2f(c.u.u_out!, canvas.width, canvas.height);
    gl!.uniform1f(c.u.u_px!, Math.max(1, canvas.width / Math.max(1, cssW)));
    gl!.uniform1f(c.u.u_grain!, opts.grain);
    gl!.uniform1f(c.u.u_gseed!, d.grainSeed);
    gl!.uniform1f(c.u.u_vig!, opts.vignette);
    gl!.uniform3f(c.u.u_bgs!, d.bgSrgb[0], d.bgSrgb[1], d.bgSrgb[2]);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    if (!shown) {
      shown = true;
      canvas.style.opacity = '1';
    }
  }

  // ---- scheduling ----------------------------------------------------------
  let raf = 0;
  let last = 0;
  let lastDrawn = 0;
  let paused = false;
  let destroyed = false;
  let onScreen = true;
  let shown = false;
  let fps = 0;
  let fpsWindowStart = 0;
  let fpsWindowFrames = 0;
  const lateSamples: number[] = [];
  const reducedQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  const moving = () =>
    opts.speed > 0 && !(opts.respectReducedMotion && reducedQuery?.matches === true);
  const pointerSettling = () =>
    opts.pointer > 0 &&
    (Math.abs(ptrTargetX - ptrX) > 1e-3 ||
      Math.abs(ptrTargetY - ptrY) > 1e-3 ||
      Math.abs((ptrInside ? 1 : 0) - ptrStrength) > 1e-3);
  const canRun = () =>
    !paused &&
    !destroyed &&
    onScreen &&
    document.visibilityState !== 'hidden' &&
    !gl!.isContextLost();

  function schedule() {
    if (raf || !canRun()) return;
    raf = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    raf = 0;
    if (!canRun()) return;
    const animating = moving() || pointerSettling();
    const minGap = 1000 / opts.maxFps;
    if (animating && lastDrawn && now - lastDrawn < minGap - 2) {
      raf = requestAnimationFrame(tick);
      return;
    }
    // Cap the step so a long pause (hidden tab, off-screen) resumes in place
    // instead of lurching forward.
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    if (moving()) time += dt * opts.speed;
    if (opts.pointer > 0) {
      resolvePointer();
      const k = Math.min(1, dt * 5);
      ptrX += (ptrTargetX - ptrX) * k;
      ptrY += (ptrTargetY - ptrY) * k;
      ptrStrength += ((ptrInside ? 1 : 0) - ptrStrength) * k;
    }
    if (animating && opts.adaptive && lastDrawn) adapt(now - lastDrawn, minGap);
    lastDrawn = now;
    draw();
    countFps(now);
    if (moving() || pointerSettling()) raf = requestAnimationFrame(tick);
    else last = 0;
  }

  function countFps(now: number) {
    if (!fpsWindowStart) fpsWindowStart = now;
    fpsWindowFrames++;
    if (now - fpsWindowStart >= 1000) {
      fps = Math.round((fpsWindowFrames * 1000) / (now - fpsWindowStart));
      fpsWindowStart = now;
      fpsWindowFrames = 0;
    }
  }

  /** Frames consistently late → shrink the field. Never grows back within a
   *  session: oscillating quality is worse than a slightly softer field. */
  function adapt(gap: number, target: number) {
    lateSamples.push(gap);
    if (lateSamples.length < 45) return;
    lateSamples.sort((a, b) => a - b);
    const median = lateSamples[Math.floor(lateSamples.length / 2)] ?? 0;
    lateSamples.length = 0;
    // Late against the cap AND against a 60Hz display's natural cadence.
    if (median > Math.max(target, 16.7) * 1.4 && baseResolution() * adaptiveScale > 0.12) {
      adaptiveScale *= 0.8;
    }
  }

  /** Paint now if nothing is scheduled (a still background after a change). */
  function redraw() {
    if (!canRun()) return;
    if (raf) return; // the running loop will pick it up
    raf = requestAnimationFrame(tick);
  }

  // ---- observers -----------------------------------------------------------
  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect;
          if (!box) return;
          cssW = box.width;
          cssH = box.height;
          redraw();
        })
      : null;
  resizeObserver?.observe(canvas);

  const intersection =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          onScreen = entries[0]?.isIntersecting ?? true;
          if (onScreen) schedule();
        })
      : null;
  intersection?.observe(canvas);

  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') schedule();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onReducedChange = () => redraw();
  reducedQuery?.addEventListener?.('change', onReducedChange);

  const onPointerMove = (e: PointerEvent) => {
    ptrClientX = e.clientX;
    ptrClientY = e.clientY;
    // A first move after a still period needs a frame to start settling.
    if (!raf) {
      resolvePointer();
      redraw();
    }
  };
  const onPointerLeave = () => {
    ptrClientX = Number.NaN;
    ptrInside = false;
    redraw();
  };
  let pointerBound = false;
  function bindPointer() {
    const want = opts.pointer > 0;
    if (want === pointerBound) return;
    pointerBound = want;
    if (want) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onPointerLeave);
    } else {
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    }
  }

  const onLost = (e: Event) => {
    e.preventDefault(); // ask for a restore
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const onRestored = () => {
    if (destroyed) return;
    initGl();
    redraw();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    resizeObserver?.disconnect();
    intersection?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    reducedQuery?.removeEventListener?.('change', onReducedChange);
    opts = { ...opts, pointer: 0 };
    bindPointer();
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    freeGl();
    // Free the context now — browsers cap live contexts (~16) and only
    // reclaim abandoned ones at GC.
    gl!.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // ---- start ---------------------------------------------------------------
  if (!initGl()) {
    // A shader that will not compile here: release the observers, listeners
    // and context too, not just the GL objects.
    destroy();
    return null;
  }
  bindPointer();
  redraw();

  return {
    update(next) {
      const prev = opts;
      opts = normalizeDriftOptions({ ...opts, ...next });
      if (next.colors !== undefined || next.background !== undefined || next.seed !== undefined) {
        derived = derive(opts);
      }
      if (prev.resolution !== opts.resolution || prev.style !== opts.style) adaptiveScale = 1;
      bindPointer();
      redraw();
    },
    redraw,
    pause() {
      paused = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    },
    resume() {
      paused = false;
      redraw();
    },
    destroy,
    stats: () => ({
      fps: raf ? fps : 0,
      fieldWidth: fieldW,
      fieldHeight: fieldH,
      outputWidth: canvas.width,
      outputHeight: canvas.height,
      resolution: baseResolution() * adaptiveScale,
      halfFloat,
      animating: raf !== 0,
    }),
  };
}
