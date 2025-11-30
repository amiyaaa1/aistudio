const WS_ENDPOINT = "wss://wuchen.zeabur.app";

const log = (...msgs) => {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const ms = `.${new Date().getMilliseconds().toString().padStart(3, "0")}`;
  const timestamp = `[${time}${ms}]`;
  console.log(`[ProxyClient]`, timestamp, ...msgs);

  const div = document.createElement("div");
  div.textContent = `${timestamp} ${msgs.join(" ")}`;
  document.body.appendChild(div);
};

class Connection extends EventTarget {
  #ws = null;
  #reconnectTimer = null;
  #attempts = 0;

  constructor(endpoint = WS_ENDPOINT) {
    super();
    this.endpoint = endpoint;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    log("连接中:", this.endpoint);
    try {
      this.#ws = new WebSocket(this.endpoint);
      this.#bindEvents();
    } catch (err) {
      log("WS初始化失败:", err.message);
      this.#reconnect();
    }
  }

  send(data) {
    if (!this.connected) return log("发送失败: 未连接");
    this.#ws.send(JSON.stringify(data));
  }

  #bindEvents() {
    this.#ws.addEventListener("open", () => {
      this.connected = true;
      this.#attempts = 0;
      this.#clearReconnectTimer();
      log("✅ 连接成功");
      this.dispatchEvent(new Event("connected"));
    });

    this.#ws.addEventListener("close", () => {
      if (this.connected) {
        this.connected = false;
        log("❌ 连接断开");
        this.dispatchEvent(new Event("disconnected"));
      }
      this.#reconnect();
    });

    this.#ws.addEventListener("error", (err) => log("WS错误:", err));
    this.#ws.addEventListener("message", (e) => this.dispatchEvent(new MessageEvent("message", { data: e.data })));
  }

  #reconnect() {
    if (this.#reconnectTimer) return;
    this.#attempts++;
    const delay = 5000;
    log(`${delay / 1000}秒后尝试重连 (第 ${this.#attempts} 次)...`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  #clearReconnectTimer() {
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
}

class Processor {
  #ops = new Map();
  #domain = "generativelanguage.googleapis.com";

  async exec(spec, id) {
    const ctrl = new AbortController();
    this.#ops.set(id, ctrl);
    try {
      return await this.#retry(spec, ctrl);
    } finally {
      this.#ops.delete(id);
    }
  }

  cancelAll() {
    this.#ops.forEach((ctrl) => ctrl.abort("Connection closed"));
    this.#ops.clear();
  }

  async #retry(spec, ctrl) {
    for (let i = 1; i <= 3; i++) {
      try {
        log(`执行请求 (${i}/3):`, spec.method, spec.path);
        const url = this.#buildUrl(spec);
        const config = this.#buildConfig(spec, ctrl.signal);
        const res = await fetch(url, config);
        if (!res.ok) throw new Error(`API错误: ${res.status} ${res.statusText} ${await res.text()}`);
        return res;
      } catch (err) {
        if (err.name === "AbortError") throw err;
        log(`❌ 尝试 #${i} 失败: ${err.message.slice(0, 200)}`);
        if (i < 3) await new Promise((r) => setTimeout(r, 2000));
        else throw err;
      }
    }
  }

  #buildUrl(spec) {
    let path = spec.path.startsWith("/") ? spec.path.slice(1) : spec.path;
    const params = new URLSearchParams(spec.query_params);
    if (spec.streaming_mode === "fake") {
      path = path.replace(":streamGenerateContent", ":generateContent");
      params.delete("alt");
    }
    const query = params.toString();
    return `https://${this.#domain}/${path}${query ? `?${query}` : ""}`;
  }

  #buildConfig(spec, signal) {
    const config = { method: spec.method, headers: this.#cleanHeaders(spec.headers), signal };
    if (["POST", "PUT", "PATCH"].includes(spec.method) && spec.body) config.body = spec.body;
    return config;
  }

  #cleanHeaders = (headers) => {
    const clean = { ...headers };
    ["host", "connection", "content-length", "origin", "referer", "user-agent", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"].forEach(h => delete clean[h]);
    return clean;
  }
}

