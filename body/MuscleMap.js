import { MUSCLES, getMuscles } from './registry.js';
import {
  DEFAULT_BLEND_MODE,
  DEFAULT_COLOR,
  DEFAULT_GENDER,
  DEFAULT_HOVER_INTENSITY,
  DEFAULT_THEME,
  DEFAULT_VIEW,
  PX2MM,
  SVG_NS,
  VIEWBOX_HEIGHT,
  VIEWBOX_WIDTH,
  XLINK_NS,
} from './constants.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function cssDimension(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === 'number' ? `${value}px` : value;
}

// Original library resolves the bundled body image via `import.meta.url` +
// bundler asset re-emission (Vite/webpack). This app has no build step, so
// the two illustrations actually used (male, dark theme) are shipped as
// plain static files under ./body/ instead, and resolved with this simple
// lookup rather than the bundler-dependent `defaultBody()` helper.
const LOCAL_BODIES = {
  'male-front-dark': './body/male-front-dark.webp',
  'male-back-dark': './body/male-back-dark.webp',
};
function defaultBody(gender, view, theme) {
  return LOCAL_BODIES[`${gender}-${view}-${theme}`] ?? LOCAL_BODIES['male-front-dark'];
}

/**
 * Framework-agnostic muscle map engine.
 *
 * Renders a body image plus an overlay of muscle masks inside a single `<svg>`.
 * Each mask is a `<path>` filled with the highlight color and blended over the
 * image with `mix-blend-mode` (default `multiply`), so the red settles into the
 * grooves of the illustration and the muscle looks lit from within rather than
 * painted flat. Intensity is the path's opacity.
 *
 * The image and all masks share one `viewBox`, so sizing the `<svg>` scales
 * everything together; masks never need their own scale transform.
 */
export class MuscleMap {
  constructor(container, options = {}) {
    if (!container) throw new Error('[MuscleMap] a container element is required');
    this.container = container;
    this.options = { ...options };
    this.view = options.view ?? DEFAULT_VIEW;
    this.gender = options.gender ?? DEFAULT_GENDER;
    this.theme = options.theme ?? DEFAULT_THEME;

    this.paths = new Map();
    this.appliedOpacity = new Map();
    this.appliedColor = new Map();
    this.currentById = new Map();
    this.hoveredId = null;
    this.destroyed = false;

    this.onPointerOver = this.onPointerOver.bind(this);
    this.onPointerOut = this.onPointerOut.bind(this);
    this.onClick = this.onClick.bind(this);

    this.mount();
  }

  /** The root `<svg>` element. */
  get element() {
    return this.svg;
  }

  // --- public API ----------------------------------------------------------

  /**
   * Merge new options and apply the minimal DOM updates needed. Change detection
   * compares *resolved* values (option ?? default), so setting an option back to
   * `undefined` correctly reverts it to its default.
   */
  update(partial = {}) {
    if (this.destroyed) return;
    const prev = this.options;
    const next = { ...prev, ...partial };
    this.options = next;

    const nextView = next.view ?? DEFAULT_VIEW;
    const nextGender = next.gender ?? DEFAULT_GENDER;
    const nextTheme = next.theme ?? DEFAULT_THEME;

    const viewChanged = nextView !== this.view;
    const genderChanged = nextGender !== this.gender;
    const themeChanged = nextTheme !== this.theme;
    const registryChanged = (next.registry ?? MUSCLES) !== (prev.registry ?? MUSCLES);
    const bodyChanged = next.bodySrc !== prev.bodySrc;

    this.view = nextView;
    this.gender = nextGender;
    this.theme = nextTheme;

    // The set of paths depends on gender + view + registry.
    if (viewChanged || genderChanged || registryChanged) {
      this.renderPaths(); // re-applies color/blend/highlights for the new set
    } else {
      if ((next.blendMode ?? DEFAULT_BLEND_MODE) !== (prev.blendMode ?? DEFAULT_BLEND_MODE)) {
        this.applyBlend();
      }
      // Highlights set both opacity AND per-mask fill, so a global color change
      // is re-resolved here too — no separate color pass needed.
      this.applyHighlights();

      if (
        (next.hoverHighlight ?? true) !== (prev.hoverHighlight ?? true) ||
        next.onMuscleEnter !== prev.onMuscleEnter ||
        next.onMuscleLeave !== prev.onMuscleLeave ||
        next.onMuscleClick !== prev.onMuscleClick
      ) {
        this.applyCursor();
      }
    }

    if (viewChanged || genderChanged || themeChanged || bodyChanged) this.applyImage();
    if (next.width !== prev.width || next.height !== prev.height) this.applySize();
    if ((next.className ?? '') !== (prev.className ?? '')) this.applyClassName();
  }

