// webrtc.js — thin wrappers around RTCPeerConnection for publish and play
// against ZLMediaKit. All SDP exchange goes through the signaling server.
//
// Latency-sensitive notes:
//   - ZLMediaKit does not support trickle ICE, so we still have to bake all
//     candidates into the offer SDP before sending. To avoid the historical
//     ~2s stall on every PeerConnection we exit `waitIceGathering` as soon
//     as a usable host candidate is collected (the only kind that matters on
//     LAN), and cap the absolute wait at ICE_GATHER_TIMEOUT_MS.
//   - iceServers is empty by default, which is the right choice for LAN
//     deployments: host candidates suffice and skipping STUN avoids a
//     ~1.5s gather stall when the public STUN server is unreachable.

const ICE_GATHER_TIMEOUT_MS = 300;       // hard cap: we'd rather try with what we have
const ICE_GATHER_HOST_GRACE_MS = 80;     // after first host candidate, wait this long for siblings

const RTC_CONFIG = {
  iceServers: [],
  bundlePolicy: 'max-bundle',
};

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
  if (!stream || stream.getTracks().length === 0) {
    throw new Error('没有可发布的音视频轨道');
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);

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

  // Room modes: server broadcasts peer-stream-started on publish success.
  // Solo still notifies via stream-started for players in the same app.
  if (solo) {
    signaling.send('stream-started', { kind: 'solo', streamId: reply.streamId });
  }

  return { pc, streamId: reply.streamId };
}

/** Attach a remote MediaStream to a video element and start playback. */
export function attachMediaStreamToVideo(video, stream) {
  if (!video) return;
  video.srcObject = stream;
  if (!stream) return;

  const play = () => { video.play().catch(() => {}); };
  play();

  if (!stream._attachHooked) {
    stream._attachHooked = true;
    stream.addEventListener('addtrack', (ev) => {
      if (ev.track?.kind === 'video') play();
    });
  }
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
  const pc = new RTCPeerConnection(RTC_CONFIG);

  try {
    // Recvonly transceivers for audio + video so ZLM sends both tracks back.
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });

    const remoteStream = new MediaStream();
    pc.addEventListener('track', (ev) => {
      const track = ev.track;
      if (!remoteStream.getTracks().some((t) => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
      // Fire on every track so a late-arriving video track updates the tile
      // after a republish that adds audio to an existing video-only stream.
      onTrack(remoteStream);
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
    applyLowLatencyPlayout(pc);

    return { pc, streamId: reply.streamId };
  } catch (err) {
    try { pc.close(); } catch (_) {}
    throw err;
  }
}

/** Minimize receiver jitter buffer where the browser supports it. */
function applyLowLatencyPlayout(pc) {
  try {
    for (const tr of pc.getTransceivers()) {
      const rx = tr.receiver;
      if (rx && 'playoutDelayHint' in rx) {
        rx.playoutDelayHint = 0;
      }
    }
  } catch (_) {}
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
      // they are sufficient for connectivity; trim the gathering wait once
      // we have one, allowing siblings (multi-NIC) a short grace window.
      if (text.indexOf(' typ host') !== -1 && !graceTimer) {
        graceTimer = setTimeout(finish, ICE_GATHER_HOST_GRACE_MS);
      }
    };

    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCandidate);

    const hardTimer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
  });
}

/** Closes a publish PeerConnection without stopping local capture tracks. */
export function closePublishPC(pc) {
  if (!pc) return;
  try { pc.close(); } catch (_) {}
}

/**
 * Publish `stream`, or update an existing publish PC when track set changed.
 * Republishes (new offer) when audio/video composition changes; otherwise replaceTrack.
 */
export async function publishOrUpdateStream({ existingPub, stream, publishOpts }) {
  if (!stream || stream.getTracks().length === 0) {
    throw new Error('没有可发布的音视频轨道');
  }
  if (!existingPub?.pc) {
    return publishStream({ ...publishOpts, stream });
  }

  const pc = existingPub.pc;
  const senderKinds = new Set(
    pc.getSenders().filter((s) => s.track).map((s) => s.track.kind),
  );
  const streamKinds = new Set(stream.getTracks().map((t) => t.kind));
  const needsRepublish = [...streamKinds].some((k) => !senderKinds.has(k))
    || [...senderKinds].some((k) => !streamKinds.has(k));

  if (needsRepublish) {
    closePublishPC(pc);
    return publishStream({ ...publishOpts, stream });
  }

  for (const track of stream.getTracks()) {
    const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
    if (sender && sender.track !== track) {
      await sender.replaceTrack(track);
    }
  }
  return existingPub;
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
