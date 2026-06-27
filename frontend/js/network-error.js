/** Shared handling when the backend is unreachable or restarts mid-session. */

import { showAppAlert } from './ui-alert.js';

export const NETWORK_ERROR_TITLE = '网络异常';
export const NETWORK_ERROR_MESSAGE = '网络异常，服务连接已断开，请稍后重试';

let handled = false;

export function clearBusinessSession() {
  [
    'zlm.room',
    'zlm.nickname',
    'zlm.token',
    'zlm.streamId',
    'zlm.micOn',
    'zlm.camOn',
  ].forEach((key) => sessionStorage.removeItem(key));
}

/** Entry page with meeting / call / push / play cards. */
export function businessHomeUrl() {
  return 'index.html';
}

/**
 * Show network error, clear session, redirect to business entry page.
 * No-op when the disconnect was initiated by the user (leave / close).
 */
export async function handleServiceDisconnect({
  biz,
  signaling,
  message = NETWORK_ERROR_MESSAGE,
} = {}) {
  if (handled) return;
  if (signaling?.isClosedByUser?.()) return;

  handled = true;

  try {
    signaling?.close?.();
  } catch (_) {}

  clearBusinessSession();

  await showAppAlert(message, { title: NETWORK_ERROR_TITLE });
  location.href = businessHomeUrl();
}

export function resetServiceDisconnectGuard() {
  handled = false;
}
