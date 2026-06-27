import { Signaling } from '/js/signaling.js';
import { playStream, closePC, attachMediaStreamToVideo } from '/js/webrtc.js';

const PAGE_SIZE_OPTIONS = [5, 10, 20];
const MAX_TILES = 9;
const BIZ_LABEL = { meeting: '视频会议', call: '1v1 通话', push: '推流' };

const WATCH_CTRL_ICON = {
  audioOn:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
      '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
      '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' +
    '</svg>',
  audioOff:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
      '<line x1="23" y1="9" x2="17" y2="15"/>' +
      '<line x1="17" y1="9" x2="23" y2="15"/>' +
    '</svg>',
  videoOn:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M23 7l-7 5 7 5V7z"/>' +
      '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' +
    '</svg>',
  videoOff:
    '<svg class="admin-watch-ctrl-icon admin-watch-ctrl-icon--off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>' +
      '<path d="M17 5h2a2 2 0 0 1 2 2v9.34"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/>' +
    '</svg>',
};

let getTokenFn = () => '';
let showToastFn = (msg) => window.alert(msg);
let onSessionEndFn = () => {};

const roomSessions = new Map();
const tiles = new Map();
const roomEndScheduled = new Set();
let slots = [];
let latestHub = null;
let pendingRoom = null;
let appliedSearch = '';
let appliedTypeFilter = '';
let currentPage = 1;
let pageSize = 10;
let dragSourceIndex = null;
let pointerDrag = { active: false, sourceIndex: null, pointerId: null };

const els = {};

export function initAdminMonitor(deps) {
  getTokenFn = deps.getToken;
  showToastFn = deps.showToast;
  onSessionEndFn = deps.onSessionEnd || (() => {});

  els.tableBody = document.getElementById('monitorTableBody');
  els.empty = document.getElementById('monitorEmpty');
  els.search = document.getElementById('monitorSearch');
  els.typeFilter = document.getElementById('monitorTypeFilter');
  els.liveCount = document.getElementById('liveCount');
  els.watchGrid = document.getElementById('watchGrid');
  els.roomsPanel = document.getElementById('monitorRoomsPanel');
  els.livePanel = document.getElementById('monitorLivePanel');
  els.memberDialog = document.getElementById('memberPickDialog');
  els.memberList = document.getElementById('memberPickList');
  els.memberRoom = document.getElementById('memberPickRoom');
  els.memberCancel = document.getElementById('memberPickCancel');
  els.searchBtn = document.getElementById('monitorSearchBtn');
  els.monitorPage = document.getElementById('monitorPage');
  els.pagination = document.getElementById('monitorPagination');
  els.pageInfo = document.getElementById('monitorPageInfo');
  els.pagePrev = document.getElementById('monitorPagePrev');
  els.pageNext = document.getElementById('monitorPageNext');
  els.pageInput = document.getElementById('monitorPageInput');
  els.pageGo = document.getElementById('monitorPageGo');
  els.pageSize = document.getElementById('monitorPageSize');

  document.querySelectorAll('[data-monitor-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchMonitorTab(btn.dataset.monitorTab));
  });

  if (els.searchBtn) {
    els.searchBtn.addEventListener('click', applyFilters);
  }
  if (els.search) {
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyFilters();
      }
    });
  }
  if (els.typeFilter) {
    els.typeFilter.addEventListener('change', applyFilters);
  }
  if (els.memberCancel) {
    els.memberCancel.addEventListener('click', () => els.memberDialog?.close());
  }
  if (els.pagePrev) {
    els.pagePrev.addEventListener('click', () => {
      if (els.pagePrev.disabled || els.pagePrev.classList.contains('is-disabled')) return;
      goToPage(currentPage - 1);
    });
  }
  if (els.pageNext) {
    els.pageNext.addEventListener('click', () => {
      if (els.pageNext.disabled || els.pageNext.classList.contains('is-disabled')) return;
      goToPage(currentPage + 1);
    });
  }
  if (els.pageGo) {
    els.pageGo.addEventListener('click', jumpToPageInput);
  }
  if (els.pageInput) {
    els.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpToPageInput();
      }
    });
  }
  if (els.pageSize) {
    els.pageSize.value = String(pageSize);
    els.pageSize.addEventListener('change', () => {
      const next = Number(els.pageSize.value);
      if (!PAGE_SIZE_OPTIONS.includes(next)) return;
      pageSize = next;
      currentPage = 1;
      renderRoomTable();
    });
  }

  renderWatchSlots();
  setupGridDragDrop();
  switchMonitorTab('rooms');
}

