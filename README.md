# 凤姐转运 - 订单管理系统

## 项目概述

前端静态网站托管在 GitHub Pages，后端逻辑和数据库全部在 Cloudflare。微信消息处理（待完成）计划部署在 Render。

| 组件 | 平台 | URL / 状态 |
|---|---|---|
| 前端（index.html / admin.html） | GitHub Pages | `https://marcel-iam.github.io/fengjiezhuanyun/` |
| API + 业务逻辑 | Cloudflare Worker | `https://fengjiezhuanyun.yamhl12.workers.dev` |
| 自定义域名（Worker） | Cloudflare | `https://wx.marceliam.com` |
| 数据库 | Cloudflare D1 | 绑定名称：`DB` |
| 微信消息处理 | Render（待部署） | 部署后指向 `wx.marceliam.com` |

GitHub 仓库：
- 前端：`Marcel-Iam/fengjiezhuanyun`
- 微信服务：`Marcel-Iam/fengjiezhuanyun-wx`（待创建）


## 文件结构

```
GitHub repo (fengjiezhuanyun) — 前端：
├── index.html          客户下单页面（含 AI 聊天窗口）
└── admin.html          管理后台

GitHub repo (fengjiezhuanyun-wx) — 微信服务（待创建）：
├── index.js            Express 服务，处理微信 Webhook
└── package.json

Cloudflare Worker:
└── worker.js           所有 API 逻辑（含微信 Webhook 代码，待清理）

Cloudflare D1 (fengjiezhuanyun):
├── orders 表           订单数据
└── products 表         产品列表
```


## 数据库结构

### orders 表

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  created_by TEXT,
  paid_status INTEGER DEFAULT 0,
  picked_up INTEGER DEFAULT 0,
  shipped INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual',
  incoming TEXT,   -- JSON 字符串
  outgoing TEXT    -- JSON 字符串
);
```

订单对象结构：

```json
{
  "id": "ORD_1715200000001_a1b2",
  "created_at": "2025-05-08T10:30:00.000Z",
  "created_by": "小陈",
  "paid_status": false,
  "picked_up": false,
  "shipped": false,
  "source": "manual",
  "incoming": [
    {
      "express_code": "DD20250508001",
      "pickup_code": "8832",
      "products": [
        { "product_id": "p001", "product_name": "产品A", "quantity": 20 }
      ]
    }
  ],
  "outgoing": [
    {
      "name": "张伟",
      "phone": "13800001111",
      "address": "北京市朝阳区建国路88号",
      "products": [
        { "product_id": "p001", "product_name": "产品A", "quantity": 20 }
      ],
      "notes": ""
    }
  ]
}
```

关键字段：

- `id`：格式 `ORD_{timestamp}_{random4}`
- `created_by`：填表人称呼
- `paid_status`：运费是否已收，boolean（D1 里存 0/1）
- `picked_up`：货物是否已从快递处取回
- `shipped`：货物是否已寄出
- `source`：来源，`manual`（手动填单）或 `wechat`（微信客服）
- `incoming`：来件信息数组，一个大订单可包含多张来件单
- `outgoing`：收件人列表

### products 表

```sql
CREATE TABLE products (
  uid TEXT PRIMARY KEY,
  id TEXT UNIQUE,
  product_name TEXT
);
```

- `uid`：永久唯一标识符，创建后不变，用于追踪产品改名或改 id
- `id`：产品短码，显示在表格和 PDF 表头
- `product_name`：产品全称，显示在下拉选单和数量校验提示


## Cloudflare Worker API 端点

| 方法 | 路径 | 鉴权 | 功能 |
|---|---|---|---|
| POST | `/api/parse` | 无 | AI 解析订单文字，返回 JSON |
| GET | `/api/orders` | 无 | 读取所有订单 |
| POST | `/api/orders` | 无 | 新增订单 |
| PUT | `/api/orders/:id` | 无 | 修改订单 |
| DELETE | `/api/orders/:id` | 需要 | 删除订单 |
| GET | `/api/products` | 无 | 读取产品列表 |
| PUT | `/api/products` | 需要 | 保存产品列表（含订单同步） |

鉴权方式：请求 Header 带 `Authorization: Bearer {ADMIN_TOKEN}`。

index.html 的所有操作均为公开端点，不需要 token。需要 token 的只有删除订单和保存产品列表，仅 admin.html 使用。


## Cloudflare Worker 环境变量

| 变量名 | 说明 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key，模型：`gemini-3.1-flash-lite-preview` |
| `ADMIN_TOKEN` | 前端鉴权 token，当前值：`fj_2025_xK9mP3` |
| `WECHAT_TOKEN` | 企业微信验证 Token（待迁移到 Render 后可删） |
| `WECHAT_AES_KEY` | 企业微信 AES 密钥（待迁移到 Render 后可删） |
| `WECHAT_CORP_ID` | 企业微信企业ID：`ww38686c7fe12538c0` |
| `WECHAT_CORP_SECRET` | 自建应用 Secret |
| `WECHAT_KF_ID` | 微信客服账号 ID：`kfc29e3bd6ee29fe5b4` |

Bindings：
- `DB` → D1 数据库 `fengjiezhuanyun`
- `KV` → KV 命名空间（待迁移后可删）


## 微信接入（进行中）

### 现状

企业微信自建应用的 Webhook 配置在 `https://wx.marceliam.com/wx`，目前指向 Cloudflare Worker。

