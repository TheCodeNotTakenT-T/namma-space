/**
 * Effects on the reconstruction itself. The renderer lets a small shader block rewrite every splat before
 * it is drawn; this module drives one such block with a handful of numbers, so the effects work on any
 * scene and cost one pass on the graphics card.
 *
 *  - reveal:  the room assembles outwards from where you stand when you arrive
 *  - ceiling: everything above a height is cut away, which turns the room into a dollhouse seen from above
 *  - pulse:   a ring of light runs across the room when a route starts
 *  - focus:   the surroundings lose their colour so the selected place stands out
 *
 * Distances are metres and points are walking-frame {x, y, z}; they are converted to reconstruction units
 * here. If the renderer runs on WebGPU (WGSL shaders) the block is left empty and the effects do nothing.
 */
import { SplatModifier, Vector3, Vector4 } from '@manycore/aholo-viewer';

const FAR = 1e6;
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function shaderBlock(input, uniform, language) {
  if (language !== 'glsl') return { content: '' };
  const s = input.splat;
  return {
    content: `
      {
        float nsHeight = dot(${s}.center, ${uniform.up});
        float nsFromReveal = distance(${s}.center, ${uniform.reveal}.xyz);
        // reveal: inside the radius splats are whole; in a thin band they grow in, tinted like sparks.
        float nsIn = 1.0 - smoothstep(${uniform.reveal}.w - ${uniform.tune}.x, ${uniform.reveal}.w, nsFromReveal);
        float nsSpark = nsIn * smoothstep(${uniform.reveal}.w - 3.0 * ${uniform.tune}.x, ${uniform.reveal}.w - ${uniform.tune}.x, nsFromReveal);
        ${s}.scales *= mix(0.15, 1.0, nsIn);
        ${s}.color.a *= nsIn;
        ${s}.color.rgb = mix(${s}.color.rgb, vec3(1.0, 0.86, 0.25), nsSpark * 0.45);
        // ceiling: fade out above the cut height.
        ${s}.color.a *= 1.0 - smoothstep(${uniform.ceiling}.x - ${uniform.ceiling}.y, ${uniform.ceiling}.x, nsHeight);
        // room box: outside the walls nothing is drawn (bird's-eye view only).
        vec3 nsRel = ${s}.center - ${uniform.boxCentre};
        float nsOutside = max(abs(dot(nsRel, ${uniform.boxU}.xyz)) - ${uniform.boxU}.w, abs(dot(nsRel, ${uniform.boxV}.xyz)) - ${uniform.boxV}.w);
        ${s}.color.a *= 1.0 - smoothstep(0.0, ${uniform.ceiling}.y, nsOutside);
        // pulse: a shell of light at a growing radius.
        float nsShell = 1.0 - smoothstep(0.0, ${uniform.tune}.y, abs(distance(${s}.center, ${uniform.pulse}.xyz) - ${uniform.pulse}.w));
        ${s}.color.rgb = mix(${s}.color.rgb, vec3(1.0, 0.83, 0.0), nsShell * ${uniform.tune}.z);
        // focus: grey and darker away from the selected place.
        float nsAway = smoothstep(${uniform.focus}.w, ${uniform.focus}.w * 1.8, distance(${s}.center, ${uniform.focus}.xyz)) * ${uniform.tune}.w;
        float nsGrey = dot(${s}.color.rgb, vec3(0.299, 0.587, 0.114));
        ${s}.color.rgb = mix(${s}.color.rgb, vec3(nsGrey) * 0.6, nsAway);
      }`,
  };
}

