import type { DriftStyle } from './options';

/**
 * Drift's shaders. GLSL ES 1.00 so the same source runs on a WebGL2 context
 * (preferred) and the WebGL1 fallback.
 *
 * Two passes:
 *
 *  1. FIELD — one fullscreen triangle into a small offscreen texture (a
 *     fraction of the CSS size). Every style is analytic: no geometry, no
 *     mesh, no texture reads, just a function of (position, time). Colours
 *     arrive and blend in OKLab; the pass writes display sRGB.
 *  2. COMPOSITE — the field filtered up to the canvas, then vignette, static
 *     film grain and a triangular dither. The dither is what lets a dark,
 *     slow gradient stay band-free on an 8-bit panel; it costs two hashes.
 *
 * Original work. Noise is classic gradient noise with a quintic fade; the
 * lattice hash follows Dave Hoskins' sine-free "hash without sine" (MIT).
 */

export const VERTEX_SHADER = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FIELD_HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_res;      // field buffer size, px
uniform float u_time;    // seconds x speed, offset by the seed
uniform float u_scale;
uniform float u_warp;
uniform float u_soft;
uniform float u_light;
uniform float u_sat;
uniform vec2 u_rot;      // cos, sin of the field angle
uniform vec3 u_ptr;      // pointer uv (0..1) + strength
uniform vec3 u_bg;       // OKLab
uniform vec3 u_col[6];   // OKLab
uniform float u_w[6];    // territory weight; 0 = off
uniform float u_stop[6]; // band centre along 0..1, from cumulative weights
uniform vec4 u_ph[6];    // seeded per-colour phases

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}

float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i), f);
  float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

const mat2 OCT = mat2(1.6, 1.2, -1.2, 1.6);

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * gnoise(p);
    p = OCT * p;
    a *= 0.5;
  }
  return s;
}

// Three octaves for the inner warp layers: their fine detail is smeared by
// the next layer anyway, so the fourth octave is pure cost.
float fbm3(vec2 p) {
  float s = 0.5 * gnoise(p);
  p = OCT * p;
  s += 0.25 * gnoise(p);
  p = OCT * p;
  return s + 0.125 * gnoise(p);
}

// Chroma-preserving resolve of an OKLab weighted sum. A plain average of two
// opposite hues cancels to grey; restoring the weighted mean chroma makes a
// blend pass THROUGH colour instead of through mud.
vec3 resolve(vec3 acc, float chroma, float ws) {
  vec3 lab = acc / ws;
  float c = length(lab.yz);
  lab.yz *= min((chroma / ws) / max(c, 1e-4), 2.5);
  return lab;
}

// 1-D palette: inverse-distance blend of the colours around their band
// centres. Softness is the falloff exponent — high is crisp Voronoi bands,
// low melts every colour into its neighbours. Never underflows to nothing.
vec3 ramp(float s) {
  float k = mix(4.0, 0.8, u_soft);
  vec3 acc = vec3(0.0);
  float cs = 0.0;
  float ws = 0.0;
  for (int i = 0; i < 6; i++) {
    if (u_w[i] <= 0.0) continue;
    float d = s - u_stop[i];
    float w = u_w[i] / pow(d * d + 1e-4, k);
    acc += u_col[i] * w;
    cs += length(u_col[i].yz) * w;
    ws += w;
  }
  return ws > 0.0 ? resolve(acc, cs, ws) : u_bg;
}