function applyFilters() {
  appliedSearch = (els.search?.value || '').trim().toLowerCase();
  appliedTypeFilter = els.typeFilter?.value || '';
  currentPage = 1;
  renderRoomTable();
}

export function updateMonitorHub(hub) {
  latestHub = hub;
  renderRoomTable();
  syncTilesWithHub(hub);
}

export async function stopAllWatching() {
  roomEndScheduled.clear();
  for (const key of [...tiles.keys()]) {
    stopTile(key, false);
  }
  for (const [roomId, session] of roomSessions.entries()) {
    try {
      session.sig?.send('observe-leave', {});
    } catch (_) {}
    session.sig?.close();
    roomSessions.delete(roomId);
  }
  updateLiveCount();
}

function roomBizType(room) {
  if ((room.realMembers ?? room.members) < 1) return null;
  if (room.mode === 'meeting') return 'meeting';
  if (room.mode === 'call') return 'call';
  if (room.mode === 'solo') {
    const hasPush = (room.clients || []).some(
      (c) => !c.isObserver && c.soloRole === 'push',
    );
    return hasPush ? 'push' : null;
  }
  return null;
}

function pushStreamName(room) {
  const pusher = (room.clients || []).find((c) => !c.isObserver && c.soloRole === 'push');
  if (!pusher) return '';
  const live = (pusher.streams || []).find((s) => s.kind === 'solo');
  return live?.streamId || pusher.plannedStreamId || '';
}

function roomDisplayName(room, biz) {
  if (biz !== 'push') return room.id;
  const streamName = pushStreamName(room);
  return streamName ? room.id + '/' + streamName : room.id;
}

function filterRooms() {
  if (!latestHub?.rooms) return [];
  return latestHub.rooms.filter((room) => {
    const biz = roomBizType(room);
    if (!biz) return false;
    if (appliedTypeFilter && biz !== appliedTypeFilter) return false;
    if (appliedSearch && !roomDisplayName(room, biz).toLowerCase().includes(appliedSearch)) return false;
    return true;
  });
}

/** 列表「在线人数」：推流业务统计拉流人数，其它业务统计真实成员数。 */
function roomOnlineCount(room, biz) {
  const clients = (room.clients || []).filter((c) => !c.isObserver);
  if (biz === 'push') {
    return clients.filter((c) => c.soloRole === 'play').length;
  }
  return room.realMembers ?? clients.length;
}

function renderRoomTable() {
  if (!els.tableBody) return;
  const rooms = filterRooms();
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize) || 1);
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const start = (currentPage - 1) * pageSize;
  const pageRooms = rooms.slice(start, start + pageSize);

  if (els.empty) els.empty.hidden = rooms.length > 0;
  els.tableBody.innerHTML = pageRooms.map((room) => {
    const biz = roomBizType(room);
    const recording = (room.clients || []).some(
      (c) => !c.isObserver && c.recording,
    );
    return (
      '<tr>' +
        '<td>' + escapeHtml(BIZ_LABEL[biz] || biz) + '</td>' +
        '<td>' + escapeHtml(roomDisplayName(room, biz)) + '</td>' +
        '<td>' + roomOnlineCount(room, biz) + '</td>' +
        '<td>' + (recording ? '录制中' : '—') + '</td>' +
        '<td><button type="button" class="admin-watch-btn" data-room-id="' + escapeAttr(room.id) + '">观看</button></td>' +
      '</tr>'
    );
  }).join('');

  els.tableBody.querySelectorAll('.admin-watch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = latestHub.rooms.find((r) => r.id === btn.dataset.roomId);
      if (room) onWatchRoom(room);
    });
  });

  renderPagination(rooms.length, totalPages);
}

