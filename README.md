# 凤姐转运 - 订单管理系统

## 项目概述

| 组件 | 平台 | URL |
|---|---|---|
| 前端（index.html / admin.html） | GitHub Pages | `https://marcel-iam.github.io/fengjiezhuanyun/` |
| API + 数据库 | Cloudflare Worker + D1 | `https://fengjiezhuanyun.yamhl12.workers.dev` |
| 微信消息处理 | Render | `https://fengjiezhuanyun-render.onrender.com` |
| 自定义域名 | Cloudflare DNS → Render | `https://wx.marceliam.com` |

GitHub 仓库：
- 前端：`Marcel-Iam/fengjiezhuanyun`
- 微信服务：`Marcel-Iam/fengjiezhuanyun-render`


## 文件结构

```
GitHub repo (fengjiezhuanyun) — 前端：
├── index.html          客户下单页面（含 AI 聊天窗口）
└── admin.html          管理后台

GitHub repo (fengjiezhuanyun-render) — 微信服务：
├── index.js            Express 服务，处理微信 Webhook 和多轮对话
└── package.json

Cloudflare Worker:
└── worker.js           所有 API 逻辑

Cloudflare D1 (fengjiezhuanyun):
├── orders 表           订单数据
├── products 表         产品列表
└── customer_names 表   客户填表人名字记忆
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
- `paid_status`：运费是否已收（D1 里存 0/1）
- `picked_up`：货物是否已从快递处取回
- `shipped`：货物是否已寄出
- `source`：`manual`（手动填单）或 `wechat`（微信客服）
- `incoming`：来件信息数组，每张来件单有 `express_code`、`pickup_code`、`products`
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
- `product_name`：产品全称

### customer_names 表

```sql
CREATE TABLE customer_names (
  external_userid TEXT PRIMARY KEY,
  created_by TEXT,
  updated_at TEXT
);
```

存储微信客户的 `external_userid` 和上次使用的填表人称呼，下次聊天时自动填入。


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
| GET | `/api/cursor` | 无 | 读取 sync_msg cursor |
| POST | `/api/cursor` | 无 | 保存 sync_msg cursor |
| GET | `/api/customer_name` | 无 | 读取客户填表人名字 |
| POST | `/api/customer_name` | 无 | 保存客户填表人名字 |

鉴权方式：`Authorization: Bearer {ADMIN_TOKEN}`。


## Cloudflare Worker 环境变量

| 变量名 | 说明 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key |
| `ADMIN_TOKEN` | admin.html 鉴权 token，当前值：`fj_2025_xK9mP3` |

Bindings：
- `DB` → D1 数据库 `fengjiezhuanyun`
- `KV` → KV 命名空间（存 cursor）


## 微信客服接入

### 配置信息

- 企业ID：`ww38686c7fe12538c0`
- 自建应用 AgentId：`1000002`
- 微信客服账号：凤姐转运客服，open_kfid：`kfc29e3bd6ee29fe5b4`
- 自建应用接收消息 URL：`https://wx.marceliam.com/wx`
- Token：`D11Cqix3`
- EncodingAESKey：`paOpwHEomR9pee1V5JQGOWEUCpgXUxcAQryg5XuFDpX`
- 域名：`wx.marceliam.com`（marceliam.com 在 Cloudflare 注册）
- 企业可信IP：`74.220.50.240`（Render 出口 IP，如有变化需更新）

### 消息流程

```
客户发微信消息
    ↓
企业微信 POST → wx.marceliam.com/wx（Render）
    ↓
Render 解密 kf_msg_or_event 事件
    ↓
调用 sync_msg API 拉取实际消息
    ↓
检查重复订单号（代码层面，不依赖 AI）
    ↓
Gemini 解析，多轮对话状态机
    ↓
信息完整时发送确认预览
    ↓
客户回复"确认" → POST 到 Cloudflare Worker API 写入 D1
    ↓
回复客户提交成功
```

### 多轮对话逻辑

状态存在 Render 服务内存，5分钟无消息自动清空。