export function createEffects({ getSplat, walk, dirty }) {
  let modifier = null, attached = null;
  // Current values, in metres / walking frame. "Off" is expressed as a value that changes nothing.
  const now = { reveal: { point: { x: 0, y: 0, z: 0 }, radius: FAR }, ceiling: FAR, pulse: { point: { x: 0, y: 0, z: 0 }, radius: -FAR, strength: 0 }, focus: { point: { x: 0, y: 0, z: 0 }, radius: FAR, amount: 0 } };
  let box = null;             // {centre, u, v, halfU, halfV} in metres, or null for no cut
  const tweens = new Map();   // name -> {elapsed, duration, step, done}

  const units = metres => metres / (walk.metresPerUnit() || 1);
  const raw = point => walk.toRaw(point);

  function uniforms() {
    const up = walk.upRaw(), floor = raw({ x: 0, y: 0, z: 0 });
    const floorHeight = floor[0] * up[0] + floor[1] * up[1] + floor[2] * up[2];
    // Box axes as reconstruction-space directions; an absent box is one too large to cut anything.
    const origin = raw({ x: box?.centre.x ?? 0, y: 0, z: box?.centre.z ?? 0 });
    const axis = (direction, half) => {
      const tip = raw({ x: (box?.centre.x ?? 0) + direction.x, y: 0, z: (box?.centre.z ?? 0) + direction.z });
      const d = tip.map((value, i) => value - origin[i]), n = Math.hypot(...d) || 1;
      return new Vector4(d[0] / n, d[1] / n, d[2] / n, box ? units(half) : FAR);
    };
    return {
      up: new Vector3(up[0], up[1], up[2]),
      boxCentre: new Vector3(origin[0], origin[1], origin[2]),
      boxU: axis(box?.u ?? { x: 1, z: 0 }, box?.halfU ?? 0),
      boxV: axis(box?.v ?? { x: 0, z: 1 }, box?.halfV ?? 0),
      reveal: new Vector4(...raw(now.reveal.point), units(now.reveal.radius)),
      ceiling: new Vector4(now.ceiling >= FAR ? FAR : floorHeight + units(now.ceiling), units(0.35), 0, 0),
      pulse: new Vector4(...raw(now.pulse.point), units(now.pulse.radius)),
      focus: new Vector4(...raw(now.focus.point), units(now.focus.radius)),
      // x: reveal band, y: pulse thickness, z: pulse strength, w: focus amount
      tune: new Vector4(units(0.9), units(0.22), now.pulse.strength, now.focus.amount),
    };
  }

  /** Attach the shader block to the current splat (again after a new scene loads). */
  function attach() {
    const splat = getSplat();
    if (!splat || typeof splat.setModifiers !== 'function' || !walk.ready()) return false;
    if (splat !== attached) {
      modifier = new SplatModifier('nammaEffects', uniforms(), shaderBlock)   // the name becomes part of shader identifiers;
      splat.setModifiers([modifier]);
      attached = splat;
    }
    return true;
  }

  function push() {
    if (!attach()) return;
    modifier.update(uniforms());
    dirty();
  }

  function tween(name, duration, step, done) {
    tweens.set(name, { elapsed: 0, duration, step, done });
    step(0);
    push();
  }

  return {
    /** The room assembles outwards from a point. `reach` is how far the wave must travel (metres). */
    reveal(point, reach, duration = 2.8) {
      now.reveal.point = { ...point };
      // Starts with the floor at your feet and sweeps outwards; the visible front takes about a second and a half.
      tween('reveal', duration, t => { now.reveal.radius = 1.5 + t * t * (3 - 2 * t) * (reach + 2); }, () => { now.reveal.radius = FAR; });
    },
    /** Cut the reconstruction above `height` metres over the floor; null puts the ceiling back. */
    setCeiling(height, duration = 0.9) {
      const from = now.ceiling >= FAR ? 6 : now.ceiling, to = height ?? 6;
      tween('ceiling', duration, t => { now.ceiling = from + (to - from) * ease(t); }, () => { now.ceiling = height ?? FAR; });
    },
    /** A ring of light from a point out to `reach` metres. */
    pulse(point, reach, duration = 1.4) {
      now.pulse.point = { ...point };
      tween('pulse', duration, t => { now.pulse.radius = t * reach; now.pulse.strength = 0.6 * (1 - t * t); }, () => { now.pulse.radius = -FAR; now.pulse.strength = 0; });
    },
    /** Drain colour from everything farther than `radius` metres from a point; null restores it. */
    focus(point, radius = 2.2, duration = 0.5) {
      const from = now.focus.amount, to = point ? 0.8 : 0;
      if (point) { now.focus.point = { ...point }; now.focus.radius = radius; }
      tween('focus', duration, t => { now.focus.amount = from + (to - from) * t; }, () => { now.focus.amount = to; });
    },
    /** Draw only what lies inside a wall-aligned box (from `roomBox`); null draws everything again. */
    setBox(next) { box = next; push(); },
    /** Advance running effects. Returns true while anything is animating. */
    frame(seconds) {
      if (!tweens.size) return false;
      for (const [name, item] of tweens) {
        item.elapsed += seconds;
        const t = Math.min(1, item.elapsed / item.duration);
        item.step(t);
        if (t >= 1) { item.done?.(); tweens.delete(name); }
      }
      push();
      return true;
    },
    busy: () => tweens.size > 0,
  };
}