function setPageNavBtnState(btn, disabled) {
  if (!btn) return;
  btn.disabled = disabled;
  btn.classList.toggle('is-disabled', disabled);
  btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

function renderPagination(total, totalPages) {
  if (!els.pagination) return;
  els.pagination.hidden = total <= 0;
  if (total <= 0) return;

  if (els.pageInfo) {
    els.pageInfo.textContent = '共 ' + total + ' 条，第 ' + currentPage + ' / ' + totalPages + ' 页';
  }
  if (els.pageSize) {
    els.pageSize.value = String(pageSize);
  }
  setPageNavBtnState(els.pagePrev, currentPage <= 1);
  setPageNavBtnState(els.pageNext, currentPage >= totalPages);
  if (els.pageInput) {
    els.pageInput.min = '1';
    els.pageInput.max = String(totalPages);
    els.pageInput.value = String(currentPage);
  }
}

function goToPage(page) {
  const rooms = filterRooms();
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize) || 1);
  const next = Math.min(Math.max(1, page), totalPages);
  if (next === currentPage) return;
  currentPage = next;
  renderRoomTable();
}

function jumpToPageInput() {
  if (!els.pageInput) return;
  const rooms = filterRooms();
  const totalPages = Math.max(1, Math.ceil(rooms.length / pageSize) || 1);
  const raw = Number(els.pageInput.value);
  if (!Number.isFinite(raw)) {
    showToastFn('请输入有效页码');
    return;
  }
  const page = Math.min(Math.max(1, Math.trunc(raw)), totalPages);
  if (page !== raw) {
    showToastFn('页码范围为 1–' + totalPages);
  }
  goToPage(page);
}

function onWatchRoom(room) {
  if (tiles.size >= MAX_TILES) {
    showToastFn('已达 9 路上限，请先停止观看某路画面');
    return;
  }
  const biz = roomBizType(room);
  if (biz === 'push') {
    const pusher = (room.clients || []).find(
      (c) => !c.isObserver && c.soloRole === 'push',
    );
    const stream = pusher?.streams?.find((s) => s.kind === 'solo');
    if (!stream) {
      showToastFn('当前没有可观看的推流');
      return;
    }
    startPushTile(room, stream.streamId, pusher.nickname);
    return;
  }
  openMemberPicker(room);
}

function openMemberPicker(room) {
  pendingRoom = room;
  if (els.memberRoom) {
    const biz = roomBizType(room);
    els.memberRoom.innerHTML =
      '<span class="admin-member-dialog-room-label">房间</span>' +
      '<span class="admin-member-dialog-room-name">' + escapeHtml(roomDisplayName(room, biz)) + '</span>';
  }
  const options = buildMemberOptions(room);
  if (!options.length) {
    showToastFn('暂无可观看的成员画面');
    return;
  }
  els.memberList.innerHTML = options.map((opt) => {
    const kindClass = opt.kind === 'screen' ? 'admin-member-pick-kind--screen' : 'admin-member-pick-kind--cam';
    return (
      '<li class="admin-member-pick-row">' +
        '<button type="button" class="admin-member-pick-item" ' +
          'data-user-id="' + escapeAttr(opt.userId) + '" ' +
          'data-kind="' + escapeAttr(opt.kind) + '" ' +
          'data-label="' + escapeAttr(opt.label) + '">' +
          '<span class="admin-member-pick-avatar" aria-hidden="true">' + escapeHtml(memberInitial(opt.nickname)) + '</span>' +
          '<span class="admin-member-pick-meta">' +
            '<span class="admin-member-pick-name">' + escapeHtml(opt.nickname) + '</span>' +
            '<span class="admin-member-pick-kind ' + kindClass + '">' + escapeHtml(opt.label) + '</span>' +
          '</span>' +
          '<span class="admin-member-pick-go" aria-hidden="true">›</span>' +
        '</button>' +
      '</li>'
    );
  }).join('');

  els.memberList.querySelectorAll('.admin-member-pick-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.memberDialog?.close();
      startMemberTile(
        pendingRoom,
        btn.dataset.userId,
        btn.dataset.kind,
        btn.dataset.label,
      );
    });
  });

  if (typeof els.memberDialog.showModal === 'function') {
    els.memberDialog.showModal();
  }
}

