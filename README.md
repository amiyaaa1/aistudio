# 多账号反代服务使用说明

本项目提供可同时服务多个 Google 账号的反向代理。每个账号都有独立的浏览器会话与调用密钥，保证额度隔离，避免互相影响。

## 部署与准备
1. 在 Zeabur 创建服务，代码使用本仓库内容。
2. Zeabur 构建时，将 `dark-browser-vps.js` 的全部内容粘贴到前端运行环境（例如 Build & Deploy 的静态页面或用户脚本）。**无需修改后端文件。**
3. 为每个账号分别打开一个浏览器页面，并在页面中登录对应的 Google 账号，保持浏览器多登录态。
4. 将浏览器脚本中的 `WS_ENDPOINT` 设置为 `wss://<你的公网域名>/<账号邮箱>`，例如：`wss://example.zeabur.app/yourname@gmail.com`。每个账号使用自己的邮箱路径建立 WebSocket 连接。
   - 如果无法在路径里直接写邮箱，也可以改为 `wss://<你的公网域名>?account=<账号邮箱>` 或 `?email=<账号邮箱>`。
   - 以上方式都会在服务端正确识别账号并建立独立连接。

## 获取专属密钥
- 在 Zeabur 公网地址后追加 `/<账号邮箱>` 访问即可自动生成/获取该账号的调用密钥，例如：

  ```bash
  curl https://example.zeabur.app/yourname@gmail.com
  ```

- 返回示例：

  ```json
  {"account":"yourname@gmail.com","proxy_key":"A1b2C3...","connected":true}
  ```

密钥规则：从 `A-Z`、`a-z`、`0-9`、`-` 这 53 个字符中随机生成 24 位，可重复字符。

## 发送请求（OpenAI 兼容）
1. 在请求中携带密钥：
   - Query 参数：`?key=<proxy_key>`
   - 或 HTTP Header：`Authorization: Bearer <proxy_key>`
2. 使用 OpenAI 兼容接口：
   - `POST /v1/chat/completions`
   - `GET /v1/models`
3. 示例：

   ```bash
   curl -X POST \
     -H "Authorization: Bearer <proxy_key>" \
     -H "Content-Type: application/json" \
     -d '{"model":"gemini-pro","messages":[{"role":"user","content":"hello"}]}' \
     https://example.zeabur.app/v1/chat/completions
   ```

请求会根据密钥匹配到对应的账号会话，确保每个用户只能使用自己的额度。若某账号额度耗尽，继续使用该账号密钥只会返回错误，不会影响其他账号。

## 运行模式
- 默认实时流式模式（`real`）。
- 可通过 `GET /admin/set-mode?mode=fake|real` 切换。
- `GET /admin/get-mode` 查看当前模式。

## 健康检查
- `GET /` 返回当前已连接的账号列表。

## 注意事项
- 路径中的账号邮箱必须为 Gmail 格式（`xxxxx@gmail.com`）。
- 同一账号重复连接会自动替换旧连接，密钥保持不变。
- 请妥善保存密钥，不要泄露给他人。
