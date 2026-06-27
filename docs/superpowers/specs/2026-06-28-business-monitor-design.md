# 业务监控（Admin Observer）设计规格

**日期：** 2026-06-28  
**修订：** 2026-06-28 v2（页面布局与观看粒度调整）  
**状态：** 待用户最终确认后实施

---

## 1. 目标

在管理后台新增「业务监控」功能，使管理员可以：

1. 查看所有**正在运行中**的业务（房间列表 Tab，业务类型以字段展示）
2. 按房间名称、业务类型过滤搜索
3. 以**只读旁观**方式观看：会议/1v1 **按成员选择**画面，推流 **直接观看推流方**
4. 实时画面 Tab 提供 **3×3 固定网格**（全端一致），最多同时 **9 路**画面
5. 超过 9 路时提示需先停止某路；每路支持「停止观看」
6. 管理员退出或被踢线时，自动断开所有旁观连接
7. 记录审计日志；支持服务端 logout

---

## 2. 已确认需求

| 编号 | 决策 |
|------|------|
| A1 | 「运行中」= 房间内有 ≥1 名**真实成员**（不含管理员旁观） |
| A2 | **拉流房间不展示、不可旁观**；业务类型在列表中以字段展示（非 Tab 分类） |
| UI-1 | 业务监控页两个 Tab：**房间列表** / **实时画面** |
| UI-2 | 房间列表：信息展示 + 查询；实时画面：3×3 网格 + 实时视频 |
| C1 | Admin 内嵌多路视频网格（位于「实时画面」Tab） |
| C2 | **全端统一 3×3 网格**；上限 **9 路**（对应会议最多 9 人） |
| C3 | 默认静音，点击某路才开声 |
| C4 | 会议/1v1：**选择某房间中的某个成员**的画面（cam 或 screen，按成员实际流） |
| C5 | 推流：直接观看推流方，无需选成员 |
| C6-limit | 已有 9 路时，新观看请求提示「请先停止观看某路画面」 |
| C6-stop | 每路 tile 提供「停止观看」 |
| C6 | 旁观者在业务侧：chat 不可见、录制状态不可见、ZLM 流列表不可见 |
| E2 | 需要审计日志 |
| E3 | 需要 `POST /api/admin/logout` |
| F1 | 旁观信令走 Admin 端口 `/api/admin/observe/ws` |
| F2 | 旁观 join 使用 Admin Token 鉴权，不要求业务 token |
| 方案 | **方案 A**：信令层新增 observer Client |

### 2.1 默认约定（用户未单独确认，按合理默认）

| 项 | 默认 |
|----|------|
| B1 房间名称 | 信令层 `room` ID（即 ZLM app） |
| B2 过滤交互 | 房间列表 Tab 内：搜索框（房间名）+ 业务类型下拉筛选 |
| B3 昵称搜索 | V1 不做，仅搜房间名 |
| A3 列表字段 | 房间名、在线人数、是否录制、成员昵称摘要 |
| A4 空房间 | 不展示（最后一人离开即销毁） |
| D1 退出业务 | 仅断开管理员旁观连接，不强制结束业务 |
| D2 主动退出 | 先断开全部旁观，再清 token |
| D3 被踢线 | kick → 断开全部旁观 → 登录页 |
| D4 断网 | WS 超时（60s）后服务端清理旁观 |
| D5 停止观看 | 每路 tile 提供「停止观看」 |
| E1 权限 | 所有 Admin 账号权限相同 |
| F3 列表刷新 | 补全 `notifyStatsChanged` + 复用 Dashboard WS |
| C7 多管理员 | 允许多人同时旁观同一房间，互不可见 |

---

## 3. 架构