function buildMemberOptions(room) {
  const opts = [];
  for (const c of room.clients || []) {
    if (c.isObserver) continue;
    const hasCam = (c.streams || []).some((s) => s.kind === 'cam') || c.camOn;
    const hasScreen = (c.streams || []).some((s) => s.kind === 'screen');
    if (hasCam) {
      opts.push({ userId: c.userId, nickname: c.nickname, kind: 'cam', label: '摄像头' });
    }
    if (hasScreen) {
      opts.push({ userId: c.userId, nickname: c.nickname, kind: 'screen', label: '屏幕共享' });
    }
  }
  return opts;
}

function tileKeyMember(roomId, userId, kind) {
  return roomId + ':' + userId + ':' + kind;
}

function tileKeyPush(roomId, streamId) {
  return roomId + ':push:' + streamId;
}

function promptAlreadyWatching(key) {
  switchMonitorTab('live');
  highlightTile(key);
  showToastFn('该路画面正在观看中，无需重复选择');
}

async function startMemberTile(room, userId, kind, kindLabel) {
  const key = tileKeyMember(room.id, userId, kind);
  if (tiles.has(key)) {
    promptAlreadyWatching(key);
    return;
  }
  if (tiles.size >= MAX_TILES) {
    showToastFn('已达 9 路上限，请先停止观看某路画面');
    return;
  }
  const member = (room.clients || []).find((c) => c.userId === userId);
  await startTile(key, room, {
    title: room.id + ' · ' + (member?.nickname || userId) + ' · ' + kindLabel,
    play: async (sig) => playStream({
      signaling: sig,
      targetUserId: userId,
      kind,
      onTrack: (stream) => attachStream(key, stream),
    }),
  });
}

async function startPushTile(room, streamId, nickname) {
  const key = tileKeyPush(room.id, streamId);
  if (tiles.has(key)) {
    promptAlreadyWatching(key);
    return;
  }
  await startTile(key, room, {
    title: room.id + ' · 推流 · ' + (nickname || ''),
    play: async (sig) => playStream({
      signaling: sig,
      streamId,
      solo: true,
      onTrack: (stream) => attachStream(key, stream),
    }),
  });
}

async function startTile(key, room, opts) {
  const slot = allocateSlot();
  if (!slot) {
    showToastFn('已达 9 路上限，请先停止观看某路画面');
    return;
  }

  slot.occupied = true;
  slot.el.dataset.tileKey = key;

  slot.el.classList.remove('admin-watch-slot--empty');
  slot.el.querySelector('.admin-watch-title').textContent = opts.title;
  slot.el.querySelector('.admin-watch-status').textContent = '连接中…';
  const video = slot.el.querySelector('video');
  video.srcObject = null;
  video.muted = true;

  tiles.set(key, {
    slot,
    roomId: room.id,
    pc: null,
    video,
    audioOn: false,
    videoOn: true,
  });
  syncTileControls(key);

  try {
    const session = await ensureRoomSession(room);
    session.refCount++;
    const { pc } = await opts.play(session.sig);
    const tile = tiles.get(key);
    if (tile) {
      tile.pc = pc;
      tile.slot.el.querySelector('.admin-watch-status').textContent = '观看中';
      syncTileControls(key);
    }
    switchMonitorTab('live');
    updateLiveCount();
    updateSlotDragState();
  } catch (err) {
    console.error(err);
    stopTile(key, true);
    showToastFn(err.message || '观看失败');
  }
}

