const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");

const SECRET_KEY = process.env.MY_SECRET_KEY || "123456";
const DEFAULT_STREAMING_MODE = "real";
const normalizeAccount = (account) => (account || "").trim().toLowerCase();

const log = (level, msg) => console[level](`[${level.toUpperCase()}] ${new Date().toISOString()} - ${msg}`);
const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

class KeyManager {
  #charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-";
  #accountToKey = new Map();
  #keyToAccount = new Map();

  getOrCreate(account) {
    account = normalizeAccount(account);
    if (!account) throw new Error("账号无效");
    if (!this.#accountToKey.has(account)) {
      const key = this.#generateKey();
      this.#accountToKey.set(account, key);
      this.#keyToAccount.set(key, account);
      log("info", `为账号 ${account} 生成新密钥`);
    }
    return this.#accountToKey.get(account);
  }

  validate(key) {
    return this.#keyToAccount.has(key) || key === SECRET_KEY;
  }

  getAccountByKey(key) {
    return this.#keyToAccount.get(key) || null;
  }

  #generateKey() {
    const bytes = crypto.randomBytes(24);
    let key = "";
    for (let i = 0; i < 24; i++) key += this.#charSet[bytes[i] % this.#charSet.length];
    return key;
  }
}

class Queue {
  #msgs = [];
  #waiters = [];
  #closed = false;
  push(msg) {
    if (this.#closed) return;
    this.#waiters.length ? this.#waiters.shift().resolve(msg) : this.#msgs.push(msg);
  }
  async pop() {
    if (this.#closed) throw new Error("Queue closed");
    if (this.#msgs.length) return this.#msgs.shift();
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
  close() {
    this.#closed = true;
    this.#waiters.forEach((w) => w.reject(new Error("Queue closed")));
    this.#waiters = [];
  }
}

class Connections {
  #conns = new Map(); // account -> { ws, queues, heartbeat }

  add(ws, info) {
    const account = normalizeAccount(info.account) || "default";
    const existing = this.#conns.get(account);
    if (existing) {
      log("warn", `账号 ${account} 已有连接，关闭旧连接并替换。`);
      existing.ws.close(1000, "Replaced by new connection");
      this.#teardown(account, existing);
    }

    const entry = { ws, queues: new Map(), heartbeat: null };
    this.#conns.set(account, entry);

    ws.isAlive = true;
    log("info", `客户端连接: ${info.address} (账号: ${account})`);
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (data) => this.#onMessage(account, data.toString()));
    ws.on("close", () => this.#onClose(account, ws));
    ws.on("error", (err) => log("error", `WS错误 (${account}): ${err.message}`));
    this.#startHeartbeat(account);
  }

  #startHeartbeat(account) {
    const entry = this.#conns.get(account);
    if (!entry) return;
    log("info", `心跳启动 (${account})`);
    entry.heartbeat = setInterval(() => {
      if (!entry.ws) return;
      if (!entry.ws.isAlive) return entry.ws.terminate();
      entry.ws.isAlive = false;
      entry.ws.ping();
    }, 30000);
  }

  #onClose(account, ws) {
    const entry = this.#conns.get(account);
    if (!entry || entry.ws !== ws) return;
    log("info", `客户端断开 (${account})`);
    this.#teardown(account, entry);
    this.#conns.delete(account);
  }

  #teardown(account, entry) {
    entry.queues.forEach((q) => q.close());
    entry.queues.clear();
    clearInterval(entry.heartbeat);
    entry.heartbeat = null;
    log("info", `心跳停止 (${account})`);
  }

  #onMessage(account, data) {
    try {
      const msg = JSON.parse(data);
      const queue = this.#conns.get(account)?.queues.get(msg.request_id);
      if (!queue) return;
      if (msg.event_type === "stream_close") queue.push({ type: "STREAM_END" });
      else if (["response_headers", "chunk", "error"].includes(msg.event_type)) queue.push(msg);
    } catch (err) {
      log("error", `解析消息失败 (${account}): ${err.message}`);
    }
  }

  hasConn = (account) => !!this.getConn(account);
  hasAnyConn = () => Array.from(this.#conns.values()).some((entry) => entry.ws?.isAlive);

  getConn(account) {
    const entry = this.#conns.get(account);
    if (entry?.ws?.isAlive) return entry.ws;
    if (entry) this.#teardown(account, entry);
    this.#conns.delete(account);
    return null;
  }

  firstAccount() {
    for (const [account, entry] of this.#conns.entries()) {
      if (entry.ws?.isAlive) return account;
    }
    return null;
  }

  createQueue = (id, account) => {
    const entry = this.#conns.get(account);
    if (!entry) throw new Error(`账号 ${account} 未连接`);
    return entry.queues.set(id, new Queue()).get(id);
  };

  removeQueue = (id, account) => {
    const entry = this.#conns.get(account);
    const queue = entry?.queues.get(id);
    if (queue) queue.close();
    return entry?.queues.delete(id);
  };

  forward = (account, proxyReq) => this.getConn(account)?.send(JSON.stringify(proxyReq));
}

class FormatConverter {
  toOpenAIModels(geminiData) {
    return {
      object: "list",
      data: (geminiData.models || []).map(model => ({
        id: model.name.replace("models/", ""),
        object: "model",
        created: Math.floor(new Date(model.updateTime || Date.now()).getTime() / 1000),
        owned_by: "google",
      })),
    };
  }

  fromOpenAIRequest(req, id, streamingMode) {
    const { body: openaiBody } = req;
    const geminiBody = this.#convertOpenAIToGemini(openaiBody);
    return {
      path: this.#convertOpenAIPath(openaiBody),
      method: "POST",
      headers: req.headers,
      query_params: this.#convertOpenAIQuery(req),
      body: JSON.stringify(geminiBody),
      request_id: id,
      streaming_mode: streamingMode,
      is_openai: true,
    };
  }

  toOpenAIResponse(geminiData, isStream) {
    const { text, finishReason } = this.#parseGeminiCandidate(geminiData);
    const finish = finishReason === "STOP" ? "stop" : null;
    if (isStream) {
      const chunk = {
        id: `chatcmpl-${genId()}`, object: "chat.completion.chunk", created: Date.now() / 1000 | 0, model: "gpt-4",
        choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finish }],
      };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    return JSON.stringify({
      id: `chatcmpl-${genId()}`, object: "chat.completion", created: Date.now() / 1000 | 0, model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish || "length" }],
    });
  }

  toOpenAISSE(sseData) {
    return sseData.split("\n")
      .filter(line => line.startsWith("data: "))
      .map(line => this.toOpenAIResponse(line.slice(6), true))
      .join("");
  }
  
  #convertOpenAIPath = (body) => `/v1beta/models/${body?.model || "gemini-pro"}:${body?.stream ? "streamGenerateContent" : "generateContent"}`;
  
  #convertOpenAIQuery = (req) => {
    const query = { ...req.query };
    delete query.key;
    if (req.body?.stream) query.alt = "sse";
    return query;
  };

  #convertOpenAIToGemini(body) {
    const geminiBody = { contents: [] };
    const systemParts = [];
    (body.messages || []).forEach(msg => {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : (msg.content.find(c => c.type === "text")?.text || "");
        systemParts.push({ text });
      } else {
        const parts = [];
        if (typeof msg.content === "string") parts.push({ text: msg.content });
        else if (Array.isArray(msg.content)) {
          msg.content.forEach(item => {
            if (item.type === "text") parts.push({ text: item.text });
            else if (item.type === "image_url" && item.image_url.url.startsWith("data:")) {
              const match = item.image_url.url.match(/^data:image\/(\w+);base64,(.+)$/);
              if (match) parts.push({ inlineData: { mimeType: `image/${match[1]}`, data: match[2] } });
            }
          });
        }
        if (parts.length > 0) geminiBody.contents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
      }
    });
    if (systemParts.length > 0) geminiBody.systemInstruction = { parts: systemParts };
    const genConfig = {};
    if (body.temperature !== undefined) genConfig.temperature = body.temperature;
    if (body.max_tokens !== undefined) genConfig.maxOutputTokens = body.max_tokens;
    if (body.top_p !== undefined) genConfig.topP = body.top_p;
    if (body.top_k !== undefined) genConfig.topK = body.top_k;
    if (body.stop) genConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.thinking_budget > 0) genConfig.thinkingConfig = { thoughtGenerationTokenBudget: Math.floor(body.thinking_budget) };
    if (Object.keys(genConfig).length > 0) geminiBody.generationConfig = genConfig;
    return geminiBody;
  }
  
  #parseGeminiCandidate(geminiData) {
    try {
      const gemini = typeof geminiData === "string" ? JSON.parse(geminiData) : geminiData;
      const candidate = gemini.candidates?.[0];
      if (!candidate) return { text: "", finishReason: null };
      const text = candidate.content?.parts?.map(p => p.text || "").join("") || "";
      return { text, finishReason: candidate.finishReason };
    } catch {
      return { text: "", finishReason: null };
    }
  }
}

