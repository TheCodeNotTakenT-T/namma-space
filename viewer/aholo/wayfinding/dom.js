/** Small DOM helpers and the icon set for the wayfinding interface. Icons are our own line drawings. */

/**
 * Create an element. Text children become text nodes, so place names from a venue file are never parsed
 * as HTML. `html` is reserved for the static icon markup below.
 */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === 'class') element.className = value;
    else if (name === 'html') element.innerHTML = value;
    else if (name === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

const PATHS = {
  // interface
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  jump: '<path d="M13 2 5 13.5h6L10 22l9-12h-6.5z"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.500V21"/>',
  volume: '<path d="M4 9.500h4l5-4v13l-5-4H4zM16.500 8.500a5 5 0 0 1 0 7M19 6a8.500 8.500 0 0 1 0 12"/>',
  mute: '<path d="M4 9.500h4l5-4v13l-5-4H4zM17 9.500l5 5m0-5-5 5"/>',
  stops: '<circle cx="6" cy="6" r="2.500"/><circle cx="18" cy="12" r="2.500"/><circle cx="6" cy="18" r="2.500"/><path d="M8.300 7.200 15.700 10.800M15.700 13.200 8.300 16.800"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14"/>',
  upload: '<path d="M12 16V5m0 0-4 4m4-4 4 4M5 19.5h14"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  shrink: '<path d="M20 10h-6V4M4 14h6v6M14 10l6-6M10 14l-6 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
  tools: '<path d="M14.5 6.5a4 4 0 0 0 5 5L11 20a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5 17 4"/>',
  zone: '<path d="M5 8 12 4l7 5-2 10H7z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  layers: '<path d="m12 4 9 5-9 5-9-5zM3 14l9 5 9-5"/>',
  // turns
  straight: '<path d="M12 20V5m0 0-5 5m5-5 5 5"/>',
  left: '<path d="M18 20v-7a4 4 0 0 0-4-4H5m0 0 4.5-4.5M5 9l4.5 4.5"/>',
  right: '<path d="M6 20v-7a4 4 0 0 1 4-4h9m0 0-4.5-4.5M19 9l-4.5 4.5"/>',
  'slight-left': '<path d="M15 20v-6.5L7 6m0 0v6m0-6h6"/>',
  'slight-right': '<path d="M9 20v-6.5L17 6m0 0v6m0-6h-6"/>',
  'sharp-left': '<path d="M17 20V7L7 15m0 0h6m-6 0V9"/>',
  'sharp-right': '<path d="M7 20V7l10 8m0 0h-6m6 0V9"/>',
  'u-turn': '<path d="M17 20V10a5 5 0 0 0-10 0v6m0 0-3.5-3.5M7 16l3.5-3.5"/>',
  arrive: '<path d="M6 21V4m0 1h11l-2.5 4L17 13H6"/>',
  // place categories
  entrance: '<path d="M6 21V4h9v17M4 21h16M12 12.5h.01"/>',
  room: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 10h7m0-6v9"/>',
  seating: '<path d="M7 11V5.5h10V11M5 11h14v4H5zm2 4v4m10-4v4"/>',
  desk: '<path d="M3 8h18M5 8v11M19 8v11m-6-11v6h6"/>',
  display: '<rect x="3" y="5" width="18" height="11" rx="1.5"/><path d="M12 16v4m-4 0h8"/>',
  washroom: '<circle cx="8" cy="5.5" r="1.8"/><circle cx="16" cy="5.5" r="1.8"/><path d="M8 9v11m8-5v5M5.500 14 8 9l2.500 5zm8.300-5h4.400v6h-4.400z"/>',
  stairs: '<path d="M4 20h4v-4h4v-4h4V8h4"/>',
  food: '<path d="M6 9h10v5a5 5 0 0 1-10 0zm10 1h1.500a2 2 0 0 1 0 4H16M5 20h12M9 3.500v2m3-2v2"/>',
  utility: '<path d="M13 2 5 13.500h6L10 22l9-12h-6.500z"/>',
  safety: '<path d="M12 3 5 6v5.500c0 4.200 2.900 7.400 7 9.500 4.100-2.100 7-5.300 7-9.500V6z"/><path d="M12 8.500V13m0 3h.01"/>',
  item: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="m4 8 8 4 8-4m-8 4v8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9.500h.01"/>',
};

/** Inline SVG markup for an icon; unknown names fall back to the information icon. */
export function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? PATHS.info}</svg>`;
}

/** "12 m", "4.5 m", "under 1 m". */
export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '';
  if (metres < 1) return 'under 1 m';
  return metres < 10 ? `${metres.toFixed(1).replace(/\.0$/, '')} m` : `${Math.round(metres)} m`;
}