async function ensureRoomSession(room) {
  let session = roomSessions.get(room.id);
  if (session?.joined) return session;

  const token = getTokenFn();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/api/admin/observe/ws?token=' + encodeURIComponent(token);
  const sig = new Signaling(url);
  sig.on('_close', () => {
    if (!sig.isClosedByUser?.()) {
      window.__adminHandleNetworkFailure?.();
    }
  });
  await sig.connect();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('加入旁观超时')), 15000);
    const onJoined = () => {
      cleanup();
      resolve();
    };
    const onErr = (p) => {
      cleanup();
      reject(new Error(p.message || '加入旁观失败'));
    };
    const onEnded = (p) => {
      cleanup();
      reject(new Error(p.message || '业务已结束'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      sig.off('observe-joined', onJoined);
      sig.off('observe-error', onErr);
      sig.off('observe-ended', onEnded);
    };
    sig.on('observe-joined', onJoined);
    sig.on('observe-error', onErr);
    sig.on('observe-ended', onEnded);
    sig.send('observe-join', { room: room.id, mode: room.mode });
  });

  session = { sig, refCount: 0, joined: true };
  roomSessions.set(room.id, session);
  wireRoomSessionEvents(session, room.id);
  return session;
}

function wireRoomSessionEvents(session, roomId) {
  if (session.eventsWired) return;
  session.eventsWired = true;
  session.sig.on('observe-ended', (p) => {
    scheduleRoomEnd(roomId, p?.message || '业务已结束');
  });
}

function scheduleRoomEnd(roomId, message, delayMs = 1500) {
  if (roomEndScheduled.has(roomId)) return;
  roomEndScheduled.add(roomId);

  for (const [key, tile] of tiles.entries()) {
    if (tile.roomId !== roomId) continue;
    const statusEl = tile.slot.el.querySelector('.admin-watch-status');
    if (statusEl) statusEl.textContent = message;
  }

  setTimeout(() => {
    roomEndScheduled.delete(roomId);
    for (const key of [...tiles.keys()]) {
      const tile = tiles.get(key);
      if (tile?.roomId === roomId) stopTile(key, true);
    }
    cleanupRoomSession(roomId);
  }, delayMs);
}

function cleanupRoomSession(roomId) {
  const session = roomSessions.get(roomId);
  if (!session) return;
  try { session.sig?.send('observe-leave', {}); } catch (_) {}
  try { session.sig?.close(); } catch (_) {}
  roomSessions.delete(roomId);
}

function attachStream(key, stream) {
  const tile = tiles.get(key);
  if (!tile) return;
  attachMediaStreamToVideo(tile.video, stream);
}