  /** Remove the SVG and detach listeners. Fires a paired leave if still hovered. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearHovered();
    this.layer.removeEventListener('pointerover', this.onPointerOver);
    this.layer.removeEventListener('pointerout', this.onPointerOut);
    this.layer.removeEventListener('click', this.onClick);
    this.svg.remove();
    this.paths.clear();
    this.appliedOpacity.clear();
  }

  // --- build ---------------------------------------------------------------

  mount() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.display = 'block';
    // Isolate so `mix-blend-mode` blends masks against the body image only,
    // never against whatever is painted behind the <svg> on the page.
    svg.style.isolation = 'isolate';
    svg.style.aspectRatio = `${VIEWBOX_WIDTH} / ${VIEWBOX_HEIGHT}`;

    const image = document.createElementNS(SVG_NS, 'image');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(VIEWBOX_WIDTH));
    image.setAttribute('height', String(VIEWBOX_HEIGHT));
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.appendChild(image);

    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', 'mm-muscle-layer');
    svg.appendChild(layer);

    this.svg = svg;
    this.image = image;
    this.layer = layer;

    layer.addEventListener('pointerover', this.onPointerOver);
    layer.addEventListener('pointerout', this.onPointerOut);
    layer.addEventListener('click', this.onClick);

    this.applyClassName();
    this.applySize();
    this.applyImage();
    this.renderPaths();

    this.container.appendChild(svg);
  }

  get registry() {
    return this.options.registry ?? MUSCLES;
  }

  renderPaths() {
    this.clearHovered();
    this.layer.replaceChildren();
    this.paths.clear();
    this.appliedOpacity.clear();
    this.appliedColor.clear();
    this.currentById = new Map();

    const color = this.options.color ?? DEFAULT_COLOR;
    const blend = this.options.blendMode ?? DEFAULT_BLEND_MODE;

    for (const muscle of getMuscles(this.gender, this.view, this.registry)) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', muscle.d);
      path.setAttribute('fill', color);
      path.setAttribute('data-muscle-id', muscle.id);
      const transform = offsetToTransform(muscle.offset);
      if (transform) path.setAttribute('transform', transform);
      path.style.mixBlendMode = blend;
      path.style.opacity = '0';
      this.layer.appendChild(path);
      this.paths.set(muscle.id, path);
      this.appliedOpacity.set(muscle.id, 0);
      this.appliedColor.set(muscle.id, color);
      this.currentById.set(muscle.id, muscle);
    }

    this.applyHighlights();
    this.applyCursor();
  }

  // --- granular appliers ---------------------------------------------------

  applyImage() {
    const src = this.resolveBodySrc();
    // The body illustration loads asynchronously; without this, the
    // muscle-highlight overlay (already in the DOM with its opacity set)
    // paints on the very next frame regardless, so red shapes flash over a
    // blank background for a moment before the image pops in underneath.
    // Hiding the whole SVG until the image actually finishes loading (or
    // fails to — the error listener still reveals it, so a broken/slow
    // load never leaves the map permanently blank) fixes both the initial
    // mount and switching front/back view, which swaps the image and the
    // highlight paths together via this same method.
    this.svg.style.visibility = 'hidden';
    const reveal = () => { if (!this.destroyed) this.svg.style.visibility = ''; };
    this.image.addEventListener('load', reveal, { once: true });
    this.image.addEventListener('error', reveal, { once: true });
    setTimeout(reveal, 1500); // safety net in case neither event ever fires
    this.image.setAttribute('href', src);
    this.image.setAttributeNS(XLINK_NS, 'xlink:href', src);
  }

  applySize() {
    this.svg.style.width = cssDimension(this.options.width, '100%');
    this.svg.style.height = cssDimension(this.options.height, 'auto');
  }

  applyClassName() {
    this.svg.setAttribute('class', this.options.className ?? '');
  }

  applyBlend() {
    const blend = this.options.blendMode ?? DEFAULT_BLEND_MODE;
    for (const path of this.paths.values()) path.style.mixBlendMode = blend;
  }

  /**
   * `pointer` only makes sense if hovering/clicking a mask actually does
   * something: the built-in hover highlight is on, or the caller listens for
   * hover/click. Otherwise leave the cursor at its default.
   */
  applyCursor() {
    const interactive =
      (this.options.hoverHighlight ?? true) ||
      !!this.options.onMuscleEnter ||
      !!this.options.onMuscleLeave ||
      !!this.options.onMuscleClick;
    const cursor = interactive ? 'pointer' : '';
    for (const path of this.paths.values()) path.style.cursor = cursor;
  }

