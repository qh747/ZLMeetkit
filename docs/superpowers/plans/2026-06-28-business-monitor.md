# 业务监控（Admin Observer）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理后台新增业务监控页：房间列表 Tab（查询+选成员观看）+ 实时画面 Tab（3×3 网格，最多 9 路），支持按成员旁观与停止观看。

**Architecture:** 信令层 `isObserver` Client；Admin `/api/admin/observe/ws` 按房间复用 WS、按 tile 建 play PC；前端双 Tab + 成员选择弹窗；tileKey=`room:user:kind`。

**Tech Stack:** Go (signaling/adminauth/server), vanilla JS (ES modules), WebRTC via现有 `webrtc.js`, WebSocket

**Spec:** `docs/superpowers/specs/2026-06-28-business-monitor-design.md`

---

## File Map

| File | Responsibility |
|------|----------------|
| `backend/src/pkg/signaling/message.go` | JoinPayload.Observe, 新消息类型常量 |
| `backend/src/pkg/signaling/client.go` | isObserver 字段, join/play 限制, 拒绝 chat/record/publish |
| `backend/src/pkg/signaling/room.go` | addClient/removeClient 旁观分支, 广播排除旁观者 |
| `backend/src/pkg/signaling/stats.go` | RealMembers/Observers 统计 |
| `backend/src/pkg/signaling/hub.go` | （如需）ValidateAdminToken 委托 |
| `backend/src/pkg/adminauth/auth.go` | Logout(token), ListSessions 可选 |
| `backend/src/pkg/server/admin_audit.go` | **新建** 审计环形缓冲 |
| `backend/src/pkg/server/admin_observe.go` | **新建** Observe WS + session manager |
| `backend/src/pkg/server/admin.go` | 注册 logout/audit/observe 路由 |
| `backend/src/pkg/server/admin_dashboard.go` | kick/logout 时调用 observe 清理 |
| `backend/test/signaling/observer_test.go` | **新建** 旁观信令单测 |
| `backend/test/server/admin_observe_test.go` | **新建** Admin observe/logout/audit 单测 |
| `frontend/admin/index.html` | 新导航项 + 业务监控页 DOM |
| `frontend/admin/js/monitor.js` | **新建** 双 Tab、房间表格、筛选、成员选择弹窗 |
| `frontend/admin/js/observe.js` | **新建** 按房间 WS + 按 tile PC、WatchGrid(≤9) |
| `frontend/admin/js/admin.js` | 路由切换、logout/kick 联动、模块初始化 |
| `frontend/admin/css/admin.css` | 监控页 + 响应式网格样式 |

---

### Task 1: 信令层 — Observer 数据模型与常量

**Files:**
- Modify: `backend/src/pkg/signaling/message.go`
- Modify: `backend/src/pkg/signaling/client.go`

- [ ] **Step 1: 在 message.go 增加常量与字段**

```go
// JoinPayload 增加:
Observe bool `json:"observe,omitempty"`

// 新消息类型 (c2s/s2c):
const (
    TypeObserveJoin   = "observe-join"   // c2s (admin WS 封装层使用)
    TypeObserveJoined = "observe-joined" // s2c
    TypeObserveLeave  = "observe-leave"  // c2s
    TypeObserveEnded  = "observe-ended"  // s2c — 房间销毁
    TypeObserveError  = "observe-error"  // s2c
)
```

- [ ] **Step 2: 在 Client 结构体增加字段**

```go
type Client struct {
    // ...existing...
    isObserver bool
    adminToken string
    adminUser  string
}
```

- [ ] **Step 3: 增加辅助方法**

```go
func (c *Client) IsObserver() bool {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.isObserver
}

func (c *Client) setObserver(adminToken, adminUser string) {
    c.mu.Lock()
    c.isObserver = true
    c.adminToken = adminToken
    c.adminUser = adminUser
    c.mu.Unlock()
}
```

- [ ] **Step 4: 运行现有测试确保无破坏**

