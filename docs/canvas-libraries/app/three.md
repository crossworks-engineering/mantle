# Three.js in a mini app

Version: three 0.186.1, as this brain's app runtime serves it (r186).
Source: the three.js manual and docs (threejs.org) and its release notes.
Written for Mantle, not copied.

## Import

```tsx
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
```

Exactly these two names: other addons are not served, and
`three/examples/jsm/...` is refused. The addon imports the same `three`
through the frame's import map, so a scene and its controls share one copy.
Neither is bundled into the app.

## In a React component

- A container `div` with a real height (`h-96`), kept in a `useRef`. In a
  `useEffect`: make the renderer, scene and camera, append
  `renderer.domElement` to the container, start the loop with
  `renderer.setAnimationLoop(...)`.
- Cleanup frees the GPU: `renderer.setAnimationLoop(null)`, `controls.dispose()`,
  each geometry and material's `dispose()`, `renderer.dispose()`, then
  remove the canvas from the container. A remount without it leaks a WebGL
  context; the browser allows only a few.
- Resize: a `ResizeObserver` sets `renderer.setSize(w, h)`, `camera.aspect = w / h`
  and `camera.updateProjectionMatrix()`.
- Theme: `new THREE.WebGLRenderer({ antialias: true, alpha: true })` lets the
  app's own ground show; colours come from tokens through `token()` (oklch
  as rgb) and are set again when the host switches theme.
- Reduced motion: no auto rotation when `prefers-reduced-motion` asks.
- No network: no `TextureLoader` or `GLTFLoader` from a URL. Build geometry
  in code, or a texture from a `data:` URL.

## App example

```tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

function token(name: string): string {
  const g = document.createElement('canvas').getContext('2d')!;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${gr}, ${b})`;
}

export default function App() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(3, 2.2, 4);
    const geometry = new THREE.TorusKnotGeometry(0.9, 0.3, 160, 24);
    const material = new THREE.MeshStandardMaterial({
      color: token('--chart-1'),
      roughness: 0.4,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh, new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    renderer.setAnimationLoop(() => {
      if (!reduce) mesh.rotation.y += 0.01;
      controls.update();
      renderer.render(scene, camera);
    });
    const ro = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = el;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    });
    ro.observe(el);
    const mo = new MutationObserver(() => material.color.set(token('--chart-1')));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-color-theme'],
    });
    return () => {
      mo.disconnect();
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div className="p-4">
      <div ref={ref} className="h-96 w-full rounded-lg border" />
    </div>
  );
}
```
