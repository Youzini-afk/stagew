# Stagewise 2api

> Stagewise API 逆向代理 — 将 [Stagewise](https://stagewise.io) 接口转换为 OpenAI 兼容格式，支持多账号池管理、自动注册、额度监控。

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

## ✨ 功能特性

- 🔄 **OpenAI 兼容 API** — 直接对接 ChatGPT-Next-Web、LobeChat、OpenCat 等客户端
- 👥 **多账号池** — SQLite 存储，轮询调度，自动故障切换（连续错误 3 次自动跳过，5 分钟冷却）
- 🤖 **自动注册** — 接入 GPTMail 临时邮箱，一键批量注册 Stagewise 账号（支持 100~10000 个）
- 💰 **额度监控** — 实时查看日/周/月配额使用情况，5 分钟 SQLite 缓存，减少 API 调用
- 📊 **Material Design 3 前端** — Google 风格管理面板，进度条可视化配额
- 🧪 **API 测试** — 内置 44 个模型测试，按厂商分组
- 🔐 **System Prompt 自动注入** — 注入 5515 字符验证 prompt，绕过 Stagewise 401 限制
- ⚙️ **在线配置** — 邮箱 API 地址和 Key 可在前端"设置"页面修改，保存到数据库，无需重启

## 📦 支持模型（44 个）

| 厂商 | 数量 | 模型列表 |
|------|------|----------|
| 🟣 Anthropic | 10 | Claude Fable 5, Mythos 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5 |
| 🟢 OpenAI | 11 | GPT-5.5/5.4/5.4-mini/5.4-nano/5.3-codex/5.3-chat/5.2/5.1/5/5-chat/5-nano |
| 🔵 Google | 6 | Gemini 3.1-pro-preview/3.5-flash/3-pro/3-flash-preview/3.1-flash-lite/2.5 |
| 🟠 DeepSeek | 2 | V4-pro, V4-flash |
| 🌙 Kimi | 4 | K2.7-code, K2.6, K2.5, Plan |
| 🔶 Qwen | 3 | Qwen3-coder-30b, Plan, Turbo |
| ⚡ GLM | 5 | GLM-5.2/5.1/5v-turbo/4.5-flash, Coding-plan |
| 🔷 MiniMax | 3 | M3, M2.7, Plan |

## 🚀 快速开始

### 环境要求

- Node.js >= 20
- npm

### 安装

```bash
# 解压
tar xzf stagewise-2api.tar.gz
cd stagewise-2api

# 安装依赖
npm install

# 复制并编辑配置（可选，也可在前端"设置"页面配置）
cp .env.example .env
# vim .env

# 启动
npm start        # 生产模式
# 或
npm run dev      # 开发模式（热重载）
```

### 访问

- **管理面板**: http://localhost:3000/dashboard
- **API 端点**: http://localhost:3000/v1

## 📖 使用方式

### 作为 OpenAI API 代理

在任意支持 OpenAI API 的客户端中，将 Base URL 改为：

```
http://localhost:3000/v1
```

**curl 示例：**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**Python OpenAI SDK：**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="not-needed"  # 使用账号池或 .env 中的 token
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}]
)
print(response.choices[0].message.content)
```

**ChatGPT-Next-Web / LobeChat：**

在设置中填写：
- API 地址：`http://localhost:3000/v1`
- API Key：任意（或填 `not-needed`）

### Token 来源优先级

1. **请求头** `Authorization: Bearer <token>` — 最高优先
2. **账号池轮询** — 自动选取可用账号（推荐，无需手动管理 token）
3. **.env 默认 Token** — 回退方案

## 📡 API 端点

### OpenAI 兼容

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | 聊天补全 |
| GET | `/v1/models` | 模型列表（44 个） |

### 账号池管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/pool` | 列出所有账号 |
| POST | `/v1/pool` | 添加账号（body: `{email, token, name?}`） |
| GET | `/v1/pool/stats` | 账号池统计 |
| PATCH | `/v1/pool/:email` | 启用/禁用账号（body: `{isActive}`） |
| DELETE | `/v1/pool/:email` | 删除账号 |

### 添加账号（引导式）

前端"账号池"页面提供 3 步引导流程：

1. 输入邮箱 → 点"发送验证码"
2. 输入邮箱收到的 6 位码 → 点"验证并添加"（自动获取 token 入库）
3. 成功提示，可继续添加

