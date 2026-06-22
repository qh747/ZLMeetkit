/** Fit .solo-tile to the largest 16:9 rectangle inside .solo-video-wrap. */
const ASPECT = 16 / 9;

export function initSoloLayout() {
  const wrap = document.querySelector('.solo-video-wrap');
  const tile = document.querySelector('.solo-tile');
  if (!wrap || !tile) return;

  const apply = () => {
    const maxW = wrap.clientWidth;
    const maxH = wrap.clientHeight;
    if (maxW <= 0 || maxH <= 0) return;

    let width = maxW;
    let height = width / ASPECT;
    if (height > maxH) {
      height = maxH;
      width = height * ASPECT;
    }

    tile.style.width = `${Math.round(width)}px`;
    tile.style.height = `${Math.round(height)}px`;
  };

  apply();
  new ResizeObserver(apply).observe(wrap);
}
