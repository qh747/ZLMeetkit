/** Fit .solo-tile to fill the full extent of .solo-video-wrap.
 *  Tile always fills the wrap (width AND height) so its borders align with
 *  the adjacent .solo-info / .chat-panel and there is no gap between the
 *  tile edge and the sidebar.  The <video> element uses object-fit:contain
 *  to maintain the stream's native aspect ratio within the tile. */
export function initSoloLayout() {
  const wrap = document.querySelector('.solo-video-wrap');
  const tile = document.querySelector('.solo-tile');
  if (!wrap || !tile) return;

  const apply = () => {
    const maxW = wrap.clientWidth;
    const maxH = wrap.clientHeight;
    if (maxW <= 0 || maxH <= 0) return;

    // Fill the entire wrap so the tile border is flush with the sidebar edge.
    // Any aspect-ratio mismatch is absorbed by the video's object-fit:contain.
    tile.style.width  = `${maxW}px`;
    tile.style.height = `${maxH}px`;
  };

  apply();
  new ResizeObserver(apply).observe(wrap);
}
