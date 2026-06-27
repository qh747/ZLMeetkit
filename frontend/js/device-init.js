/** Sync bootstrap: add device / viewport classes on <html> before paint. */
(function () {
  var ua = navigator.userAgent;
  var root = document.documentElement;

  var isIOS = /iPhone|iPad|iPod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) {
    root.classList.add('device-ios');
  }
  if (/Android/i.test(ua)) {
    root.classList.add('device-android');
  }
  if (window.matchMedia('(pointer: coarse)').matches) {
    root.classList.add('device-touch');
  }

  function isIPad() {
    if (/iPad/i.test(ua)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !/iPhone/i.test(ua);
  }

  function isAndroidTablet() {
    return /Android/i.test(ua) && !/Mobile/i.test(ua);
  }

  function applyViewportClasses() {
    var w = window.innerWidth;
    root.classList.toggle('device-mobile', w <= 720);
    root.classList.toggle('device-narrow', w <= 480);
    root.classList.toggle('device-tablet', isIPad() || isAndroidTablet());
  }

  applyViewportClasses();
  window.addEventListener('resize', applyViewportClasses, { passive: true });
})();
