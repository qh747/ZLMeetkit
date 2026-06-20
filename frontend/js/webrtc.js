// webrtc.js — thin wrappers around RTCPeerConnection for publish and play
// against ZLMediaKit. All SDP exchange goes through the signaling server.
//
// Latency-sensitive notes:
//   - ZLMediaKit does not support trickle ICE, so we still have to bake all
//     candidates into the offer SDP before sending. To avoid the historical
//     ~2s stall on every PeerConnection we exit `waitIceGathering` as soon as
//     a usable host candidate is collected (the only kind that matters on
//     LAN), and cap the absolute wait at ICE_GATHER_TIMEOUT_MS.
//   - iceServers is fetched lazily from the backend (/api/rtc-config) once
//     per page so deployments can opt-in to STUN/TURN without a JS rebuild.
//     Default is empty for LAN deployments where host candidates are enough.

const ICE_GATHER_TIMEOUT_MS = 300;       // hard cap: we'd rather try with what we have
const ICE_GATHER_HOST_GRACE_MS = 80;     // after first host candidate, wait this long for siblings

const BASE_RTC_CONFIG = {
  iceServers: [],
  bundlePolicy: 'max-bundle',
};

// Cached promise so concurrent publish/play calls share a single fetch.
let _rtcConfigPromise = null;

/**
 * Resolve the RTCConfiguration to use for new PeerConnections. Fetches the
 * server-provided iceServers exactly once. Failures fall back to the empty
 * default — better to attempt with host candidates than block the whole call.
 */
function getRtcConfig() {
  if (_rtcConfigPromise) return _rtcConfigPromise;
  _rtcConfigPromise = (async () => {
    try {
      const resp = await fetch('/api/rtc-config', { cache: 'no-store' });
      if (!resp.ok) return { ...BASE_RTC_CONFIG };
      const data = await resp.json();
      const ice = Array.isArray(data && data.iceServers) ? data.iceServers : [];
      return { ...BASE_RTC_CONFIG, iceServers: ice };
    } catch (_) {
      return { ...BASE_RTC_CONFIG };
    }
  })();
  return _rtcConfigPromise;
}

/**
 * Force the cached config to be reloaded on the next PeerConnection. Mainly
 * useful for tests; normal pages can ignore this.
 */
export function resetRtcConfigCache() {
  _rtcConfigPromise = null;
}

/**
 * Eagerly prefetch the WebRTC config so the very first publish/play does not
 * wait on /api/rtc-config. Cheap to call multiple times.
 */
export function prefetchRtcConfig() {
  return getRtcConfig();
}

/**
 * Publish a local MediaStream to ZLM via the signaling server.
 *
 * @param {object} opts
 * @param {Signaling} opts.signaling
 * @param {MediaStream} opts.stream      local audio/video stream to publish
 * @param {'cam'|'screen'} [opts.kind]   meeting/call mode
 * @param {string} [opts.streamId]       solo mode: explicit stream name
 * @param {boolean} [opts.solo]          set true to use publish-solo mode
 * @param {(state: string)=>void} [opts.onState]   called on connectionstate change
 * @returns {Promise<{pc: RTCPeerConnection, streamId: string}>}
 */
export async function publishStream({ signaling, stream, kind, streamId, solo, onState }) {
  const config = await getRtcConfig();
  const pc = new RTCPeerConnection(config);

  // Add transceivers (send-only) so SDP m-line ordering matches ZLM expectations.
  for (const track of stream.getTracks()) {
    pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
  }

  if (onState) {
    pc.addEventListener('connectionstatechange', () => onState(pc.connectionState));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);

  const reqPayload = solo
    ? { mode: 'publish-solo', streamId, sdp: pc.localDescription.sdp }
    : { mode: 'publish', kind, sdp: pc.localDescription.sdp };
  const reply = await signaling.request('webrtc-offer', reqPayload);
  await pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });

  // Notify other peers (room modes only; solo rooms get a no-op broadcast on the server).
  if (!solo) {
    signaling.send('stream-started', { kind, streamId: reply.streamId });
  } else {
    signaling.send('stream-started', { kind: 'solo', streamId: reply.streamId });
  }

  return { pc, streamId: reply.streamId };
}

/**
 * Pull a remote stream from ZLM via the signaling server.
 *
 * @param {object} opts
 * @param {Signaling} opts.signaling
 * @param {string} [opts.targetUserId]  user whose stream we want (room mode)
 * @param {'cam'|'screen'} [opts.kind]  room mode
 * @param {string} [opts.streamId]      solo mode: explicit stream name
 * @param {boolean} [opts.solo]         set true to use play-solo mode
 * @param {(stream: MediaStream)=>void} opts.onTrack  fired when remote stream is ready
 * @param {(state: string)=>void} [opts.onState]
 * @returns {Promise<{pc: RTCPeerConnection, streamId: string}>}
 */
export async function playStream({ signaling, targetUserId, kind, streamId, solo, onTrack, onState }) {
  const config = await getRtcConfig();
  const pc = new RTCPeerConnection(config);

  // Recvonly transceivers for audio + video so ZLM sends both tracks back.
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });

  const remoteStream = new MediaStream();
  let delivered = false;
  pc.addEventListener('track', (ev) => {
    // Use the streams provided by the browser when possible, else assemble manually.
    if (ev.streams && ev.streams[0]) {
      if (!delivered) { delivered = true; onTrack(ev.streams[0]); }
    } else {
      remoteStream.addTrack(ev.track);
      if (!delivered) { delivered = true; onTrack(remoteStream); }
    }
  });

  if (onState) {
    pc.addEventListener('connectionstatechange', () => onState(pc.connectionState));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);

  const reqPayload = solo
    ? { mode: 'play-solo', streamId, sdp: pc.localDescription.sdp }
    : { mode: 'play', kind, targetUserId, sdp: pc.localDescription.sdp };
  const reply = await signaling.request('webrtc-offer', reqPayload);
  await pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });

  return { pc, streamId: reply.streamId };
}

/**
 * Wait until the SDP has enough ICE candidates baked in. Returns as early as
 * possible to minimise first-frame latency — see ICE_* constants above.
 *
 *  - If gathering is already 'complete', resolve immediately.
 *  - On the first 'host' candidate, wait ICE_GATHER_HOST_GRACE_MS for any
 *    siblings (multi-NIC machines) and then resolve.
 *  - Hard timeout at ICE_GATHER_TIMEOUT_MS regardless.
 *  - If 'icecandidate' fires with `null` (end-of-candidates), resolve
 *    immediately.
 */
function waitIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let graceTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', onState);
      pc.removeEventListener('icecandidate', onCandidate);
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      resolve();
    };

    const onState = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    const onCandidate = (ev) => {
      // null candidate signals end-of-candidates → no point waiting longer.
      if (!ev.candidate) {
        finish();
        return;
      }
      const text = ev.candidate.candidate || '';
      // Host candidates are local-only and ready almost instantly. On a LAN
      // they are sufficient for connectivity, and even with STUN configured
      // they make up the fast path; trim the gathering wait once we have one.
      if (text.indexOf(' typ host') !== -1 && !graceTimer) {
        graceTimer = setTimeout(finish, ICE_GATHER_HOST_GRACE_MS);
      }
    };

    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCandidate);

    const hardTimer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
  });
}

/** Stops all senders/receivers and closes the PC. */
export function closePC(pc) {
  if (!pc) return;
  try {
    for (const sender of pc.getSenders()) {
      try { sender.track && sender.track.stop(); } catch (_) {}
    }
  } catch (_) {}
  try { pc.close(); } catch (_) {}
}