class Handler {
  #server;
  #conns;
  #keyManager;
  #converter = new FormatConverter();

  constructor(server, conns, keyManager) {
    this.#server = server;
    this.#conns = conns;
    this.#keyManager = keyManager;
  }

  async handle(req, res, isOpenAI = false) {
    if (!this.#auth(req, res) || !this.#checkConn(req, res, isOpenAI)) return;
    const id = genId();
    const queue = this.#conns.createQueue(id, req.account);
    try {
      const proxyReq = isOpenAI
        ? this.#converter.fromOpenAIRequest(req, id, this.#server.mode)
        : this.#buildNativeReq(req, id);
      await this.#dispatch(req, res, proxyReq, queue, isOpenAI);
    } catch (err) {
      this.#error(err, res, isOpenAI);
    } finally {
      this.#conns.removeQueue(id, req.account);
    }
  }

  async handleModels(req, res) {
    log("info", "模型列表请求");
    if (!this.#auth(req, res) || !this.#checkConn(req, res, true)) return;
    const id = genId();
    const queue = this.#conns.createQueue(id, req.account);
    try {
      this.#conns.forward(req.account, { path: "/v1beta/models", method: "GET", request_id: id });
      const header = await queue.pop();
      if (header.event_type === "error") return this.#send(res, header.status, header.message, true);
      const data = await queue.pop();
      await queue.pop();
      if (data.data) res.json(this.#converter.toOpenAIModels(JSON.parse(data.data)));
      else this.#send(res, 500, "无法获取模型列表", true);
    } catch (err) {
      this.#error(err, res, true);
    } finally {
      this.#conns.removeQueue(id, req.account);
    }
  }

  #auth = (req, res) => {
    // 允许预检请求通过认证，或检查 key
    if (req.method === 'OPTIONS') return true;
    const key = this.#extractKey(req);
    if (this.#keyManager.validate(key)) {
      req.account = this.#keyManager.getAccountByKey(key);
      return true;
    }
    this.#send(res, 401, "Unauthorized", true);
    return false;
  }

  #checkConn = (req, res, isOpenAI) => {
    const targetAccount = req.account || this.#conns.firstAccount();
    if (!targetAccount) {
      this.#send(res, 503, "无可用连接", isOpenAI);
      return false;
    }
    if (!this.#conns.hasConn(targetAccount)) {
      this.#send(res, 503, `账号 ${targetAccount} 未连接`, isOpenAI);
      return false;
    }
    req.account = targetAccount;
    return true;
  }

  #extractKey = (req) => req.query.key || req.headers.authorization?.substring(7) || "";

  #buildNativeReq(req, id) {
    const query = { ...req.query };
    delete query.key;
    const body = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : (typeof req.body === "object" ? JSON.stringify(req.body) : req.body);
    return { path: req.path, method: req.method, headers: req.headers, query_params: query, body, request_id: id, streaming_mode: this.#server.mode };
  }

  async #dispatch(req, res, proxyReq, queue, isOpenAI) {
    const isStream = isOpenAI ? req.body?.stream : req.path.includes("streamGenerateContent");
    const account = req.account;
    if (this.#server.mode === "fake") {
      isStream ? await this.#fakeStream(req, res, proxyReq, queue, isOpenAI, account) : await this.#fakeNonStream(res, proxyReq, queue, isOpenAI, account);
    } else {
      await this.#realStream(res, proxyReq, queue, isStream, isOpenAI, account);
    }
  }

