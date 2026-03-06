
# 安装指南

## 前置条件

- OpenClaw Gateway 已安装并可运行（`openclaw gateway run`）
- Node.js 22+

---

## package.json 必填字段

`package.json` 中必须包含 `"openclaw": { "extensions": [...] }` 字段，否则 `openclaw plugins install` 会报错：

```
package.json missing openclaw.extensions
```

本插件的 `package.json` 已包含该字段：

```json
{
  "name": "agent-r2r",
  "openclaw": {
    "extensions": ["./index.js"]
  }
}
```

如果你 fork 或复制本插件，**务必保留此字段**，并将 `"./index.js"` 改为实际入口文件路径。

---

## 方式一：本地链接安装（推荐开发/测试）

```bash
# 将本插件目录链接到 OpenClaw（不复制文件，修改即生效）
openclaw plugins install -l /path/to/plugins/agent-r2r

# 启用插件
openclaw plugins enable agent-r2r

# 验证已加载
openclaw plugins list
```

重启 Gateway 后生效：

```bash
# macOS：通过菜单栏 App 重启
# 或命令行：
pkill -f openclaw-gateway && openclaw gateway run
```

---

## 方式二：从本地目录安装（复制到 state 目录）

```bash
openclaw plugins install /path/to/plugins/agent-r2r
openclaw plugins enable agent-r2r
```

---

## 方式三：手动写入配置文件

编辑 `~/.openclaw/config.yaml`（或 `~/.openclaw/config.json`）：

```yaml
plugins:
  enabled: true
  allow:
    - agent-r2r
  load:
    paths:
      - /path/to/plugins/agent-r2r
  entries:
    agent-r2r:
      enabled: true
      config:
        displayLayerEnabled: false   # 可选：是否默认在 Channel 侧展示 R2R 消息
```

---

## 插件配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `displayLayerEnabled` | boolean | `false` | R2R 消息的默认 `notifyUser` 值。`true` 表示消息会在 Channel 侧（如 Telegram/WhatsApp）显示 |

---

## 验证插件已正常加载

```bash
# 查看插件状态
openclaw plugins list

# 查看详细信息
openclaw plugins info agent-r2r

# 检查是否有加载错误
openclaw plugins doctor
```

期望输出示例：

```
agent-r2r   0.2.0   loaded   tools: send_r2r_message, receive_r2r_messages
```

---

## 测试 gateway 方法

Gateway 启动后，可通过 CLI 或 HTTP 直接调用 `r2r.send` 和 `r2r.status`：

### 查询队列状态

```bash
openclaw gateway call r2r.status
```

返回示例：

```json
{
  "ok": true,
  "pendingQueues": {
    "agentB": 2
  },
  "totalPending": 2
}
```

### 向 Agent 注入 R2R 消息

```bash
openclaw gateway call r2r.send '{
  "toAgent": "agentB",
  "fromAgent": "test-injector",
  "body": {
    "themeId": "task_001",
    "themeTitle": "测试任务",
    "purpose": "request",
    "content": "请执行数据汇总"
  },
  "metadata": {
    "notifyUser": false
  }
}'
```

---

## 跨 Channel 注入（WhatsApp / Telegram 等）

向任意已配置的 Channel 发送以下格式的 JSON 消息，插件会自动将其路由进 R2R 总线：

```json
{
  "r2r": {
    "toAgent": "agentB",
    "body": {
      "themeId": "task_001",
      "purpose": "request",
      "content": "来自 WhatsApp 的任务请求"
    }
  }
}
```

> 注意：消息内容必须是合法 JSON 且包含顶层 `"r2r"` 键，否则会被忽略（不影响正常消息处理）。

---

## Agent 使用示例

插件启用后，每个 Agent 会话自动获得以下两个工具，无需额外配置。

### 发送 R2R 消息

Agent 在对话中调用：

```
send_r2r_message(
  toAgent="agentB",
  themeId="task_001",
  themeTitle="数据汇总",
  purpose="request",
  content="请汇总本周销售数据并返回结果",
  notifyUser=false
)
```

返回：

```json
{
  "ok": true,
  "messageId": "3cd152b3-bfef-4183-b358-0b42cfeeb471",
  "timestamp": "2026-03-06T10:00:00.000Z"
}
```

### 接收 R2R 消息

```
receive_r2r_messages(maxMessages=10)
```

返回：

```json
{
  "messages": [
    {
      "header": {
        "messageId": "3cd152b3-...",
        "fromAgent": "agentA",
        "toAgent": "agentB",
        "timestamp": "2026-03-06T10:00:00.000Z",
        "priority": "normal"
      },
      "body": {
        "themeId": "task_001",
        "themeTitle": "数据汇总",
        "purpose": "request",
        "content": "请汇总本周销售数据并返回结果",
        "deliverables": []
      },
      "metadata": {
        "notifyUser": false,
        "tags": []
      }
    }
  ],
  "pending": 0
}
```

> 收到 `purpose: "request"` 的消息时会自动回送一条 `ack` 消息给发送方，无需手动处理。

---

## 卸载

```bash
openclaw plugins disable agent-r2r
openclaw plugins uninstall agent-r2r
```

---

## 常见问题

**安装报错：`package.json missing openclaw.extensions`**

`package.json` 中缺少 `"openclaw": { "extensions": ["./index.js"] }` 字段。添加后重新执行安装命令即可。

**插件加载失败：`missing config schema`**

确认插件目录下存在 `openclaw.plugin.json` 文件，且包含合法的 `configSchema` 字段。

**工具未出现在 Agent 中**

检查插件状态是否为 `loaded`（不是 `disabled` 或 `error`）：

```bash
openclaw plugins info agent-r2r
```

**消息队列积压**

Gateway 重启后队列会自动清空。如需持久化，可在插件的 `registerService` 中添加写盘逻辑（当前版本为内存存储）。