Run: `cd backend && go test ./...`
Expected: PASS（或仅既有 ZLM 相关 skip）

---

### Task 2: 信令层 — Room 旁观加入/离开逻辑

**Files:**
- Modify: `backend/src/pkg/signaling/room.go`
- Test: `backend/test/signaling/observer_test.go`

- [ ] **Step 1: 写失败测试 — observer 不广播 peer-joined**

```go
func TestObserverJoinInvisible(t *testing.T) {
    hub, cleanup := signaling.NewTestHub(t)
    defer cleanup()
    room := hub.GetOrCreateRoom("r1", signaling.RoomModeMeeting)
    peer := signaling.NewTestClient(t, hub)
    peer.Join("r1", "alice", signaling.RoomModeMeeting, "")
    obsCh := peer.Listen(signaling.TypePeerJoined)

    obs := signaling.NewTestClient(t, hub)
    obs.SetObserver("admin-tok", "admin")
    if err := room.AddObserverClient(obs); err != nil {
        t.Fatal(err)
    }

    select {
    case <-obsCh:
        t.Fatal("peer should not receive peer-joined for observer")
    case <-time.After(100 * time.Millisecond):
    }
}
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `cd backend && go test ./test/signaling/ -run TestObserverJoinInvisible -v`
Expected: FAIL — `AddObserverClient` 或 `SetObserver` 未定义

- [ ] **Step 3: 实现 `Room.addObserverClient`**

在 `room.go` 新增方法（或扩展 `addClient` 接受 observer 标志）：

```go
func (r *Room) addObserverClient(c *Client) error {
    if !c.IsObserver() {
        return errors.New("not an observer client")
    }
    r.mu.Lock()
    if cap := r.capacity(); cap > 0 && r.realMemberCountLocked() >= cap {
        // 仅计真实成员
    }
    // 旁观者 nickname 唯一性：使用内部 generated nickname，不与真实成员冲突检查放宽
    r.clients[c.UserID] = c
    r.mu.Unlock()

    peers := r.snapshotPeers(c.UserID) // snapshotPeers 需排除 isObserver
    c.send(TypeObserveJoined, "", JoinedPayload{
        UserID: c.UserID,
        Room:   r.ID,
        Peers:  peers,
    })
    r.hub.notifyStatsChanged()
    return nil
}
```

- [ ] **Step 4: 修改 `snapshotPeers` 排除 observer**

```go
for id, c := range r.clients {
    if id == excludeID || c.IsObserver() {
        continue
    }
    // ...
}
```

- [ ] **Step 5: 修改 `removeClient` — observer 离开不广播 peer-left/stream-stopped 给业务（observer 无发布流）**

Observer 离开：仅 `notifyStatsChanged()`，跳过 peer-left 广播（observer 从未 peer-joined）。

- [ ] **Step 6: 修改 `broadcastChat` 跳过 observer**

```go
for _, c := range r.clients {
    if c.IsObserver() {
        continue
    }
    c.send(TypeChat, "", payload)
}
```

- [ ] **Step 7: 修改 `broadcastExcept` 或新增 `broadcastToRealMembers` 供 record-state 使用**

`broadcastRecordState` 改为只发给非 observer 客户端。

- [ ] **Step 8: 实现 `realMemberCountLocked` 辅助函数**

- [ ] **Step 9: 运行测试 PASS**

Run: `cd backend && go test ./test/signaling/ -run TestObserver -v`

---

### Task 3: 信令层 — Client handler 限制

**Files:**
- Modify: `backend/src/pkg/signaling/client.go`
- Test: `backend/test/signaling/observer_test.go`

- [ ] **Step 1: 写测试 — observer 不能 publish**

```go
func TestObserverCannotPublish(t *testing.T) {
    // join observer, send webrtc-offer mode=publish, expect error response
}
```

- [ ] **Step 2: handleChat — observer 拒绝**

```go
func (c *Client) handleChat(env *Envelope) error {
    if c.IsObserver() {
        return errors.New("observers cannot send chat")
    }
    // ...
}
```

- [ ] **Step 3: handleRecordControl — observer 拒绝**

- [ ] **Step 4: handleWebRTCOffer — observer 仅允许 play/play-solo**

```go
if c.IsObserver() {
    switch p.Mode {
    case "play", "play-solo":
    default:
        return errors.New("observers can only play streams")
    }
}
```

- [ ] **Step 5: handleJoin — 普通 join 路径禁止 Observe flag（仅 admin WS 内部设置）**

- [ ] **Step 6: 运行测试 PASS**

---

### Task 4: Stats 分计真实成员与旁观者

**Files:**
- Modify: `backend/src/pkg/signaling/stats.go`
- Test: `backend/test/signaling/observer_test.go`

- [ ] **Step 1: 扩展结构体**

```go
type ClientBrief struct {
    // ...
    IsObserver bool `json:"isObserver,omitempty"`
}