解密逻辑已调通，能正确解析 `kf_msg_or_event` 事件，但 `sync_msg` API 调用因 Cloudflare Workers 出口 IP 不固定，被企业微信 IP 白名单拦截（错误码 60020）。

计划迁移到 Render，固定出口 IP 解决此问题。

### 待完成步骤

1. 新建 GitHub repo `Marcel-Iam/fengjiezhuanyun-wx`，上传 `index.js` 和 `package.json`
2. 在 Render 部署 Web Service，连接该 repo
3. 拿到 Render 服务的固定出口 IP，加入企业微信自建应用的"企业可信IP"
4. 把 `wx.marceliam.com` 的 DNS 改成指向 Render（在 Render 添加 Custom Domain，在 Cloudflare DNS 里改 CNAME）
5. 企业微信自建应用接收消息配置重新点保存验证
6. 测试完整微信消息流程
7. 清理 Cloudflare Worker 里的微信相关代码和 KV 绑定

### Render 环境变量

| 变量名 | 值 |
|---|---|
| `WECHAT_TOKEN` | `D11Cqix3` |
| `WECHAT_AES_KEY` | `paOpwHEomR9pee1V5JQGOWEUCpgXUxcAQryg5XuFDpX` |
| `WECHAT_CORP_ID` | `ww38686c7fe12538c0` |
| `WECHAT_CORP_SECRET` | 自建应用 Secret |
| `WECHAT_KF_ID` | `kfc29e3bd6ee29fe5b4` |
| `GEMINI_API_KEY` | Gemini API key |
| `WORKER_URL` | `https://fengjiezhuanyun.yamhl12.workers.dev` |
| `ADMIN_TOKEN` | `fj_2025_xK9mP3` |

### 域名切换方法

1. 在 Render 服务设置里添加 Custom Domain：`wx.marceliam.com`
2. Render 会给出一个 CNAME 目标（格式类似 `xxx.onrender.com`）
3. 在 Cloudflare DNS 里删掉 Worker 的 Custom Domain 绑定，加一条 CNAME 记录指向 Render
4. 等 DNS 生效（通常几分钟）

### 微信消息流程（Render 版）

```
客户发微信消息
    ↓
企业微信 POST → wx.marceliam.com/wx（Render）
    ↓
Render 解密消息，识别 kf_msg_or_event 事件
    ↓
Render 调用 sync_msg API 拉取实际消息（固定IP，不受限）
    ↓
Gemini 解析，状态机多轮对话
    ↓
信息完整时 POST 到 Cloudflare Worker API 写入 D1
    ↓
Render 调用 send_msg 回复客户确认
```

### 多轮对话逻辑