对应 API：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/auth/login` | 发送邮箱验证码（body: `{email}`） |
| POST | `/v1/auth/verify` | 验证并获取 Token（body: `{email, code}`） |

### 自动注册

通过 GPTMail 临时邮箱自动注册 Stagewise 账号，注册成功后自动加入账号池。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/register/auto` | 注册单个账号（body: `{prefix?, maxWait?}`） |
| POST | `/v1/register/batch` | 批量注册（body: `{count: 100}`，count 上限 10000） |
| GET | `/v1/register/domains` | 获取可用邮箱域名 |

**流程：** 创建临时邮箱 → 发送 Stagewise OTP → 轮询收件箱 → 获取验证码 → 完成验证 → 自动加入账号池

### 额度查询

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/usage` | 单账号用量（使用当前 token） |
| GET | `/v1/usage/pool` | 账号池额度汇总（5 分钟缓存） |
| GET | `/v1/usage/pool?refresh=true` | 强制刷新（绕过缓存） |

### 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/settings/mail` | 获取邮箱 API 配置（token 脱敏） |
| POST | `/v1/settings/mail` | 保存邮箱 API 配置（body: `{url, token}`） |

## 🏗️ 项目结构

```
stagewise-2api/
├── config.js                        # 全局配置
├── src/
│   └── index.js                     # 入口 & 路由注册
├── middleware/
│   └── auth.js                      # Token 提取中间件（请求头 → 账号池 → .env）
├── routes/
│   ├── health.js                    # 健康检查
│   ├── auth.js                      # 认证端点
│   ├── pool.js                      # 账号池管理
│   ├── usage.js                     # 额度查询
│   ├── register.js                  # 自动注册
│   └── settings.js                  # 设置管理
├── services/
│   ├── account-pool.js              # 账号池逻辑（SQLite）
│   ├── auth.js                      # Stagewise Auth 封装
│   ├── auto-register.js             # 自动注册流程
│   ├── gptmail.js                   # GPTMail 临时邮箱 API
│   ├── models.js                    # 模型列表（44 个）
│   ├── proxy.js                     # 请求转发核心（含 system prompt 注入）
│   ├── settings.js                  # 设置持久化（SQLite）
│   ├── stagewise-system-prompt.js   # 验证 prompt（5515 字符）
│   └── usage.js                     # 用量查询 + 5 分钟缓存
├── db/
│   └── database.js                  # SQLite 初始化（accounts, usage_history, settings）
├── public/
│   └── index.html                   # Material Design 3 管理面板
├── data/                            # SQLite 数据（git-ignored）
├── .env                             # 环境变量（git-ignored）
├── .env.example                     # 配置模板
└── package.json
```

## ⚙️ 配置说明

### .env 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3000` |
| `STAGEWISE_LLM_URL` | Stagewise LLM 网关 | `https://api.stagewise.io/v1/ai` |
| `STAGEWISE_API_URL` | Stagewise API 地址 | `https://api.stagewise.io` |
| `STAGEWISE_TOKEN` | 默认 Bearer Token | 空 |
| `MAIL_URL` | 临时邮箱 API 地址 | `https://mail.chatgpt.org.uk` |
| `MAIL_TOKEN` | 临时邮箱 API Key | 空 |

### 前端在线配置

访问 http://localhost:3000/dashboard → "设置" 标签页，可在线配置邮箱 API 地址和 Key，保存到 SQLite 数据库，无需重启服务。

## ⚠️ 注意事项

- **System Prompt 注入**：Stagewise 后端会验证 system prompt 内容，本代理会自动注入 5515 字符的验证 prompt，无需客户端额外处理
- **账号池调度**：采用轮询 + 故障自动跳过机制，连续错误 > 3 次的账号会被跳过 5 分钟
- **额度缓存**：5 分钟 SQLite 缓存，避免频繁调用 Stagewise 用量 API
- **自动注册**：依赖外部临时邮箱服务（GPTMail），请确保 API Key 有效且有足够配额
- **Token 安全**：前端显示 token 时会自动脱敏，只显示前 4 位和后 4 位

## 🛠️ 常见问题

**Q: 调用返回 401？**
A: 检查账号池是否有有效 token，或 .env 中的 STAGEWISE_TOKEN 是否有效。

**Q: 自动注册失败？**
A: 检查前端"设置"页面中的 GPTMail API Key 是否有效且有配额。

**Q: 额度显示不准确？**
A: 点击"强制刷新"按钮绕过 5 分钟缓存，从 Stagewise API 实时获取。

**Q: 如何获取 Stagewise Token？**
A: 在前端"账号池"页面，输入 Stagewise 注册邮箱，按引导流程发送验证码并验证即可。

## 📄 License

MIT