1. 客户发消息 → Gemini 提取信息，判断还缺什么 → 追问
2. 客户补充 → Gemini 合并，再次判断
3. 信息完整 → 发送确认预览（两条消息：预览 + 提示）
4. 客户回复"确认" → 写入数据库，回复成功
5. 客户回复"取消" → 清空状态，重新开始
6. 客户复制预览修改后重发 → 识别为新订单信息，替换旧状态

### Gemini Prompt 规则

1. 把客户新消息的信息合并进已有信息，一条消息包含所有必要信息时直接判断完整
2. `partial_data` 始终填入已收集到的所有内容
3. 信息完整条件：有订单号、取货码、至少一个收件人（含姓名/电话/地址）、来件和寄件产品总数匹配
4. 信息完整时：`valid=true`，`ready_to_submit=true`，`data` 填完整数据
5. 信息不完整时：`valid=false`，`error_reply` 说清楚还缺什么
6. 产品先模糊匹配，实在无法确认才询问
7. 只对照"数据库中已有的订单号"列表检查重复，列表里没有就不算重复
8. 来件和寄件产品总数不匹配时说明哪个产品数量对不上
9. 只能使用产品列表里有的产品ID
10. 只返回 JSON，不要 markdown 代码块
11. 只有一个来件单且只有一个收件人时，自动把来件产品全部分配给该收件人
12. 客户说要修改已有订单时，回复引导去网页操作
13. 客户发来新订单号与已有 `partial_data` 里的订单号不同时，用新信息替换旧信息
14. 信息格式：客户可能用①②分段，严格按编号分组提取，不跨组混合


## Render 环境变量

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


## AI 模型

使用 `gemini-3.1-flash-lite-preview`，Google AI Studio 免费额度（RPD 500，RPM 20）。

网页端（`/api/parse`）和微信端（Render）分别调用，每次实时读取最新产品列表和已有订单号。


## index.html - 客户下单页面

**上方（可折叠）：查找 / 修改已提交订单**，输入任意来件单号搜寻。

**下方（金色边框）：提交新订单**，填表人、来件信息（可增删）、收件人（可增删）。

**右下角浮动按钮：AI 智能填单**，粘贴文字后 AI 解析，确认后填入表单。

来件和寄件产品数量校验（不匹配时弹确认框）。修改订单不改动 `paid_status`。


## admin.html - 管理后台

密码：`456456`，四个分页：来件管理、寄件管理、历史档案、产品管理。

**来件管理**：未取货 / 已取货子视图，标签实时显示数量。产品列显示短码，已付运费 checkbox 勾选/取消都弹确认框。支持生成取件单 PDF、批量标记已取货。

**寄件管理**：未寄出 / 已寄出子视图。订单号列显示所有来件单号，未取货时附红色标注。

**修改订单 Overlay**：来件和收件人卡片可增删，保存前做数量校验。`paid_status` 只能从表格 checkbox 修改。

**历史档案**：PDF 直接在浏览器生成并打开，不存档。

**产品管理**：每个产品有永久 `uid`，改名或改 id 时自动同步所有订单里的引用。保存前检查重复 id。


## 注意事项

1. `ADMIN_TOKEN` 和 `GEMINI_API_KEY` 只存在环境变量里，不在前端代码中
2. `incoming` 是数组，不是对象
3. D1 里 boolean 值存为 0/1，Worker 读取时自动转换
4. `/api/parse` 每次调用都实时读取 D1，不缓存
5. PDF 生成是纯前端，不存档
6. admin.html 的 `CONFIG.adminToken` 是 `fj_2025_xK9mP3`
7. index.html 的 `CONFIG.adminToken` 保持空字符串
8. Render 免费版会休眠，第一次请求可能慢 30-60 秒
9. Render 重启后内存里的对话状态会清空（5分钟超时也会清空）
10. Render 出口 IP 如果变化，需要更新企业微信自建应用的"企业可信IP"
11. Cloudflare Worker 里保留了微信 Webhook 相关代码，实际处理在 Render，两套代码暂时共存