function renderWatchSlots() {
  if (!els.watchGrid) return;
  els.watchGrid.innerHTML = '';
  slots = [];
  for (let i = 0; i < MAX_TILES; i++) {
    const el = document.createElement('div');
    el.className = 'admin-watch-slot admin-watch-slot--empty';
    el.dataset.slotIndex = String(i);
    el.innerHTML =
      '<div class="admin-watch-slot-head">' +
        '<span class="admin-watch-drag" draggable="false" title="拖动换位" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" focusable="false">' +
            '<circle cx="9" cy="6" r="1.5" fill="currentColor"/>' +
            '<circle cx="15" cy="6" r="1.5" fill="currentColor"/>' +
            '<circle cx="9" cy="12" r="1.5" fill="currentColor"/>' +
            '<circle cx="15" cy="12" r="1.5" fill="currentColor"/>' +
            '<circle cx="9" cy="18" r="1.5" fill="currentColor"/>' +
            '<circle cx="15" cy="18" r="1.5" fill="currentColor"/>' +
          '</svg>' +
        '</span>' +
        '<span class="admin-watch-title"></span>' +
        '<div class="admin-watch-tools">' +
          '<button type="button" class="admin-watch-ctrl admin-watch-ctrl--audio" title="开启声音" aria-label="开启声音" aria-pressed="false">' +
            WATCH_CTRL_ICON.audioOn + WATCH_CTRL_ICON.audioOff +
          '</button>' +
          '<button type="button" class="admin-watch-ctrl admin-watch-ctrl--video" title="关闭画面" aria-label="关闭画面" aria-pressed="true">' +
            WATCH_CTRL_ICON.videoOn + WATCH_CTRL_ICON.videoOff +
          '</button>' +
        '</div>' +
        '<button type="button" class="admin-watch-stop" title="停止观看">×</button>' +
      '</div>' +
      '<div class="admin-watch-video-wrap">' +
        '<video class="admin-watch-video" playsinline muted autoplay></video>' +
      '</div>' +
      '<div class="admin-watch-status"></div>';
    const stopBtn = el.querySelector('.admin-watch-stop');
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.tileKey;
      if (key) stopTile(key, true);
    });
    const audioBtn = el.querySelector('.admin-watch-ctrl--audio');
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.tileKey;
      if (key) toggleTileAudio(key);
    });
    const videoBtn = el.querySelector('.admin-watch-ctrl--video');
    videoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = el.dataset.tileKey;
      if (key) toggleTileVideo(key);
    });
    els.watchGrid.appendChild(el);
    slots.push({ el, index: i, occupied: false });
  }
  updateSlotDragState();
  setupTouchSlotDrag();
}

function clearDragMarkers() {
  els.watchGrid?.querySelectorAll('.admin-watch-slot--dragging').forEach((el) => {
    el.classList.remove('admin-watch-slot--dragging');
  });
  els.watchGrid?.querySelectorAll('.admin-watch-slot--drop-target').forEach((el) => {
    el.classList.remove('admin-watch-slot--drop-target');
  });
}

function setupTouchSlotDrag() {
  if (!els.watchGrid || els.watchGrid.dataset.touchDragWired === '1') return;
  els.watchGrid.dataset.touchDragWired = '1';

  els.watchGrid.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const handle = e.target.closest('.admin-watch-drag');
    if (!handle) return;
    const slotEl = handle.closest('.admin-watch-slot');
    if (!slotEl?.dataset.tileKey) return;

    e.preventDefault();
    pointerDrag.active = true;
    pointerDrag.sourceIndex = Number(slotEl.dataset.slotIndex);
    pointerDrag.pointerId = e.pointerId;
    slotEl.classList.add('admin-watch-slot--dragging');
    handle.setPointerCapture(e.pointerId);
  });

  els.watchGrid.addEventListener('pointermove', (e) => {
    if (!pointerDrag.active || e.pointerId !== pointerDrag.pointerId) return;
    e.preventDefault();
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = hit?.closest?.('.admin-watch-slot');
    els.watchGrid.querySelectorAll('.admin-watch-slot--drop-target').forEach((el) => {
      el.classList.remove('admin-watch-slot--drop-target');
    });
    if (slotEl) slotEl.classList.add('admin-watch-slot--drop-target');
  });

  const finishPointerDrag = (e) => {
    if (!pointerDrag.active || e.pointerId !== pointerDrag.pointerId) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = hit?.closest?.('.admin-watch-slot');
    if (slotEl && pointerDrag.sourceIndex !== null) {
      const targetIndex = Number(slotEl.dataset.slotIndex);
      if (Number.isFinite(targetIndex)) {
        swapSlots(pointerDrag.sourceIndex, targetIndex);
      }
    }
    pointerDrag.active = false;
    pointerDrag.sourceIndex = null;
    pointerDrag.pointerId = null;
    clearDragMarkers();
  };

  els.watchGrid.addEventListener('pointerup', finishPointerDrag);
  els.watchGrid.addEventListener('pointercancel', finishPointerDrag);
}