type RoomStats struct {
    // ...
    RealMembers int `json:"realMembers"`
    Observers   int `json:"observers"`
}

type HubStats struct {
    // ...
    TotalObservers int `json:"totalObservers"`
}
```

- [ ] **Step 2: StatsSnapshot 计数逻辑**

遍历 clients：`isObserver` → `Observers++`，否则 `RealMembers++`；`Members = RealMembers + Observers`。

- [ ] **Step 3: 写测试验证计数**

- [ ] **Step 4: 补全 notifyStatsChanged 触发点**

在 `client.go`:
- publish 成功（meeting/call）后 `notifyStatsChanged()`
- stream-stopped 非 solo 时也触发
- record 状态变更后触发

---

### Task 5: Admin 认证 — Logout

**Files:**
- Modify: `backend/src/pkg/adminauth/auth.go`
- Test: `backend/test/server/admin_observe_test.go`

- [ ] **Step 1: 写测试**

```go
func TestAdminLogoutInvalidatesToken(t *testing.T) {
    auth := adminauth.New(map[string]string{"admin": "secret"})
    tok, _ := auth.Login("admin", "secret")
    if err := auth.Logout(tok); err != nil {
        t.Fatal(err)
    }
    if _, err := auth.ValidateToken(tok); err == nil {
        t.Fatal("token should be invalid after logout")
    }
}
```

- [ ] **Step 2: 实现 Logout**

```go
func (a *Auth) Logout(token string) error {
    a.mu.Lock()
    defer a.mu.Unlock()
    username, ok := a.sessions[token]
    if !ok {
        return errors.New(ErrInvalidSession)
    }
    delete(a.sessions, token)
    delete(a.byUser, username)
    return nil
}
```

- [ ] **Step 3: 运行测试 PASS**

---

### Task 6: 审计日志模块

**Files:**
- Create: `backend/src/pkg/server/admin_audit.go`
- Modify: `backend/src/pkg/server/admin.go`
- Test: `backend/test/server/admin_observe_test.go`

- [ ] **Step 1: 实现 AuditLog**

```go
type AuditEntry struct {
    Time     int64  `json:"time"`
    Username string `json:"username"`
    Action   string `json:"action"`
    Room     string `json:"room,omitempty"`
    Detail   string `json:"detail,omitempty"`
}

type AuditLog struct {
    mu      sync.Mutex
    entries []AuditEntry
    max     int
}

func (l *AuditLog) Record(username, action, room, detail string) { ... }
func (l *AuditLog) Recent(limit int) []AuditEntry { ... }
```

- [ ] **Step 2: 注册 `GET /api/admin/audit-log`**

- [ ] **Step 3: 写测试 — Record + Recent**

---

### Task 7: Observe WS 与 Session Manager

**Files:**
- Create: `backend/src/pkg/server/admin_observe.go`
- Modify: `backend/src/pkg/server/admin.go`
- Modify: `backend/src/pkg/server/admin_dashboard.go`
- Test: `backend/test/server/admin_observe_test.go`

- [ ] **Step 1: 实现 observeSessionManager**

```go
type observeSession struct {
    client   *signaling.Client
    conn     *websocket.Conn
    roomID   string
    username string
}