vec3 oklabToLinear(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

// Centred, aspect-correct, rotated. Units: one field height = 1.
vec2 place(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  return mat2(u_rot.x, u_rot.y, -u_rot.y, u_rot.x) * p;
}
`;

/*
 * Each style defines `vec3 field(vec2 p, vec2 pu, float aspect)`:
 *   p  — placed and zoomed by u_scale (features)
 *   pu — placed, not zoomed (layout: where things sit on screen)
 * and returns OKLab.
 */
const STYLES: Record<DriftStyle, string> = {
  mesh: `
vec3 field(vec2 p, vec2 pu, float aspect) {
  float t = u_time;
  // Organic, not circular: the sample point is nudged by slow noise.
  vec2 q = pu + u_warp * 0.28 * vec2(
    gnoise(pu * 1.4 + vec2(0.0, t * 0.11)),
    gnoise(pu * 1.4 + vec2(7.3, -t * 0.09)));
  float sig = mix(0.018, 0.16, u_soft) / (u_scale * u_scale);
  float ground = 0.12;
  vec3 acc = u_bg * ground;
  float cs = length(u_bg.yz) * ground;
  float ws = ground;
  for (int i = 0; i < 6; i++) {
    if (u_w[i] <= 0.0) continue;
    vec4 h = u_ph[i];
    vec2 c = h.xy * vec2(0.5 * aspect, 0.5)
      + vec2(0.24 * aspect, 0.2) * vec2(
          sin(t * (0.11 + 0.08 * h.z) + h.w * 6.2832),
          cos(t * (0.09 + 0.07 * h.w) + h.z * 6.2832));
    vec2 d = q - c;
    float w = u_w[i] * exp(-dot(d, d) / sig);
    acc += u_col[i] * w;
    cs += length(u_col[i].yz) * w;
    ws += w;
  }
  vec3 col = resolve(acc, cs, ws);
  // A whisper of depth: concentrated colour lifts, thin colour settles.
  col.x += u_light * 0.05 * (min(ws - ground, 1.5) - 0.5);
  return col;
}
`,
  silk: `
// The warp moves slowly across space, so it is computed once per pixel and
// shared by the three height taps the normal needs: 5 noise calls, not 9.
vec2 silkWarp(vec2 p, float t) {
  return u_warp * 0.7 * vec2(
    gnoise(p * 0.55 + vec2(0.0, t * 0.05)),
    gnoise(p * 0.55 + vec2(4.7, -t * 0.04)));
}

float height(vec2 q, float t) {
  return sin(dot(q, vec2(4.2, 1.8)) + t * 0.26 + u_ph[0].w * 6.2832) * 0.45
       + sin(dot(q, vec2(-1.9, 4.4)) - t * 0.2 + u_ph[1].w * 6.2832) * 0.3
       + gnoise(q * 2.0 + vec2(t * 0.04, u_ph[2].w * 9.0)) * 0.55;
}

vec3 field(vec2 p, vec2 pu, float aspect) {
  float t = u_time;
  // Anisotropic: folds run long and lie down, like cloth, not like contours.
  p *= vec2(0.6, 1.25);
  vec2 q = p + silkWarp(p, t);
  float e = 0.01;
  float h = height(q, t);
  float hx = height(q + vec2(e, 0.0), t);
  float hy = height(q + vec2(0.0, e), t);
  vec3 n = normalize(vec3(-(hx - h) / e, -(hy - h) / e, mix(7.0, 1.8, u_light)));
  // Colour follows the folds (height), with a slow drift across the screen
  // so one end of the sheet can differ from the other.
  vec3 col = ramp(clamp(0.5 + h * 0.5 + dot(pu, vec2(0.18, 0.1)), 0.0, 1.0));
  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
  float diff = dot(n, L);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  col.x += u_light * ((diff - 0.8) * 0.45 + spec * 0.18);
  return col;
}
`,
  aurora: `
vec3 field(vec2 p, vec2 pu, float aspect) {
  float t = u_time;
  float edge = mix(0.0008, 0.008, u_soft);
  float tail = mix(0.008, 0.06, u_soft);
  vec3 col = u_bg;
  // Back to front: each curtain is laid OVER the sky, so the sky survives
  // between curtains — light on dark, not stripes edge to edge.
  for (int i = 0; i < 6; i++) {
    if (u_w[i] <= 0.0) continue;
    vec4 h = u_ph[i];
    float x = p.x;
    float lane = (u_stop[i] - 0.5) * 0.6 - 0.1;
    float y0 = lane
      + 0.12 * sin(x * (1.0 + 1.1 * h.z) + t * (0.1 + 0.08 * h.w) + h.x * 6.2832)
      + u_warp * 0.18 * gnoise(vec2(x * 0.9 + h.y * 13.0, t * 0.05 + h.z * 7.0));
    float dy = pu.y - y0;
    // Hard foot, long soft tail upward: a curtain, not a stripe.
    float w = dy > 0.0 ? exp(-dy * dy / tail) : exp(-dy * dy / edge);
    // Rays: vertical striation drifting along the curtain. Kept below the
    // field's Nyquist at the lowest resolution, or it aliases into a fence.
    float ray = gnoise(vec2(x * 6.5 + h.x * 21.0 - t * 0.12, h.y * 5.0));
    w *= 1.0 + u_warp * 1.1 * ray;
    w = clamp(w * min(u_w[i], 1.0) * 0.85, 0.0, 1.0);
    vec3 c = u_col[i];
    c.x += u_light * 0.1 * w; // the foot glows
    col = mix(col, c, w);
  }
  return col;
}
`,
  dunes: `
vec3 field(vec2 p, vec2 pu, float aspect) {
  float t = u_time;
  float edge = mix(0.0015, 0.045, u_soft);
  vec3 col = u_bg;
  for (int i = 0; i < 6; i++) {
    if (u_w[i] <= 0.0) continue;
    vec4 h = u_ph[i];
    float x = p.x;
    float y = 0.44 - u_stop[i] * 0.95
      + 0.07 * sin(x * (1.2 + 1.3 * h.z) + t * (0.08 + 0.06 * h.w) + h.x * 6.2832)
      + 0.03 * sin(x * (3.0 + 2.0 * h.w) - t * (0.11 + 0.05 * h.z) + h.y * 6.2832)
      + u_warp * 0.09 * gnoise(vec2(x * 1.1 + h.y * 17.0, t * 0.04 + float(i) * 3.1));
    float dy = y - pu.y; // > 0 inside this layer
    float inside = smoothstep(-edge, edge, dy);
    // The layer casts a soft shadow onto whatever lies behind it...
    col.x -= u_light * 0.1 * exp(-max(-dy, 0.0) * 14.0) * (1.0 - inside);
    vec3 layer = u_col[i];
    // ...and its own face falls off with depth below the ridge.
    layer.x -= u_light * 0.05 * clamp(dy * 2.5, 0.0, 1.0);
    col = mix(col, layer, inside);
    // A rim of light right on the ridge.
    col.x += u_light * 0.035 * exp(-max(dy, 0.0) * 45.0) * inside;
  }
  return col;
}
`,
  marble: `
vec3 field(vec2 p, vec2 pu, float aspect) {
  float t = u_time;
  p *= 0.55;
  float k = 1.2 + 2.8 * u_warp;
  vec2 o = u_ph[0].xy * 10.0;
  vec2 q = vec2(
    fbm3(p + o + vec2(0.0, t * 0.03)),
    fbm3(p + o + vec2(5.2, 1.3) - vec2(t * 0.025, 0.0)));
  vec2 r = vec2(
    fbm3(p + k * q + vec2(1.7, 9.2) + t * 0.035),
    fbm3(p + k * q + vec2(8.3, 2.8) - t * 0.03));
  float f = fbm(p + k * r);
  vec3 col = ramp(clamp(0.5 + f * 1.1 + q.x * 0.6 - r.y * 0.3, 0.0, 1.0));
  col.x += u_light * (dot(r, r) * 0.5 + f * 0.12 - 0.04);
  return col;
}
`,
};

const FIELD_MAIN = `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 pu = place(uv);
  if (u_ptr.z > 0.0) {
    // The field leans toward the pointer: a soft lens, not a cursor blob.
    vec2 d = pu - place(u_ptr.xy);
    pu -= d * u_ptr.z * 0.3 * exp(-dot(d, d) * 5.0);
  }
  vec3 lab = field(pu * u_scale, pu, aspect);
  lab.yz *= u_sat;
  gl_FragColor = vec4(linearToSrgb(oklabToLinear(lab)), 1.0);
}
`;

export function fieldShader(style: DriftStyle): string {
  return FIELD_HEADER + STYLES[style] + FIELD_MAIN;
}

export const COMPOSITE_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D u_tex;
uniform vec2 u_out;      // canvas size, px
uniform float u_px;      // device px per CSS px — grain is sized in CSS px
uniform float u_grain;
uniform float u_gseed;
uniform float u_vig;
uniform vec3 u_bgs;      // background, display sRGB

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_out;
  vec3 c = texture2D(u_tex, uv).rgb;
  if (u_vig > 0.0) {
    vec2 d = (uv - 0.5) * 2.0;
    float v = smoothstep(0.35, 1.45, length(d * vec2(0.9, 1.0)));
    c = mix(c, u_bgs, v * u_vig);
  }
  if (u_grain > 0.0) {
    float g = hash12(floor(gl_FragCoord.xy / u_px) + u_gseed) - 0.5;
    // Strongest in the mid-tones, where grain reads as texture, not dirt.
    c += g * u_grain * 0.11 * (0.35 + c * (1.0 - c) * 2.6);
  }
  float dither = hash12(gl_FragCoord.xy + 71.3) + hash12(gl_FragCoord.xy * 1.13 + 19.7) - 1.0;
  gl_FragColor = vec4(c + dither / 255.0, 1.0);
}
`;
