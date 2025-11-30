# AI Studio Proxy 前端构建说明

## 快速开始
1. 安装依赖：项目已包含所需依赖（Express、WS）。
2. 启动服务：
   ```bash
   node dark-server-vps.js
   ```
3. 打开控制面板：管理员访问 `http://<host>:<port>/build?admin_key=<管理员密钥>`（或 `/build/index.html`），每次打开都会生成一个全新的调用密钥并展示在页面上。

> 默认端口为 `7860`，可通过 `PORT` 环境变量修改。管理员密钥通过环境变量 `ADMIN_KEY`（或兼容的 `MY_SECRET_KEY`）配置，未设置时默认为 `123456`，仅管理员知晓即可。

## 密钥分发与校验
- **调用密钥格式**：从 `A-Z`、`a-z`、`0-9`、`-` 共 53 个字符中随机生成 32 位字符串（字符可重复）。
- **去重逻辑**：服务端使用内存集合去重；若新密钥与历史密钥冲突，会重新生成直到唯一为止。
- **使用方式**：
  - 只需将页面展示的调用密钥写入请求头 `X-Client-Key: <调用密钥>`。
  - 缺失或无效的调用密钥会被拒绝。

### 示例（OpenAI 兼容接口）
```bash
curl -X POST "http://localhost:7860/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "X-Client-Key: YOUR_CLIENT_KEY" \
  -d '{"model":"gemini-pro","messages":[{"role":"user","content":"Hello"}]}'
```

## 工作原理简述
- `/build` 控制面板需要管理员密钥才能访问，进入后会生成并展示唯一的调用密钥。
- 所有需要代理的 API（例如 `/v1/chat/completions`、`/v1/models`）在进入核心处理前会验证：
  1. `X-Client-Key` 是否存在且属于已分发集合。
- 校验通过的请求才会被继续转发到后端或上游模型。

## 注意事项
- 调用密钥仅存储于内存，服务重启后会重新生成；请在需要时重新打开 `/build` 获取新密钥。
- 为确保个人凭证隔离，请勿共享页面展示的调用密钥或后端访问密钥。
- 如需调整密钥长度或字符集，可在 `dark-server-vps.js` 中修改 `CLIENT_KEY_CHARS` 或生成逻辑。