type observeSessionManager struct {
    hub   *signaling.Hub
    auth  *adminauth.Auth
    audit *AuditLog
    mu    sync.Mutex
    byToken map[string][]*observeSession // adminToken -> sessions
}
```

方法：
- `handleWS(w, r)` — 升级 WS，验证 admin token
- `join(token, username, room, mode, conn)` — 查找 room，创建 Client，`setObserver`，`addObserverClient`
- `leave(session)` — removeClient, 关闭 conn
- `leaveAllByToken(token, reason)` — logout/kick 时调用
- `leaveAllByRoom(roomID)` — 房间销毁时通知旁观者

- [ ] **Step 2: WS 消息循环**

```go
switch msg.Type {
case "observe-join":
    // validate room exists, mode matches, realMembers >= 1
    // push 房间需有 push 成员
case "observe-leave":
    // cleanup
case "webrtc-offer":
    // 委托给 client.handleMessage
}
```

- [ ] **Step 3: 注册路由**

```go
mux.HandleFunc("/api/admin/observe/ws", observeMgr.handleWS)
mux.HandleFunc("/api/admin/logout", ...) // POST
```

- [ ] **Step 4: admin_dashboard kickByToken 扩展**

```go
func (d *adminDashboardHub) kickByToken(token string) {
    d.observeMgr.leaveAllByToken(token, "kicked")
    // existing kick WS clients...
}
```

- [ ] **Step 5: 写集成测试**

- observer WS join 成功返回 observe-joined
- logout 后 observe WS 关闭
- audit log 有 observe_start/stop 记录

Run: `cd backend && go test ./test/server/ -run Observe -v`

---

### Task 8: 前端 — 页面结构与路由

**Files:**
- Modify: `frontend/admin/index.html`
- Modify: `frontend/admin/js/admin.js`
- Modify: `frontend/admin/css/admin.css`

- [ ] **Step 1: index.html 增加导航与页面区域**

```html
<button type="button" class="admin-nav-item" data-page="monitor" id="monitorTab">
  <span class="admin-nav-label">业务监控</span>
</button>

<section id="monitorPage" class="admin-page">
  <!-- 页内 Tab -->
  <div class="admin-monitor-segments">
    <button type="button" data-monitor-tab="rooms" class="active">房间列表</button>
    <button type="button" data-monitor-tab="live">实时画面 <span id="liveCount">0/9</span></button>
  </div>

  <!-- 房间列表 Tab -->
  <div id="monitorRoomsPanel" class="admin-monitor-panel active">
    <div class="admin-monitor-toolbar">
      <input id="monitorSearch" type="search" placeholder="搜索房间名称" />
      <select id="monitorTypeFilter">
        <option value="">全部业务类型</option>
        <option value="meeting">视频会议</option>
        <option value="call">1v1 通话</option>
        <option value="push">推流</option>
      </select>
    </div>
    <table class="admin-monitor-table" id="monitorTable">...</table>
  </div>

  <!-- 实时画面 Tab：固定 3×3 -->
  <div id="monitorLivePanel" class="admin-monitor-panel">
    <div class="admin-watch-grid" id="watchGrid"></div>
  </div>

  <!-- 成员选择对话框 -->
  <dialog id="memberPickDialog">...</dialog>
</section>
```

- [ ] **Step 2: admin.js 增加侧栏 page 切换 + monitor 页内 Tab 切换**

- [ ] **Step 3: CSS — 全端统一 3×3 网格**

```css
.admin-watch-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  gap: 6px;
  width: 100%;
  max-width: min(100vw, 960px);
  aspect-ratio: 1;
}
.admin-watch-slot {
  position: relative;
  background: var(--admin-slot-bg);
  border-radius: 8px;
  overflow: hidden;
}
.admin-watch-slot--empty { border: 1px dashed ...; }
```

---

### Task 9: 前端 — monitor.js 房间列表与成员选择

**Files:**
- Create: `frontend/admin/js/monitor.js`
- Modify: `frontend/admin/js/admin.js`

- [ ] **Step 1: 业务类型文案与列表过滤**

```javascript
const BIZ_LABEL = { meeting: '视频会议', call: '1v1 通话', push: '推流' };