```
Admin UI (9443)
├── Dashboard WS          → 房间列表实时数据 (hub.rooms)
├── Observe WS × R (按房间) → 每房间最多 1 条旁观 WS，可拉多路成员流
└── 实时画面 tiles (≤9)  → 每 tile 一路 play（room+member+kind）
└── POST /api/admin/logout → 清理 session + 全部旁观

Admin Server
├── adminDashboardHub     (已有)
├── observeSessionManager (新增) — 按 adminToken 追踪旁观 Client
└── auditLog              (新增) — 内存环形缓冲 + zerolog

Signaling Hub (共享)
├── Room
│   ├── 真实 Client
│   └── Observer Client (isObserver=true)
│       ├── 不占 call 名额
│       ├── 不广播 peer-joined/left
│       ├── 不出现在 snapshotPeers
│       ├── 不收 chat / record-state
│       └── 仅 webrtc-offer play / play-solo
└── StatsSnapshot — 真实成员与旁观者分计
```

### 3.1 旁观 Client 语义

| 行为 | 真实成员 | 旁观者 |
|------|----------|--------|
| join 广播 peer-joined | ✓ (meeting/call) | ✗ |
| 出现在 joined.peers | ✓ | ✗ |
| call 房间占名额 | ✓ | ✗ |
| 发送 chat | ✓ | ✗（服务端拒绝） |
| 接收 chat | ✓ | ✗ |
| 接收 record-state | ✓ | ✗ |
| record-start/stop | ✓ | ✗（服务端拒绝） |
| publish / publish-solo | ✓ | ✗（服务端拒绝） |
| play / play-solo | ✓ | ✓ |
| 接收 peer-stream-started/stopped | ✓ | ✓（用于自动拉流） |
| 向 ZLM 发布流 | 可能 | **永不** |
| Admin 统计 clients 列表 | 展示 | 标记 `isObserver`，不计入 members |

### 3.2 C6「ZLM 流列表不可见」

旁观者仅发起 WebRTC **play**（订阅），不在 ZLM 上注册 publish 流；业务侧流列表来自信令 `peer.streams`，旁观者不在 peer 列表中，故业务 UI 不会看到旁观者相关流。

---

## 4. API 与信令

### 4.1 新增 HTTP

#### `POST /api/admin/logout`

- Header: `X-Admin-Token`
- 行为：invalidate token → 断开该 token 下所有 Observe WS → 写审计日志
- 响应：`{ "ok": true }`

#### `GET /api/admin/audit-log?limit=50`

- Header: `X-Admin-Token`
- 响应：`{ "entries": [ { "time", "username", "action", "room", "detail" } ] }`
- V1 仅内存保留最近 200 条

### 4.2 新增 WebSocket：`GET /api/admin/observe/ws?token=<adminToken>`

**连接后客户端 → 服务端：**

```json
{ "type": "observe-join", "room": "room-001", "mode": "meeting" }
```

`mode`: `meeting` | `call` | `solo`（推流）

**服务端 → 客户端：**

```json
{ "type": "observe-joined", "room": "room-001", "mode": "meeting", "peers": [...] }
```

`peers` 结构与业务 `joined.peers` 相同，**仅含真实成员**。

**后续：** 复用现有 `webrtc-offer`（play / play-solo）、`peer-stream-started/stopped` 等 s2c 消息；旁观者不发 chat / record / publish。

**错误：**

```json
{ "type": "observe-error", "message": "room not found" }
```

**observe-leave（客户端主动）：**

```json
{ "type": "observe-leave" }
```

### 4.3 JoinPayload 扩展（内部）

```go
type JoinPayload struct {
    // ...existing...
    Observe    bool   `json:"observe,omitempty"`
    AdminToken string `json:"adminToken,omitempty"` // observe WS 内部使用
}
```

`Client` 新增字段：

```go
isObserver bool
adminToken string // 用于 session 管理与审计
adminUser  string
```

---

## 5. 前端 UI

### 5.1 导航

侧栏新增 **「业务监控」**，与「监控面板」并列。

### 5.2 业务监控页 — 双 Tab 结构