  applyHighlights() {
    const resolved = this.resolveHighlights();
    const globalColor = this.options.color ?? DEFAULT_COLOR;
    const hoverOn = this.options.hoverHighlight ?? true;
    const hoverIntensity = this.options.hoverIntensity ?? DEFAULT_HOVER_INTENSITY;

    const hoverColor = this.options.hoverColor;

    for (const [id, path] of this.paths) {
      const hit = resolved.get(id);
      const data = hit?.intensity ?? 0;
      const isHovered = hoverOn && this.hoveredId === id;
      const hover = isHovered ? hoverIntensity : 0;
      const intensity = clamp(Math.max(data, hover), 0, 100);
      this.setOpacity(id, path, intensity / 100);
      // Hovering can recolor the muscle (e.g. a distinct hover tint); otherwise
      // it keeps its own highlight color, falling back to the global color.
      const fill = isHovered && hoverColor ? hoverColor : (hit?.color ?? globalColor);
      this.setFill(id, path, fill);
    }
  }

  setOpacity(id, path, opacity) {
    if (this.appliedOpacity.get(id) === opacity) return;
    path.style.opacity = String(opacity);
    this.appliedOpacity.set(id, opacity);
  }

  setFill(id, path, color) {
    if (this.appliedColor.get(id) === color) return;
    path.setAttribute('fill', color);
    this.appliedColor.set(id, color);
  }

  /**
   * Collapse the `highlights` option into a per-mask intensity + color, resolving
   * `group` targets to every matching mask in the current gender + view. Duplicate
   * hits merge by max intensity; the strongest contributor's color wins (and a
   * color is never dropped in favor of none).
   */
  resolveHighlights() {
    const out = new Map();
    const byGroup = new Map();
    for (const m of this.currentById.values()) {
      const arr = byGroup.get(m.group) ?? [];
      arr.push(m.id);
      byGroup.set(m.group, arr);
    }
    const apply = (id, intensity, color) => {
      const prev = out.get(id);
      if (!prev) {
        out.set(id, { intensity, color });
      } else if (intensity > prev.intensity) {
        out.set(id, { intensity, color: color ?? prev.color });
      } else if (color && !prev.color) {
        prev.color = color;
      }
    };
    for (const h of this.options.highlights ?? []) {
      if (h.id && this.currentById.has(h.id)) apply(h.id, h.intensity, h.color);
      if (h.group) for (const id of byGroup.get(h.group) ?? []) apply(id, h.intensity, h.color);
    }
    return out;
  }

  muscleTarget(id) {
    const m = this.currentById.get(id);
    return { id, group: m?.group ?? '', name: m?.name ?? '' };
  }

  resolveBodySrc() {
    const src = this.options.bodySrc;
    if (typeof src === 'string') return src;
    if (src && typeof src === 'object') {
      const v = src[this.view];
      if (v) return v;
    }
    return defaultBody(this.gender, this.view, this.theme);
  }

  // --- events --------------------------------------------------------------

  /** Clear hover state, firing a paired onMuscleLeave if one was active. */
  clearHovered(event) {
    if (this.hoveredId === null) return;
    const prev = this.hoveredId;
    this.hoveredId = null;
    this.options.onMuscleLeave?.(this.muscleTarget(prev), event);
  }

  setHovered(id, event) {
    if (id === this.hoveredId) return;
    const prev = this.hoveredId;
    this.hoveredId = id;
    if (prev !== null) this.options.onMuscleLeave?.(this.muscleTarget(prev), event);
    if (id !== null) this.options.onMuscleEnter?.(this.muscleTarget(id), event);
    if (this.options.hoverHighlight ?? true) this.applyHighlights();
  }

  onPointerOver(event) {
    const el = event.target?.closest?.('[data-muscle-id]');
    const id = el?.getAttribute('data-muscle-id') ?? null;
    if (id && id !== this.hoveredId) this.setHovered(id, event);
  }

  onPointerOut(event) {
    const related = event.relatedTarget;
    const stillOnMuscle = related && related.closest && related.closest('[data-muscle-id]');
    if (!stillOnMuscle) this.setHovered(null, event);
  }

  onClick(event) {
    const el = event.target?.closest?.('[data-muscle-id]');
    const id = el?.getAttribute('data-muscle-id');
    if (id) this.options.onMuscleClick?.(this.muscleTarget(id), event);
  }
}

function offsetToTransform(offset) {
  if (!offset || (!offset.x && !offset.y)) return null;
  return `translate(${offset.x * PX2MM} ${offset.y * PX2MM})`;
}
