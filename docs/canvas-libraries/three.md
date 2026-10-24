# Three.js in a canvas

Version: three 0.186.1, as this brain's canvas runtime pins it (r186).
Source: the three.js manual and docs (threejs.org, its llms.txt index) and
its release notes. Written for Mantle, not copied.

## Import

```js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
```

These two names are all the canvas runtime serves: the core and
OrbitControls. No other addon (no GLTF loader, no post-processing), and no
model files: build geometry in code. Use it for 3D scenes: a plant layout,
equipment you can turn round, a 3D surface.

## Core API

- `new THREE.Scene()`, `new THREE.PerspectiveCamera(fov, w / h, near, far)`.
- `const renderer = new THREE.WebGLRenderer({ antialias: true })`,
  `renderer.setSize(w, h)`, `renderer.setPixelRatio(devicePixelRatio)`,
  append `renderer.domElement`.
- Geometry: `BoxGeometry`, `CylinderGeometry`, `SphereGeometry`,
  `PlaneGeometry`, `TorusGeometry`, or a `BufferGeometry` with
  `setAttribute('position', new THREE.BufferAttribute(array, 3))`.
- Materials: `MeshStandardMaterial({ color, roughness, metalness })` (needs
  light), `MeshBasicMaterial` (no light).
- Light: `AmbientLight`, `DirectionalLight`, `HemisphereLight`.
- Loop: `renderer.setAnimationLoop((t) => { ...; renderer.render(scene, camera) })`.
- Controls: `const c = new OrbitControls(camera, renderer.domElement)`;
  with `c.enableDamping = true`, call `c.update()` every frame.

## What changed (if you know older three.js)

- Colour management is on: `renderer.outputColorSpace` is sRGB by default.
  Do not set `outputEncoding` or `sRGBEncoding` (gone); a colour texture
  takes `texture.colorSpace = THREE.SRGBColorSpace`.
- Lights are in physical units and `useLegacyLights` is gone: a
  `DirectionalLight` around 2 to 3 and an `AmbientLight` around 0.3 to 0.6
  look right; old values look dark.
- `THREE.Geometry` and `Face3` are long gone: use `BufferGeometry`.
- Addons come from `three/addons/...`, never `three/examples/jsm/...`.

## In a canvas

- Size: a fixed `canvas:size`; size the renderer to it, not to the window.
- Colours: `THREE.Color` cannot read `oklch()`: convert theme tokens with
  the `token()` helper in the example (`scene.background` from
  `--background`, materials from `--chart-1` and on).
- Motion: when `prefers-reduced-motion` asks, draw one frame and do not spin.
- WebGL is needed: check the picture with `present_render`; an error about
  a WebGL context means the viewer's browser has none.

## Example

```html
<!doctype html>
<html>
  <head>
    <title>Vessel and pump</title>
    <meta name="description" content="A vertical vessel and its pump in 3D, turning slowly." />
    <meta name="canvas:size" content="1280x720" />
  </head>
  <body class="bg-background">
    <div id="scene" style="width: 1280px; height: 720px"></div>
    <script type="module">
      import * as THREE from 'three';
      import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
      function token(name) {
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
        c.fillRect(0, 0, 1, 1);
        const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
        return new THREE.Color(`rgb(${r}, ${g}, ${b})`);
      }
      const W = 1280, H = 720;
      const scene = new THREE.Scene();
      scene.background = token('--background');
      const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
      camera.position.set(6, 4, 8);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(devicePixelRatio);
      renderer.setSize(W, H);
      document.getElementById('scene').appendChild(renderer.domElement);
      scene.add(new THREE.AmbientLight(0xffffff, 0.5));
      const sun = new THREE.DirectionalLight(0xffffff, 2.5);
      sun.position.set(5, 8, 6);
      scene.add(sun);
      const vessel = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 4, 48),
        new THREE.MeshStandardMaterial({ color: token('--chart-1'), roughness: 0.4, metalness: 0.3 }),
      );
      vessel.position.y = 2;
      const pump = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.8, 0.8),
        new THREE.MeshStandardMaterial({ color: token('--chart-2'), roughness: 0.5 }),
      );
      pump.position.set(3, 0.4, 0);
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 14),
        new THREE.MeshStandardMaterial({ color: token('--muted'), roughness: 1 }),
      );
      floor.rotation.x = -Math.PI / 2;
      scene.add(vessel, pump, floor);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.set(1, 1.5, 0);
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      renderer.setAnimationLoop(() => {
        if (!still) scene.rotation.y += 0.003;
        controls.update();
        renderer.render(scene, camera);
      });
    </script>
  </body>
</html>
```