function roomBizType(room) {
  if (room.mode === 'meeting') return 'meeting';
  if (room.mode === 'call') return 'call';
  if (room.mode === 'solo' && hasPushMember(room)) return 'push';
  return null; // 纯拉流，不展示
}

function filterRooms(rooms, query, typeFilter) {
  return rooms.filter(r => {
    if (!roomBizType(r)) return false;
    if (typeFilter && roomBizType(r) !== typeFilter) return false;
    if (query && !r.id.toLowerCase().includes(query.toLowerCase())) return false;
    return (r.realMembers ?? r.members) >= 1;
  });
}
```

- [ ] **Step 2: 渲染表格行**

列：**业务类型** | 房间名 | 在线人数 | 录制状态 | 操作[观看]（业务类型为第一列）

- [ ] **Step 3: 点击 [观看] — 推流直开 / 会议·1v1 弹成员选择**

```javascript
async function onWatchClick(room) {
  if (watchGrid.count >= 9) {
    showToast('已达 9 路上限，请先停止观看某路画面');
    return;
  }
  const biz = roomBizType(room);
  if (biz === 'push') {
    await watchGrid.addPushTile(room);
    switchMonitorTab('live');
    return;
  }
  openMemberPicker(room); // 展示成员 + cam/screen 可选流
}
```

- [ ] **Step 4: 成员选择对话框**

```javascript
function buildMemberOptions(room) {
  return room.clients
    .filter(c => !c.isObserver)
    .flatMap(c => {
      const opts = [];
      if (c.camOn || hasStream(c, 'cam')) opts.push({ userId: c.userId, nickname: c.nickname, kind: 'cam', label: '摄像头' });
      if (hasStream(c, 'screen')) opts.push({ userId: c.userId, nickname: c.nickname, kind: 'screen', label: '屏幕共享' });
      return opts;
    });
}
```

- [ ] **Step 5: 选定成员后 `watchGrid.addMemberTile(room, userId, kind)` 并切到实时画面 Tab**

- [ ] **Step 6: 订阅 dashboard WS hub 更新刷新表格**

---

### Task 10: 前端 — observe.js WatchGrid（≤9 tile，按房间 WS）

**Files:**
- Create: `frontend/admin/js/observe.js`
- Reuse: `frontend/js/webrtc.js`, `frontend/js/signaling.js`

- [ ] **Step 1: WatchGrid 常量与 tile 槽位**

```javascript
export const MAX_TILES = 9;

export class WatchGrid {
  constructor(rootEl, onCountChange) {
    this.tiles = new Map();       // tileKey -> { slotEl, pc, meta }
    this.roomSessions = new Map(); // roomId -> ObserveRoomSession
    this.rootEl = rootEl;
    this.renderSlots(); // 预渲染 9 个 slot
  }
}
```

- [ ] **Step 2: ObserveRoomSession — 每房间一条 WS**

```javascript
class ObserveRoomSession {
  async ensureJoined(room, mode, adminToken) {
    if (this.joined) return;
    const url = `wss://${location.host}/api/admin/observe/ws?token=...`;
    this.sig = new Signaling(url);
    await this.sig.connect();
    this.sig.send('observe-join', { room, mode });
    // await observe-joined → store peers
  }

  async playMember(userId, kind, onTrack) {
    return playStream({ signaling: this.sig, targetUserId: userId, kind, onTrack });
  }

  async playPush(streamId, onTrack) {
    return playStream({ signaling: this.sig, streamId, solo: true, onTrack });
  }

