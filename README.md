# dark-proxy-vps

本项目提供一个针对 Google Gemini/OpenAI 兼容接口的反向代理，并支持为每个账号自动分发调用密钥，便于多人共用同一套部署。

## 部署与运行
1. **安装依赖**：
   ```bash
   npm install
   ```
2. **启动服务**：
   ```bash
   npm start
   ```
   服务器默认监听 `0.0.0.0:7860`，通过环境变量 `PORT` 可修改端口。
3. **反代客户端**：
   将 `dark-browser-vps.js` 的内容粘贴到 Zeabur（或其它前端托管）生成的页面 Build 脚本中，即可建立浏览器到后端的 WebSocket 连接。

## 账号密钥机制
- 后端会在首次收到形如 `/<account-email>`（例如 `/xxxxx@gmail.com`）的请求时，为该邮箱生成一个 24 位调用密钥。
- 密钥字符从 `A-Z`、`a-z`、`0-9`、`-` 这 53 个字符随机选择，可重复。
- 访问 `https://<你的公网域名>/<account-email>` 即可获取密钥，返回示例：
  ```json
  { "account": "demo@gmail.com", "key": "Abc...xyz" }
  ```
- 每个账号只有一个密钥；重复访问会返回同一密钥，便于用户自行保存。

## 使用密钥调用代理
- **查询参数**：在请求中追加 `?key=<你的密钥>`。
- **Authorization 头**：也可使用 `Authorization: Bearer <你的密钥>`。
- 旧版单一密钥仍可通过环境变量 `MY_SECRET_KEY` 配置，默认值为 `123456`；任一有效账号密钥或 `MY_SECRET_KEY` 都能通过鉴权。
- 支持 OpenAI 兼容接口：
  - 列表模型：`GET /v1/models`。
  - Chat Completions：`POST /v1/chat/completions`（支持 `stream`）。
- 其它路径会直接透传给后端，`key` 仅用于鉴权，不会转发。

## 常见问题
- **连接状态检查**：访问根路径 `/`，若显示 `✅ 代理就绪` 表示已有浏览器客户端连接。
- **切换模式**：
  - `GET /admin/set-mode?mode=fake|real` 用于切换伪造/真实流模式。
  - `GET /admin/get-mode` 查看当前模式。

## 额度与账号隔离说明
- 账号邮箱和密钥 **只用于网关鉴权**，后端仍通过浏览器中的单一登录态访问 Gemini/OpenAI 兼容接口。
- 因此，当 A、B 两个邮箱都获取到密钥时：
  - 他们可以用各自密钥独立鉴权，但请求最终都会占用当前浏览器登录账号的额度；
  - 如果浏览器端登录的是账号 B，那么即便 A 使用自己的密钥发请求，也会消耗账号 B 的额度。
- 如需彻底隔离额度，请为每个账号单独部署一套前端（浏览器登录对应账号）与后端，或扩展代码在前端维护多浏览器会话并根据请求绑定到对应会话。

如需自定义，请参考 `dark-server-vps.js` 与 `dark-browser-vps.js` 的实现。
