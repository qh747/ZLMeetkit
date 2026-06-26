(function () {
  const TOKEN_KEY = 'zlmeetkit_admin_token';
  const LOGIN_AT_KEY = 'zlmeetkit_admin_login_at';
  const WS_RECONNECT_MS = 3000;

  const loginView = document.getElementById('loginView');
  const appView = document.getElementById('appView');
  const loginForm = document.getElementById('loginForm');
  const loginToken = document.getElementById('loginToken');
  const loginSubmit = document.getElementById('loginSubmit');
  const logoutBtn = document.getElementById('logoutBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const totalRoomsEl = document.getElementById('totalRooms');
  const totalClientsEl = document.getElementById('totalClients');
  const dashboardTab = document.getElementById('dashboardTab');
  const sessionDuration = document.getElementById('sessionDuration');
  const roomCards = document.getElementById('roomCards');

  let dashboardWs = null;
  let wsReconnectTimer = null;
  let wsManualClose = false;
  let sessionTimer = null;
  let loginAlertDialog = null;
  let loginAlertTitle = null;
  let loginAlertMessage = null;

  function ensureLoginAlert() {
    if (loginAlertDialog) return;

    loginAlertDialog = document.createElement('dialog');
    loginAlertDialog.className = 'app-alert-dialog admin-login-alert-dialog';
    loginAlertDialog.innerHTML =
      '<div class="app-alert-head">' +
        '<span class="app-alert-icon" aria-hidden="true">!</span>' +
        '<h2 class="app-alert-title"></h2>' +
      '</div>' +
      '<p class="app-alert-message"></p>' +
      '<div class="app-alert-actions">' +
        '<button type="button" class="primary app-alert-ok">确定</button>' +
      '</div>';

    document.body.appendChild(loginAlertDialog);
    loginAlertTitle = loginAlertDialog.querySelector('.app-alert-title');
    loginAlertMessage = loginAlertDialog.querySelector('.app-alert-message');

    loginAlertDialog.querySelector('.app-alert-ok').addEventListener('click', function () {
      loginAlertDialog.close();
    });
    loginAlertDialog.addEventListener('click', function (e) {
      if (e.target === loginAlertDialog) loginAlertDialog.close();
    });
  }

  function showLoginAlert(message, title) {
    ensureLoginAlert();
    loginAlertTitle.textContent = title || '登录失败';
    loginAlertMessage.textContent = message;

    if (typeof loginAlertDialog.showModal === 'function') {
      loginAlertDialog.showModal();
    } else {
      loginAlertDialog.setAttribute('open', '');
    }
  }

  const ROOM_TYPES = [
    {
      key: 'meeting',
      label: '会议房间',
      desc: '多人视频会议',
      icon: '👥',
      statKind: 'rooms-online',
    },
    {
      key: 'call',
      label: '1v1 通话房间',
      desc: '双人实时通话',
      icon: '📞',
      statKind: 'rooms-online',
    },
    {
      key: 'solo',
      label: '推/拉流房间',
      desc: '单向推流或拉流',
      statKind: 'push-play',
    },
  ];

  function renderRoomIcon(type) {
    if (type.key === 'solo') {
      return (
        '<div class="admin-room-card-icon admin-room-card-icon--stream" aria-hidden="true">' +
          '<svg class="admin-room-card-stream-svg" viewBox="0 0 24 24" focusable="false">' +
            '<path class="admin-room-card-stream-up" d="M12 5v4.5M8.5 9L12 5.5 15.5 9" />' +
            '<path class="admin-room-card-stream-divider" d="M6 12h12" />' +
            '<path class="admin-room-card-stream-down" d="M12 19v-4.5M8.5 15L12 18.5 15.5 15" />' +
          '</svg>' +
        '</div>'
      );
    }
    return '<div class="admin-room-card-icon" aria-hidden="true">' + type.icon + '</div>';
  }

  function soloPushPullCounts(hub) {
    var push = 0;
    var pull = 0;
    (hub.rooms || []).forEach(function (room) {
      if (room.mode !== 'solo') return;
      (room.clients || []).forEach(function (client) {
        if (client.soloRole === 'play') pull++;
        else push++;
      });
    });
    return { push: push, pull: pull };
  }

  function renderStatBlock(value, label, extraClass) {
    return (
      '<div class="admin-room-card-stat' + (extraClass ? ' ' + extraClass : '') + '">' +
        '<div class="admin-room-card-value">' + value + '</div>' +
        '<div class="admin-room-card-sub">' + label + '</div>' +
      '</div>'
    );
  }

  function renderCardStats(type, hub, byMode, clientsByMode) {
    if (type.statKind === 'push-play') {
      var solo = soloPushPullCounts(hub);
      return (
        '<div class="admin-room-card-stats admin-room-card-stats--dual">' +
          renderStatBlock(solo.push, '推流', 'admin-room-card-stat--push') +
          renderStatBlock(solo.pull, '拉流', 'admin-room-card-stat--play') +
        '</div>'
      );
    }

    var rooms = byMode[type.key] || 0;
    var clients = clientsByMode[type.key] || 0;
    return (
      '<div class="admin-room-card-stats admin-room-card-stats--dual">' +
        renderStatBlock(rooms, '房间') +
        renderStatBlock(clients, '人在线') +
      '</div>'
    );
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  function showLogin() {
    loginView.classList.add('is-active');
    loginView.setAttribute('aria-hidden', 'false');
    appView.classList.remove('is-active');
    appView.setAttribute('aria-hidden', 'true');
    stopDashboardWs(true);
    stopSessionTimer();
    loginSubmit.disabled = false;
    loginSubmit.textContent = '登录';
  }

  function showApp() {
    loginView.classList.remove('is-active');
    loginView.setAttribute('aria-hidden', 'true');
    appView.classList.add('is-active');
    appView.setAttribute('aria-hidden', 'false');
    beginSession();
    connectDashboardWs();
  }

  function getLoginAt() {
    const raw = sessionStorage.getItem(LOGIN_AT_KEY);
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  }

  function beginSession() {
    if (!getLoginAt()) {
      sessionStorage.setItem(LOGIN_AT_KEY, String(Date.now()));
    }
    startSessionTimer();
  }

  function endSession() {
    sessionStorage.removeItem(LOGIN_AT_KEY);
    stopSessionTimer();
    if (sessionDuration) sessionDuration.textContent = '00:00:00';
  }

  function stopSessionTimer() {
    if (sessionTimer) {
      clearInterval(sessionTimer);
      sessionTimer = null;
    }
  }

  function startSessionTimer() {
    stopSessionTimer();
    updateSessionDuration();
    sessionTimer = setInterval(updateSessionDuration, 1000);
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return (
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0')
    );
  }

  function updateSessionDuration() {
    if (!sessionDuration) return;
    const loginAt = getLoginAt();
    sessionDuration.textContent = formatDuration(loginAt ? Date.now() - loginAt : 0);
  }

  function dashboardWsUrl(token) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/api/admin/ws?token=' + encodeURIComponent(token);
  }

  function clearWsReconnectTimer() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  }

  function scheduleWsReconnect() {
    if (wsManualClose || wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(function () {
      wsReconnectTimer = null;
      connectDashboardWs();
    }, WS_RECONNECT_MS);
  }

  function stopDashboardWs(manual) {
    wsManualClose = manual;
    clearWsReconnectTimer();
    if (dashboardWs) {
      dashboardWs.close();
      dashboardWs = null;
    }
    wsManualClose = false;
  }

  function connectDashboardWs() {
    const token = getToken();
    if (!token || !appView.classList.contains('is-active')) return;

    stopDashboardWs(true);
    wsManualClose = false;

    const ws = new WebSocket(dashboardWsUrl(token));
    dashboardWs = ws;

    ws.onmessage = function (event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.error(e);
        return;
      }
      if (data.type === 'dashboard') {
        applyDashboard(data);
      }
    };

    ws.onclose = function () {
      if (dashboardWs === ws) dashboardWs = null;
      if (!wsManualClose && getToken() && appView.classList.contains('is-active')) {
        scheduleWsReconnect();
      }
    };
  }

  function requestDashboardRefresh() {
    if (dashboardWs && dashboardWs.readyState === WebSocket.OPEN) {
      dashboardWs.send(JSON.stringify({ type: 'refresh' }));
      return;
    }
    loadDashboard();
  }

  function applyDashboard(data) {
    const hub = data.hub || {};
    if (totalRoomsEl) totalRoomsEl.textContent = hub.totalRooms != null ? hub.totalRooms : 0;
    if (totalClientsEl) totalClientsEl.textContent = hub.totalClients != null ? hub.totalClients : 0;
    renderRoomCards(hub);
  }

  async function apiLogin(token) {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return res.json();
  }

  async function apiDashboard(token) {
    const res = await fetch('/api/admin/dashboard', {
      headers: { 'X-Admin-Token': token },
    });
    if (res.status === 401) {
      return { unauthorized: true };
    }
    if (!res.ok) {
      throw new Error('请求失败 HTTP ' + res.status);
    }
    return res.json();
  }

  function renderRoomCards(hub) {
    const byMode = hub.roomsByMode || {};
    const clientsByMode = hub.clientsByMode || {};

    roomCards.innerHTML = ROOM_TYPES.map(function (type) {
      return (
        '<article class="admin-room-card admin-room-card--' + type.key + '">' +
          '<div class="admin-room-card-head">' +
            renderRoomIcon(type) +
            '<h3 class="admin-room-card-label">' + type.label + '</h3>' +
          '</div>' +
          '<p class="admin-room-card-desc">' + type.desc + '</p>' +
          renderCardStats(type, hub, byMode, clientsByMode) +
        '</article>'
      );
    }).join('');
  }

  async function loadDashboard() {
    const token = getToken();
    if (!token) {
      showLogin();
      return null;
    }

    try {
      const data = await apiDashboard(token);
      if (data.unauthorized) {
        setToken('');
        endSession();
        showLogin();
        showLoginAlert('登录已过期，请重新输入令牌', '登录已过期');
        return null;
      }
      applyDashboard(data);
      return data;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function tryRestoreSession() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = '验证中…';

    try {
      const data = await apiDashboard(token);
      if (data.unauthorized) {
        setToken('');
        endSession();
        showLogin();
        return;
      }
      showApp();
      applyDashboard(data);
    } catch (e) {
      setToken('');
      endSession();
      showLogin();
      showLoginAlert('无法验证登录状态，请重新登录');
      console.error(e);
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    }
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const token = loginToken.value.trim();
    if (!token) {
      showLoginAlert('请输入登录令牌');
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = '登录中…';

    try {
      const res = await apiLogin(token);
      if (!res.ok) {
        showLoginAlert(res.message || '登录失败，请检查令牌是否正确');
        return;
      }

      setToken(token);
      loginToken.value = '';
      sessionStorage.setItem(LOGIN_AT_KEY, String(Date.now()));
      showApp();
    } catch (err) {
      showLoginAlert('网络错误，请稍后重试');
      console.error(err);
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    }
  });

  logoutBtn.addEventListener('click', function () {
    setToken('');
    endSession();
    loginToken.value = '';
    showLogin();
  });

  refreshBtn.addEventListener('click', requestDashboardRefresh);

  if (dashboardTab) {
    dashboardTab.addEventListener('click', function () {
      document.querySelectorAll('.admin-nav-item').forEach(function (el) {
        el.classList.toggle('active', el === dashboardTab);
      });
      requestDashboardRefresh();
    });
  }

  tryRestoreSession();
})();