  async leaveIfIdle() { /* 无 tile 引用时 observe-leave */ }
}
```

- [ ] **Step 3: addMemberTile / addPushTile**

```javascript
async addMemberTile(room, userId, kind) {
  const tileKey = `${room.id}:${userId}:${kind}`;
  if (this.tiles.has(tileKey)) { this.focusTile(tileKey); return; }
  if (this.tiles.size >= MAX_TILES) { showToast('...'); return; }
  const session = await this.getRoomSession(room);
  const pc = await session.playMember(userId, kind, onTrack);
  this.tiles.set(tileKey, { ... });
  this.updateLiveCount();
}
```

- [ ] **Step 4: stopTile(tileKey) — 停止单路**

```javascript
stopTile(tileKey) {
  const t = this.tiles.get(tileKey);
  t.pc?.close();
  this.tiles.delete(tileKey);
  this.releaseSlot(tileKey);
  this.roomSessions.get(t.roomId)?.leaveIfIdle();
  this.updateLiveCount();
}
```

- [ ] **Step 5: 音频互斥 + tile 标题 + 停止按钮 UI**

- [ ] **Step 6: peer-stream-started 时更新成员选择可用流；已观看 tile 自动重订阅**

---

### Task 11: 前端 — Logout/Kick 联动

**Files:**
- Modify: `frontend/admin/js/admin.js`

- [ ] **Step 1: logoutBtn 改为 async**

```javascript
async function logout() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  watchGrid.stopAll(); // 先停旁观
  if (token) {
    await fetch('/api/admin/logout', { method: 'POST', headers: { 'X-Admin-Token': token } });
  }
  clearSession();
  showLogin();
}
```

- [ ] **Step 2: dashboard WS on kick — watchGrid.stopAll()**

- [ ] **Step 3: beforeunload — 尽力 observe-leave（可选 sendBeacon）**

---

### Task 12: 端到端验证

- [ ] **Step 1: 后端全量测试**

Run: `cd backend && go test ./...`
Expected: PASS

- [ ] **Step 2: 手动验证清单**

1. 登录 Admin → 业务监控 → 房间列表 Tab 表格含业务类型字段
2. 搜索 + 业务类型下拉过滤有效
3. 会议/1v1 点观看 → 成员选择弹窗 → 选某成员 cam 可观看
4. 业务侧成员列表不出现管理员
5. call 房间 2 人 + 旁观 OK
6. push 房间一键观看推流画面
7. 9 路上限提示；停止某路后可再加
8. 实时画面 Tab 固定 3×3；点击 tile 开声
9. 停止观看 / 退出登录 / 异地登录踢线均清理旁观
10. GET audit-log 有记录

---

## Spec Coverage Checklist

| Spec § | Task |
|--------|------|
| §2 A1/A2 运行中判定与 Tab | Task 4, 9 |
| §2 UI-1/UI-2 双 Tab | Task 8, 9 |
| §2 C2 3×3 / 9 路 | Task 8, 10 |
| §2 C4/C5 按成员/推流 | Task 9, 10 |
| §5 成员选择弹窗 | Task 9 |
| §5 停止观看 | Task 10 |
| §2 C6 业务侧不可见 | Task 2, 3 |
| §2 E2 审计 | Task 6, 7 |
| §2 E3 logout | Task 5, 7, 11 |
| §2 F1/F2 Admin observe WS | Task 7 |
| §4 API | Task 5, 6, 7 |
| §5 前端 UI | Task 8, 9, 10 |
| §7 异常场景 | Task 7, 10, 11 |
| §8 Stats | Task 4 |
| §9 测试 | Task 2-7, 12 |

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-business-monitor.md`.

**Two execution options:**

1. **Subagent-Driven（推荐）** — 每个 Task 派发独立 subagent，逐 Task 审查
2. **Inline Execution** — 本会话按 Task 顺序连续实现，每 2-3 个 Task 汇报检查点

请确认 spec + plan 无异议后，告知选择哪种执行方式，我再开始写代码。
