/** Fit .solo-tile to fill the full height of .solo-video-wrap, capping width at
 *  the 16:9 aspect ratio. This keeps the tile top/bottom borders aligned with
 *  the .solo-info panel; the video uses object-fit:contain for internal AR. */
const ASPECT = 16 / 9;

export function initSoloLayout() {
  const wrap = document.querySelector('.solo-video-wrap');
  const tile = document.querySelector('.solo-tile');
  if (!wrap || !tile) return;

  const apply = () => {
    const maxW = wrap.clientWidth;
    const maxH = wrap.clientHeight;
    if (maxW <= 0 || maxH <= 0) return;

    // Always fill the full wrap height so borders align with .solo-info.
    // Width is capped at the 16:9 value; video uses object-fit:contain.
    const height = maxH;
    const width  = Math.min(maxW, Math.round(maxH * ASPECT));

    tile.style.width  = `${width}px`;
    tile.style.height = `${height}px`;
  };

  apply();
  new ResizeObserver(apply).observe(wrap);
}