```
┌──────────────────────────────────────────────────┐
│  [ 房间列表 ]  [ 实时画面 (3/9) ]   ← 页内 Tab    │
├──────────────────────────────────────────────────┤
│ ▼ 房间列表 Tab                                    │
│  [搜索: 房间名称]  [业务类型: 全部 ▼]              │
│  ┌──────────┬────────┬──────┬────────┬────────┐ │
│  │ 业务类型 │ 房间名 │ 人数 │ 录制   │ 操作   │ │
│  ├──────────┼────────┼──────┼────────┼────────┤ │
│  │ 视频会议 │ room-1 │  5   │ 录制中 │ [观看] │ │
│  │ 1v1通话  │ room-2 │  2   │   —    │ [观看] │ │
│  │ 推流     │ room-3 │  1   │   —    │ [观看] │ │
│  └──────────┴────────┴──────┴────────┴────────┘ │
├──────────────────────────────────────────────────┤
│ ▼ 实时画面 Tab                                    │
│  固定 3×3 网格（手机 / Pad / 电脑一致）            │
│  ┌────┐ ┌────┐ ┌────┐                           │
│  │ T1 │ │ T2 │ │ T3 │                           │
│  ├────┤ ├────┤ ├────┤                           │
│  │ T4 │ │ T5 │ │ T6 │                           │
│  ├────┤ ├────┤ ├────┤                           │
│  │ T7 │ │ T8 │ │ T9 │                           │
│  └────┘ └────┘ └────┘                           │
│  空槽位显示占位；有画面时显示 video + 停止按钮      │
└──────────────────────────────────────────────────┘
```

### 5.3 业务类型字段映射

| 后端条件 | 展示文案 |
|----------|----------|
| `mode === 'meeting'` | 视频会议 |
| `mode === 'call'` | 1v1 通话 |
| `mode === 'solo'` 且有 push 成员 | 推流 |

列表仅包含「运行中」房间：`realMembers >= 1`，且非纯拉流 solo 房间。

### 5.4 观看流程

#### 推流

1. 房间列表点击 **[观看]**
2. 若已有 9 路 → 弹窗/toast：「已达 9 路上限，请先停止观看某路画面」
3. 否则直接创建 tile，订阅 push 端 `streamId`（play-solo）
4. **自动切换到「实时画面」Tab**

#### 视频会议 / 1v1

1. 房间列表点击 **[观看]** → 弹出 **成员选择对话框**
2. 列表展示该房间真实成员：昵称、可用流（摄像头 / 屏幕共享，无流则灰显）
3. 管理员点选 **某一成员的某一路流**（cam 或 screen）
4. 若已有 9 路 → 同上提示；若同 `room+userId+kind` 已在看 → 切到实时画面并高亮该 tile
5. 创建 tile，对该成员发起 `play`（meeting/call）或 `play-solo`（不适用）
6. **自动切换到「实时画面」Tab**

#### Tile 唯一键

```
tileKey = `${roomId}:${targetUserId}:${kind}`   // meeting/call, kind=cam|screen
tileKey = `${roomId}:push:${streamId}`          // 推流
```

### 5.5 Tile 交互（实时画面 Tab）

- 标题：`房间名 · 成员昵称 · 流类型`（推流：`房间名 · 推流`）
- 默认 `<video muted>`；点击 tile 开声（同时仅一路非静音）
- 右上角 **「停止观看」**：关闭该路 PC；若为该房间最后一路则 `observe-leave` 并关闭房间 WS
- 状态：连接中 / 观看中 / 暂无画面 / 业务已结束 / 连接失败（失败可重试）
- 空槽位（未占满 9 路）：虚线占位，不显示 video

### 5.6 房间列表查询

| 控件 | 行为 |
|------|------|
| 搜索框 | `room.id` 模糊匹配（忽略大小写） |
| 业务类型下拉 | 全部 / 视频会议 / 1v1 通话 / 推流 |
| 数据来源 | Dashboard WS `hub.rooms` 实时刷新 |

### 5.7 生命周期联动

| 事件 | 行为 |
|------|------|
| 新观看且已有 9 路 | 阻止，提示先停止某路 |
| 停止观看（单 tile） | 释放 PC；末路则 observe-leave |
| 退出登录 / kick | 停止全部 tile + logout API |
| 房间从列表消失 | 该房间相关 tile 显示「业务已结束」，5s 后移除 |
| 成员离房 | 对应 tile 显示「成员已离开」，保留槽位可手动停止 |
| 成员断流 | tile「暂无画面」；重推后自动重订阅 |

### 5.8 响应式网格 CSS

**全端统一 3×3**（会议最多 9 人，与业务上限对齐）：

