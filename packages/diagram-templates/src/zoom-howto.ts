/**
 * How a canvas opts into zoom and pan (zoom.ts `zoomable`): one text for
 * the canvas_authoring skill (the in-app agents) and the canvas_library
 * `zoom` guide (an MCP client), so the two never drift.
 */
export const ZOOMABLE_HOWTO = `Zoom and pan for any canvas's SVG: \`import { zoomable } from '@mantle/diagram-templates/browser'\`, then \`zoomable(svgOrContainer, { mode: 'auto'|'on'|'off', controls: 'frame'|'inside', height })\`. Auto shows the zoom buttons only when the drawing does not fit the frame at a readable size; a hidden zoom ignores the wheel and keys. It changes only the SVG's viewBox, never the drawing or its export. Use \`controls: 'inside'\` when one canvas has several zoomable drawings. Shown, Ctrl (or Cmd) + wheel and a trackpad pinch zoom, a plain wheel pans until the drawing's edge and then scrolls the page, drag pans; a render (\`present_render\`, a poster, an export) always shows the whole drawing without the buttons.

\`\`\`html
<div id="plan"><svg viewBox="0 0 4000 2400"><!-- your drawing --></svg></div>
<script type="module">
  import { zoomable } from '@mantle/diagram-templates/browser';
  zoomable(document.getElementById('plan'), { mode: 'auto' });
</script>
\`\`\``;