  async #fakeNonStream(res, proxyReq, queue, isOpenAI, account) {
    this.#conns.forward(account, proxyReq);
    const header = await queue.pop();
    if (header.event_type === "error") return this.#send(res, header.status, header.message, isOpenAI);
    this.#setHeaders(res, header);
    const data = await queue.pop();
    await queue.pop();
    if (data.data) isOpenAI ? res.json(JSON.parse(this.#converter.toOpenAIResponse(data.data, false))) : res.send(data.data);
  }

  async #fakeStream(req, res, proxyReq, queue, isOpenAI, account) {
    this.#sseHeaders(res);
    const timer = setInterval(() => res.write(this.#keepAlive(isOpenAI)), 1000);
    try {
      this.#conns.forward(account, proxyReq);
      const header = await queue.pop();
      if (header.event_type === "error") throw new Error(header.message);
      const data = await queue.pop();
      await queue.pop();
      if (data.data) {
        if (isOpenAI) {
          res.write(this.#converter.toOpenAIResponse(data.data, true));
          res.write("data: [DONE]\n\n");
        } else res.write(`data: ${data.data}\n\n`);
      }
    } catch (err) {
      this.#sseError(res, err.message);
    } finally {
      clearInterval(timer);
      if (!res.writableEnded) res.end();
    }
  }

  async #realStream(res, proxyReq, queue, isStream, isOpenAI, account) {
    this.#conns.forward(account, proxyReq);
    const header = await queue.pop();
    if (header.event_type === "error") return this.#send(res, header.status, header.message, isOpenAI);
    if (isStream && !header.headers?.["content-type"]) (header.headers ||= {})["content-type"] = "text/event-stream";
    this.#setHeaders(res, header);
    let fullResponse = "";
    try {
      while (true) {
        const data = await queue.pop();
        if (data.type === "STREAM_END") break;
        if (!data.data) continue;
        if (isOpenAI && isStream) res.write(this.#converter.toOpenAISSE(data.data));
        else if (isOpenAI && !isStream) fullResponse += data.data;
        else res.write(data.data);
      }
      if (isOpenAI && isStream) res.write("data: [DONE]\n\n");
      else if (isOpenAI && !isStream) res.json(JSON.parse(this.#converter.toOpenAIResponse(fullResponse, false)));
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  #setHeaders = (res, header) => {
    res.status(header.status || 200);
    Object.entries(header.headers || {}).forEach(([k, v]) => k.toLowerCase() !== "content-length" && res.set(k, v));
  }
  #sseHeaders = (res) => res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  #keepAlive = (isOpenAI) => `data: ${isOpenAI ? JSON.stringify({ id: `cmpl-${genId()}`, choices: [{ delta: {} }] }) : "{}"}\n\n`;
  #sseError = (res, msg) => !res.writableEnded && res.write(`data: ${JSON.stringify({ error: { message: `[代理] ${msg}` } })}\n\n`);
  #error(err, res, isOpenAI) {
    log("error", `错误: ${err.message}`);
    if (res.headersSent) {
      if (this.#server.mode === "fake") this.#sseError(res, err.message);
      if (!res.writableEnded) res.end();
    } else this.#send(res, 500, `代理错误: ${err.message}`, isOpenAI);
  }
  #send(res, status, msg, isOpenAI) {
    if (res.headersSent) return;
    isOpenAI && status >= 400 ? res.status(status).json({ error: { message: msg } }) : res.status(status).type("text/plain").send(msg);
  }
}

class Server {
  #handler;
  #keyManager = new KeyManager();
  mode = DEFAULT_STREAMING_MODE;

  constructor() {
    const conns = new Connections();
    this.#handler = new Handler(this, conns, this.#keyManager);
    this.start(conns);
  }

  async start(conns) {
    const app = express();

    // --- 🔥🔥🔥 CORS 修复开始 🔥🔥🔥 ---
    // 手动添加跨域头，无需安装额外依赖
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*"); // 允许所有来源
      res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "*"); // 允许所有头 (Content-Type, Authorization 等)
      
      // 如果是浏览器的预检请求(OPTIONS)，直接返回成功
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });
    // --- 🔥🔥🔥 CORS 修复结束 🔥🔥🔥 ---

    app.use(express.json({ limit: "100mb" }));
    app.use(express.raw({ type: "*/*", limit: "100mb" }));

    app.get("/", (req, res) => res.status(conns.hasConn() ? 200 : 404).send(conns.hasConn() ? "✅ 代理就绪" : "❌ 无连接"));
    app.get("/favicon.ico", (req, res) => res.status(204).send());

    app.get("/:account", (req, res, next) => {
      const account = normalizeAccount(req.params.account);
      if (!account.includes("@")) return next();
      try {
        const key = this.#keyManager.getOrCreate(account);
        res.json({ account, key });
      } catch (err) {
        log("error", `生成密钥失败: ${err.message}`);
        res.status(400).json({ error: err.message });
      }
    });

    app.get("/admin/set-mode", (req, res) => {
      if (["fake", "real"].includes(req.query.mode)) {
        this.mode = req.query.mode;
        log("info", `模式切换: ${this.mode}`);
        return res.send(`模式已切换: ${this.mode}`);
      }
      res.status(400).send('无效模式');
    });
    app.get("/admin/get-mode", (req, res) => res.send(`当前模式: ${this.mode}`));
    
    app.get("/v1/models", (req, res) => this.#handler.handleModels(req, res));
    app.post("/v1/chat/completions", (req, res) => this.#handler.handle(req, res, true));
    app.all(/(.*)/, (req, res) => this.#handler.handle(req, res, false));

    const httpServer = http.createServer(app);
    const wss = new WebSocket.Server({ server: httpServer });
    wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://localhost");
      const account = normalizeAccount(url.searchParams.get("account")) || "default";
      conns.add(ws, { address: req.socket.remoteAddress, account });
    });

    httpServer.listen(process.env.PORT || 7860, "0.0.0.0", () => {
      log("info", `服务启动于 http://0.0.0.0:${process.env.PORT || 7860}`);
      log("info", `模式: ${this.mode}`);
    });
  }
}

new Server();