function setupGridDragDrop() {
  if (!els.watchGrid) return;

  els.watchGrid.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('.admin-watch-drag');
    if (!handle) {
      e.preventDefault();
      return;
    }
    const slotEl = handle.closest('.admin-watch-slot');
    if (!slotEl?.dataset.tileKey) {
      e.preventDefault();
      return;
    }
    dragSourceIndex = Number(slotEl.dataset.slotIndex);
    slotEl.classList.add('admin-watch-slot--dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragSourceIndex));
  });

  els.watchGrid.addEventListener('dragend', () => {
    dragSourceIndex = null;
    clearDragMarkers();
  });

  els.watchGrid.addEventListener('dragover', (e) => {
    const slotEl = e.target.closest('.admin-watch-slot');
    if (!slotEl || dragSourceIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    els.watchGrid.querySelectorAll('.admin-watch-slot--drop-target').forEach((el) => {
      el.classList.remove('admin-watch-slot--drop-target');
    });
    slotEl.classList.add('admin-watch-slot--drop-target');
  });

  els.watchGrid.addEventListener('dragleave', (e) => {
    const slotEl = e.target.closest('.admin-watch-slot');
    if (slotEl) slotEl.classList.remove('admin-watch-slot--drop-target');
  });

  els.watchGrid.addEventListener('drop', (e) => {
    e.preventDefault();
    const slotEl = e.target.closest('.admin-watch-slot');
    if (!slotEl || dragSourceIndex === null) return;
    const targetIndex = Number(slotEl.dataset.slotIndex);
    slotEl.classList.remove('admin-watch-slot--drop-target');
    if (Number.isFinite(targetIndex)) {
      swapSlots(dragSourceIndex, targetIndex);
    }
    dragSourceIndex = null;
  });
}

function swapSlots(indexA, indexB) {
  if (indexA === indexB) return;
  if (indexA < 0 || indexB < 0 || indexA >= slots.length || indexB >= slots.length) return;

  [slots[indexA], slots[indexB]] = [slots[indexB], slots[indexA]];
  slots.forEach((slot, i) => {
    slot.index = i;
    slot.el.dataset.slotIndex = String(i);
  });
  slots.forEach((slot) => els.watchGrid.appendChild(slot.el));
  updateSlotDragState();
}

function updateSlotDragState() {
  slots.forEach((slot) => {
    const drag = slot.el.querySelector('.admin-watch-drag');
    if (!drag) return;
    const canDrag = slot.occupied && !!slot.el.dataset.tileKey;
    drag.draggable = canDrag;
    slot.el.classList.toggle('admin-watch-slot--draggable', canDrag);
  });
}

function allocateSlot() {
  const slot = slots.find((s) => !s.occupied);
  return slot || null;
}

function stopTile(key, updateCount) {
  const tile = tiles.get(key);
  if (!tile) return;

  closePC(tile.pc);
  tile.video.srcObject = null;
  tile.slot.el.classList.add('admin-watch-slot--empty');
  tile.slot.el.classList.remove('admin-watch-slot--active', 'admin-watch-slot--unmuted', 'admin-watch-slot--video-off');
  tile.slot.el.dataset.tileKey = '';
  tile.slot.el.querySelector('.admin-watch-title').textContent = '';
  tile.slot.el.querySelector('.admin-watch-status').textContent = '';
  tile.slot.occupied = false;
  updateSlotDragState();

  tile.video.classList.remove('admin-watch-video--hidden');
  tile.slot.el.querySelectorAll('.admin-watch-ctrl').forEach((btn) => {
    btn.classList.remove('is-active');
    btn.setAttribute('aria-pressed', 'false');
  });
  tiles.delete(key);

  const session = roomSessions.get(tile.roomId);
  if (session) {
    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount === 0 && !roomEndScheduled.has(tile.roomId)) {
      cleanupRoomSession(tile.roomId);
    }
  }

  if (updateCount) updateLiveCount();
}