class Proxy {
  #conn;
  #proc = new Processor();

  constructor(endpoint) {
    this.#conn = new Connection(endpoint);
    this.#setup();
  }

  async init() {
    log("系统初始化...");
    await this.#conn.connect();
    log("系统就绪");
  }

  #setup() {
    this.#conn.addEventListener("message", (e) => this.#onMessage(e.data));
    this.#conn.addEventListener("disconnected", () => this.#proc.cancelAll());
  }

  async #onMessage(data) {
    try {
      const spec = JSON.parse(data);
      log(`收到请求: ${spec.method} ${spec.path} (${spec.streaming_mode || "fake"})`);
      await this.#process(spec);
    } catch (err) {
      log("处理错误:", err.message);
      this.#sendError(err, JSON.parse(data)?.request_id);
    }
  }

  async #process(spec) {
    const { request_id: id, streaming_mode: mode = "fake", path } = spec;
    const isStream = path.includes(":streamGenerateContent");
    let finishReason = "UNKNOWN";

    try {
      const res = await this.#proc.exec(spec, id);
      this.#sendHeaders(res, id);

      if (!res.body) {
        this.#logComplete({ mode, isStream, fullBody: "", finishReason });
        return this.#sendEnd(id);
      }

      const stream = res.body.pipeThrough(new TextDecoderStream());
      let fullBody = "";

      for await (const chunk of stream) {
        if (mode === "real") {
          if (isStream) {
            finishReason = this.#extractFinish(chunk, finishReason);
          }
          this.#sendChunk(chunk, id);
        } else {
          fullBody += chunk;
        }
      }

      log("流读取完成");
      this.#logComplete({ mode, isStream, fullBody, finishReason });

      if (mode === "fake") this.#sendChunk(fullBody, id);
      this.#sendEnd(id);
    } catch (err) {
      log(`❌ 错误: ${err.message}`);
      this.#sendError(err, id);
    }
  }
  
  #extractFinish(chunk, currentReason) {
    try {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = JSON.parse(line.slice(5));
          const reason = payload.candidates?.[0]?.finishReason;
          if (reason) return reason;
        }
      }
    } catch {}
    return currentReason;
  }

  #logComplete({ mode, isStream, fullBody, finishReason }) {
    if (mode === "real") {
      if (!isStream) return log("✅ 响应成功");
      return log(finishReason === "STOP" ? "✅ 响应成功" : `🤔 响应异常: ${finishReason}`);
    }
  
    let msg = "✅ 响应成功";
    if (isStream) {
      try {
        const parsed = JSON.parse(fullBody);
        const reason = parsed.candidates?.[0]?.finishReason;
        msg = reason === "STOP" ? "✅ 响应成功" : `🤔 响应异常: ${reason || "未知"}`;
      } catch {
        msg = "⚠️ 响应非JSON";
      }
    }
    log(msg);
  }

  #sendHeaders(res, id) {
    const headers = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    this.#conn.send({ request_id: id, event_type: "response_headers", status: res.status, headers });
  }

  #sendChunk(chunk, id) {
    if (chunk) this.#conn.send({ request_id: id, event_type: "chunk", data: chunk });
  }

  #sendEnd(id) {
    this.#conn.send({ request_id: id, event_type: "stream_close" });
    log("任务完成");
  }

  #sendError(err, id) {
    if (!id) return;
    this.#conn.send({
      request_id: id,
      event_type: "error",
      status: 504,
      message: `浏览器错误: ${err.name === "AbortError" ? "请求被中止" : err.message}`,
    });
    log("错误已发送");
  }
}

async function main() {
  document.body.innerHTML = "";
  try {
    const proxy = new Proxy();
    await proxy.init();
  } catch (err) {
    log("启动失败:", err.message);
  }
}

main();