```css
.admin-watch-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  gap: 6px;
  aspect-ratio: 1; /* 或 min-height 按视口适配 */
}
/* 小屏：格子缩小但保持 3×3，不改为 2×2 */
```

### 5.9 旁观连接模型（前端）

- **按房间复用 WS**：同一 `roomId` 仅 1 条 `observe` WebSocket
- **按 tile 建 PC**：每个 `tileKey` 独立 `RTCPeerConnection` + play
- 停止某 tile 不影响同房间其他 tile；末 tile 停止时才 leave 房间

---

## 6. 审计日志

| action | 触发 |
|--------|------|
| `observe_start` | observe-join 成功 |
| `observe_stop` | observe-leave / WS 断开 / logout / kick |
| `logout` | POST /api/admin/logout |
| `login_kicked` | 被新登录踢线（已有 kick，扩展写审计） |

字段：`time` (ms), `username`, `action`, `room`, `detail` (JSON string)

同时 `log.Info()` 结构化输出到服务端日志。

---

## 7. 异常场景处理

| 场景 | 处理 |
|------|------|
| 旁观时房间销毁 | s2c `observe-ended` → tile 提示并清理 |
| 参与者断流 | 收到 peer-stream-stopped，移除对应 video；重推则自动重订阅 |
| 推流端停止推流 | tile 显示「暂无画面」，房间仍在列表则保留 tile |
| Observe WS 断线 | 前端 3s 重连 1 次；失败提示手动重试 |
| 已达 9 路上限 | 阻止新加入，提示先停止某路 |
| 重复观看同 tileKey | 切换到实时画面 Tab 并高亮已有 tile |
| Admin token 失效 | 全部旁观断开，跳转登录 |
| call 已满（2 真实用户） | 旁观仍可加入 |
| ZLM play 失败 | tile 显示错误，提供重试按钮 |
| 服务端重启 | 连接丢失；重登后需重新加入 |
| 浏览器关 tab | WS 超时后服务端清理 + audit observe_stop |

---

## 8. Stats 变更

`ClientBrief` 增加 `isObserver bool`。

`RoomStats` 增加：

```go
RealMembers int `json:"realMembers"` // 不含旁观者
Observers   int `json:"observers"`
```

`HubStats` 增加 `TotalObservers int`。

列表页使用 `realMembers` 判断「运行中」与展示人数。

`notifyStatsChanged` 补充触发点：

- meeting/call publish 成功（`handleWebRTCOffer` publish 分支）
- stream-stopped（meeting/call cam/screen）
- record-start/stop（broadcastRecordState 前）
- observer join/leave

---

## 9. 测试范围

### 后端

- observer join 不触发 peer-joined
- observer 不占 call capacity（2 真实用户 + 1 observer OK）
- observer 不能 publish/chat/record
- observer 不在 snapshotPeers / Stats 真实成员计数
- logout 断开所有旁观
- kick 断开旁观 + 写审计
- audit-log API

### 前端

- 双 Tab 切换、列表筛选
- 成员选择对话框
- 9 路上限与停止观看
- 静音/开声切换
- kick/logout 清理

---

## 10. 不在 V1 范围

- 按成员昵称搜索
- 强制踢人 / 关房运维操作
- 审计日志持久化到文件/DB
- 观看路数可配置（硬编码 9）
- 同时观看同一成员 cam + screen 需占 2 个槽位（按两路 tile 计）
- 非聚焦 tile 降码率

---

## 11. 主要改动文件

| 层 | 文件 |
|----|------|
| 信令 | `message.go`, `client.go`, `room.go`, `stats.go`, `hub.go` |
| Admin 服务 | `admin.go`, `admin_observe.go`(新), `admin_audit.go`(新), `admin_dashboard.go` |
| Admin 认证 | `adminauth/auth.go`（Logout 方法） |
| 前端 | `admin/index.html`, `admin/js/admin.js`, `admin/js/monitor.js`(新), `admin/js/observe.js`(新), `admin/css/admin.css` |
| 测试 | `backend/test/signaling/observer_test.go`(新), `backend/test/server/admin_observe_test.go`(新) |