function updateLiveCount() {
  if (els.liveCount) els.liveCount.textContent = tiles.size + '/' + MAX_TILES;
}

function switchMonitorTab(tab) {
  const isRooms = tab === 'rooms';
  const mainEl = document.querySelector('.admin-main');
  if (mainEl) {
    mainEl.classList.toggle('admin-main--monitor-live', tab === 'live');
  }
  if (els.monitorPage) {
    els.monitorPage.classList.toggle('admin-monitor-page--rooms', isRooms);
    els.monitorPage.classList.toggle('admin-monitor-page--live', !isRooms);
  }
  document.querySelectorAll('[data-monitor-tab]').forEach((btn) => {
    const active = btn.dataset.monitorTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (els.roomsPanel) {
    els.roomsPanel.classList.toggle('active', isRooms);
    els.roomsPanel.hidden = !isRooms;
  }
  if (els.livePanel) {
    els.livePanel.classList.toggle('active', !isRooms);
    els.livePanel.hidden = isRooms;
    els.livePanel.setAttribute('aria-hidden', isRooms ? 'true' : 'false');
  }
}

function highlightTile(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.slot.el.classList.add('admin-watch-slot--active');
  setTimeout(() => tile.slot.el.classList.remove('admin-watch-slot--active'), 1200);
}

function syncTileControls(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  const slotEl = tile.slot.el;
  const audioBtn = slotEl.querySelector('.admin-watch-ctrl--audio');
  const videoBtn = slotEl.querySelector('.admin-watch-ctrl--video');
  if (audioBtn) {
    audioBtn.classList.toggle('is-active', tile.audioOn);
    audioBtn.setAttribute('aria-pressed', tile.audioOn ? 'true' : 'false');
    audioBtn.title = tile.audioOn ? '关闭声音' : '开启声音';
    audioBtn.setAttribute('aria-label', audioBtn.title);
  }
  if (videoBtn) {
    videoBtn.classList.toggle('is-active', tile.videoOn);
    videoBtn.setAttribute('aria-pressed', tile.videoOn ? 'true' : 'false');
    videoBtn.title = tile.videoOn ? '关闭画面' : '开启画面';
    videoBtn.setAttribute('aria-label', videoBtn.title);
  }
}

function toggleTileAudio(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.audioOn = !tile.audioOn;
  tile.video.muted = !tile.audioOn;
  tile.slot.el.classList.toggle('admin-watch-slot--unmuted', tile.audioOn);
  syncTileControls(key);
}

function toggleTileVideo(key) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.videoOn = !tile.videoOn;
  tile.video.classList.toggle('admin-watch-video--hidden', !tile.videoOn);
  tile.slot.el.classList.toggle('admin-watch-slot--video-off', !tile.videoOn);
  syncTileControls(key);
}

function syncTilesWithHub(hub) {
  const roomsById = new Map((hub.rooms || []).map((r) => [r.id, r]));
  const endedRooms = new Set();

  for (const tile of tiles.values()) {
    const room = roomsById.get(tile.roomId);
    if (!room || !roomBizType(room)) {
      endedRooms.add(tile.roomId);
    }
  }

  for (const roomId of endedRooms) {
    scheduleRoomEnd(roomId, '业务已结束');
  }
}

function memberInitial(nickname) {
  const text = String(nickname || '').trim();
  if (!text) return '?';
  return text.slice(0, 1).toUpperCase();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

initAdminMonitor({
  getToken: () => window.__adminGetToken?.() || '',
  showToast: (msg) => window.__adminShowToast?.(msg),
});

window.AdminMonitor = { updateMonitorHub, stopAllWatching };
