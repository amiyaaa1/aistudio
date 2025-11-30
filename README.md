# 多账号代理使用说明

本项目由两个部分组成：
- **dark-server-vps.js**：在服务器（如 Zeabur）上运行的代理后端，负责转发请求、生成并校验密钥、为每个账号维持独立的浏览器会话。
- **dark-browser-vps.js**：在浏览器控制台中运行的前端脚本，用于建立到代理后端的 WebSocket 连接并转发真实的 Gemini API 调用。

## 后端部署与启动
1. 准备 Node.js 环境（建议 Node 18+）。
2. 安装依赖：
   ```bash
   npm install
   ```
3. 启动后端（默认监听 `7860` 端口，可通过 `PORT` 环境变量修改）：
   ```bash
   npm start
   ```
4. 运行后可通过根路径确认状态：
   - `GET /`：显示当前是否有浏览器连接（例如 `✅ 代理就绪 (user@gmail.com)` 或 `❌ 无连接`）。

### 运行模式（可选）
- `GET /admin/get-mode`：查看当前模式（`real` 或 `fake`）。
- `GET /admin/set-mode?mode=real|fake`：切换模式。`real` 为真实流式转发；`fake` 会在后端聚合后再推送，便于调试。

## 浏览器端脚本使用
1. 在浏览器中登录目标账号（确保已登录对应的 Gmail）。
2. 打开开发者工具控制台（通常为 `F12` 或 `Ctrl+Shift+I`）。
3. 将 `dark-browser-vps.js` 文件内容完整复制并粘贴到控制台执行。
4. 脚本会自动尝试从浏览器的登录态检测当前账号邮箱；若检测失败会弹框要求手动输入邮箱。
5. 连接成功后，终端会显示 `✅ 连接成功`，后端会为该邮箱生成唯一密钥并绑定会话。

> 提示：多个账号可以在不同的浏览器窗口/配置文件中同时执行该脚本，每个窗口对应一个独立的浏览器会话。

## 反代密钥获取与使用
- **自动生成**：每个已连接的邮箱都会自动生成一个 24 位密钥，字符集为 `A-Z`、`a-z`、`0-9`、`-`。
- **获取方式**：在 Zeabur 公网链接后追加 `/<账号邮箱>` 即可获取对应密钥，例如：
  ```
  https://your-zeabur-domain.com/user@gmail.com
  ```
  若账号未连接会返回 404。
- **调用时携带密钥**：
  - OpenAI 兼容接口：
    - `POST /v1/chat/completions`，在 `Authorization: Bearer <密钥>` 或查询参数 `?key=<密钥>` 中传入密钥。
    - `GET /v1/models` 获取模型列表，同样需要携带密钥。
  - 原生 Gemini 路径：任意其他路径同样接受 `?key=<密钥>` 或 `Authorization: Bearer <密钥>`。

后端会根据密钥定位到对应的浏览器会话并转发请求：
- 若账号 A 的额度用尽，即便继续使用 A 的密钥发起请求，也只会返回错误，不会占用其他账号额度。
- 不同账号的 WebSocket 会话、请求队列和心跳独立维护，互不影响。

## 典型调用示例（OpenAI 兼容）
```bash
curl -X POST \
  https://your-zeabur-domain.com/v1/chat/completions?key=<你的密钥> \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-pro",
    "messages": [
      {"role": "user", "content": "你好"}
    ],
    "stream": true
  }'
```
- 返回流式数据时会自动转换为 OpenAI SSE 格式，结束时追加 `data: [DONE]`。

## 常见问题
- **提示 Unauthorized**：确认请求中携带的密钥正确且对应账号浏览器端仍在线。
- **提示 503 账号未连接**：确保浏览器端脚本正在运行且网络可达后端。
- **多账号隔离**：每个账号的密钥唯一且仅在对应浏览器会话存活时有效，重新连接会复用同一密钥；如需强制刷新可重启浏览器端脚本。

## 文件清单
- `dark-server-vps.js`：后端服务及路由、密钥生成与会话管理。
- `dark-browser-vps.js`：浏览器控制台脚本，连接 WebSocket 并代理真实请求。
- `.gitignore`：忽略 `node_modules/`。