状态存在 Render 服务的内存里（30分钟无消息自动清空）。

1. 客户发消息 → Gemini 提取已有信息，判断还缺什么 → 追问
2. 客户补充信息 → Gemini 合并，再次判断
3. 信息完整且产品数量匹配 → 显示确认预览
4. 客户回复"确认" → 写入数据库，回复成功
5. 客户回复"取消"/"重置" → 清空状态，重新开始


## AI 模型

使用 `gemini-3.1-flash-lite-preview`，通过 Google AI Studio 免费额度调用（RPD 500，RPM 20）。

每次调用前实时读取最新产品列表和已有订单号，不缓存。

### Parse 规则

1. 信息不完整（缺订单号、取货码、收件人、电话、地址）→ 说明缺了什么
2. 产品无法识别先模糊匹配，实在不确定才询问
3. 同一次输入内订单号或取货码重复 → 指出哪个重复
4. 订单号或取货码已存在数据库 → 说明已录入过
5. 来件产品总数和寄件产品总数不匹配 → 说明哪个产品数量对不上
6. 只能用产品列表里有的产品
7. 回复语气：口语中文，简洁


## index.html - 客户下单页面

**上方（可折叠）：查找 / 修改已提交订单**
- 输入任意一个来件单号搜寻整个大订单
- 载入后填入表单，底部切换为"发送修改"和"取消修改"

**下方（金色边框）：提交新订单**
- 填表人称呼
- 来件信息：每张来件单一张卡片（可增删）
- 收件人信息：每个收件人一张卡片（可增删）

**右下角浮动按钮：AI 智能填单**
- 聊天窗口，粘贴订单文字后 AI 自动解析
- 解析成功显示预览，点确认自动填入表单
- 解析失败显示错误原因，提示补充信息


## admin.html - 管理后台

密码：`456456`，四个分页：来件管理、寄件管理、历史档案、产品管理。

**来件管理**：未取货 / 已取货子视图，标签实时显示数量。表格有产品列（显示短码）、已付运费 checkbox（勾选取消都弹确认框）。工具栏支持生成取件单 PDF、批量标记已取货。

**寄件管理**：未寄出 / 已寄出子视图。订单号列显示所有来件单号，未取货时附红色标注。

**修改订单 Overlay**：来件和收件人卡片可增删，保存前做数量校验。不含 `paid_status` 字段，只能从表格 checkbox 修改。

**历史档案**：PDF 直接在浏览器生成并打开，不存档。

**产品管理**：每个产品有永久 `uid`，改名或改 id 时自动同步所有订单里的引用。保存前检查重复 id。


## 企业微信配置

- 企业ID：`ww38686c7fe12538c0`
- 自建应用 AgentId：`1000002`
- 微信客服账号：Marcel客服，open_kfid：`kfc29e3bd6ee29fe5b4`
- 自建应用接收消息 URL：`https://wx.marceliam.com/wx`
- Token：`D11Cqix3`
- EncodingAESKey：`paOpwHEomR9pee1V5JQGOWEUCpgXUxcAQryg5XuFDpX`
- 域名：`wx.marceliam.com`（marceliam.com 在 Cloudflare 注册）


## 注意事项

1. `ADMIN_TOKEN` 和 `GEMINI_API_KEY` 只存在环境变量里，不在前端代码中
2. `incoming` 是数组，不是对象，旧格式不兼容
3. D1 里 boolean 值存为 0/1，Worker 读取时自动转换为 true/false
4. `products` 表的 `uid` 字段是主键，`id` 字段有 UNIQUE 约束
5. `/api/parse` 每次调用都实时读取 D1，不缓存
6. PDF 生成是纯前端，不存档
7. admin.html 的 `CONFIG.adminToken` 是 `fj_2025_xK9mP3`
8. index.html 的 `CONFIG.adminToken` 保持空字符串
9. Render 服务的对话状态存在内存里，重启服务会清空所有进行中的对话状态
10. Cloudflare Worker 里目前保留了微信 Webhook 相关代码，迁移完成后可清理