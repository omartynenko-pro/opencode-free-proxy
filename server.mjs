import express from "express";
import crypto from "crypto";
import https from "https";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const PROXY_VERSION = "12";

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (tok === key) return name;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────
function ocId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

// Strict x-opencode-session format: ses_ + 12 hex chars + 14 alphanumeric
function generateSessionId() {
  const HEX = "0123456789abcdef";
  const ALNUM = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let session = "ses_";
  for (let i = 0; i < 12; i++) session += HEX[Math.floor(Math.random() * HEX.length)];
  for (let i = 0; i < 14; i++) session += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return session;
}

const MODELS = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "mimo-v2.6-flash-free",
  "ling-3.0-flash-fin-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "jev-1.13-free",
];

// Gatekeeper (since 2026-09-19) requires tools named shell/bash and read
const ZEN_TOOLS = [
  { type: "function", function: { name: "shell", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

function ensureZenTools(tools) {
  if (!Array.isArray(tools) || !tools.length) {
    return JSON.parse(JSON.stringify(ZEN_TOOLS));
  }
  const names = new Set(tools.map((t) => t?.function?.name).filter(Boolean));
  const out = tools.slice();
  for (const t of ZEN_TOOLS) {
    if (!names.has(t.function.name)) out.push(JSON.parse(JSON.stringify(t)));
  }
  return out;
}

// Track sessions per user (rotate every 30 min)
const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: generateSessionId(), ts: now };
  }
  return userSessions[user].id;
}

// ── Zen API transport ──────────────────────────────────────────────
// NOTE: upstream is ALWAYS streamed (gatekeeper rejects stream:false)
// and always carries shell/read tool declarations.
function zenRequest(model, messages, stream, tools, tool_choice, sessionId) {
  const reqBody = { model, messages, stream: true, tools: ensureZenTools(tools) };
  if (tool_choice) reqBody.tool_choice = tool_choice;
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "User-Agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 120000,
    },
  };
}

// Pipe Zen response to client (OpenAI format passthrough)
function pipeZenResponse(zenOpts, body, stream, res) {
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;

    zenRes.on("data", (chunk) => {
      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();

        if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"'))) {
          try {
            const parsed = JSON.parse(str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
              console.log("[ZEN RATE LIMITED]", errMsg);
              if (!res.headersSent) {
                res.status(429).json({
                  error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error", code: "rate_limit_exceeded" }
                });
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }

        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
          res.flushHeaders();
        } else {
          res.writeHead(zenRes.statusCode, { "Content-Type": "application/json" });
        }
        res.write(firstChunk);
        if (res.flush) res.flush();
        return;
      }
      if (headersSent) {
        res.write(chunk);
        if (res.flush) res.flush();
      }
    });

    zenRes.on("end", () => {
      if (!headersSent && !firstChunk) {
        console.log("[ZEN EMPTY] No response from Zen API");
        if (!res.headersSent) {
          res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
        }
        return;
      }
      if (headersSent) res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    console.log("[ZEN TIMEOUT]");
    if (!res.headersSent) {
      res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
    }
  });

  req.write(body);
  req.end();
}

// Collect full Zen response. Upstream is ALWAYS SSE, so aggregate the
// stream into a complete OpenAI chat.completion object.
function aggregateZenSSE(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const allChunks = [];
      let buffer = "";
      let id = null, created = null, model = null;
      const msg = { role: "assistant", content: "", tool_calls: [] };
      let finishReason = "stop";
      let usage = null;
      const toolMap = new Map();

      zenRes.on("data", (c) => {
        allChunks.push(c);
        buffer += c.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { continue; }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          if (!id) id = parsed.id;
          if (parsed.created && !created) created = parsed.created;
          if (parsed.model && !model) model = parsed.model;
          const delta = choice.delta || {};
          if (delta.role) msg.role = delta.role;
          if (typeof delta.content === "string" && delta.content) msg.content += delta.content;
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              let slot = toolMap.get(i);
              if (!slot) {
                slot = { id: tc.id || null, type: "function", function: { name: "", arguments: "" } };
                toolMap.set(i, slot);
              }
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.function.name += tc.function.name;
              if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (parsed.usage) usage = parsed.usage;
        }
      });

      zenRes.on("end", () => {
        const raw = Buffer.concat(allChunks).toString();
        if (!msg.content && toolMap.size === 0) {
          let errData = null;
          try { const j = JSON.parse(raw); if (j.error || j.type === "error") errData = j; } catch {}
          resolve({ status: zenRes.statusCode, data: errData, raw });
          return;
        }
        if (toolMap.size === 0) {
          delete msg.tool_calls;
        } else {
          msg.tool_calls = [...toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        }
        if (!msg.content) msg.content = "";
        const data = {
          id: id || "chatcmpl-proxy",
          object: "chat.completion",
          created: created || Math.floor(Date.now() / 1000),
          model: model || "unknown",
          choices: [{ index: 0, message: msg, finish_reason: finishReason, logprobs: null }],
        };
        if (usage) data.usage = usage;
        resolve({ status: zenRes.statusCode, data, raw });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ── Smart fallback across free models ──────────────────────────────
// Free models are flaky: 403/429 FreeTierError, "Model is unavailable",
// "not supported". Retry the request with the next free model instead of
// failing the client.
function isRetryableUpstream(zenResp) {
  if (!zenResp) return false;
  const n = zenResp.status;
  const errData = zenResp.data?.error || zenResp.data || {};
  const msg = String(errData.message || errData.type || "").toLowerCase();
  if (n === 403 || n === 429 || n >= 500) return true;
  if (/freeusage|freetier|not supported|unavailable|rate limit|free tier|server_error/i.test(msg)) return true;
  return false;
}

async function zenSyncWithFallback(model, messages, tools, tool_choice, sessionId) {
  const candidates = [model, ...MODELS.filter((m) => m !== model)];
  let last = null;
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const { body, options } = zenRequest(m, messages, false, tools, tool_choice, sessionId);
    let resp;
    try {
      resp = await aggregateZenSSE(options, body);
    } catch (e) {
      last = { status: 502, data: { error: { message: e.message } }, raw: "" };
      continue;
    }
    const errBody = resp.data?.error || (resp.data?.type === "error" ? resp.data : null);
    if (resp.status === 200 && !errBody && resp.data?.choices) {
      console.log("[FALLBACK OK]", m, "(try " + (i + 1) + ")");
      return { ok: true, resp, model: m };
    }
    last = { status: resp.status, data: resp.data || { error: { message: String(resp.raw || "").slice(0, 200) } }, raw: resp.raw };
    console.log("[FALLBACK] model:", m, "→ status:", resp.status, "msg:", (errBody?.message || "").slice(0, 140));
    if (!isRetryableUpstream(resp)) break;
  }
  return { ok: false, resp: last, model: null };
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      // tool_use blocks → assistant tool_calls
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

// OpenAI response → Anthropic Messages format
function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Stream OpenAI SSE → Anthropic SSE
function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens) {
  const msgId = ocId("msg");

  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;

    function sendSSE(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    }

    function sendHeaders() {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model, stop_reason: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();

      // Check for errors on first chunk
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit";
              if (!res.headersSent) {
                res.writeHead(429, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  type: "error",
                  error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
                }));
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      buffer += str;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        sendHeaders();

        // Text content
        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (idx > toolIdx) {
              // Close previous text block if open
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
              }
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", {
                type: "content_block_start", index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "" },
              });
            }
            if (tc.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
              outputTokens += Math.ceil(tc.function.arguments.length / 4);
            }
          }
        }

        // Finish
        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          // Close open blocks
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
            sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          }

          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";

          sendSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
          });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent) {
        if (!res.headersSent) {
          res.status(502).json({ type: "error", error: { type: "upstream_error", message: "Empty response" } });
        }
        return;
      }
      res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
    }
  });

  req.write(body);
  req.end();
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({
      id, object: "model", created: 1779000000, owned_by: "opencode-free",
    })),
  });
});

app.post("/v1/chat/completions", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }

  const sessionId = getSession(user);
  const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));
  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  if (stream) {
    const { body, options } = zenRequest(model, messages, true, tools, tool_choice, sessionId);
    pipeZenResponse(options, body, true, res);
  } else {
    zenSyncWithFallback(model, messages, tools, tool_choice, sessionId).then(({ ok, resp }) => {
      if (!ok) {
        const errBody = resp.data?.error || (resp.data?.type === "error" ? resp.data : null);
        const errMsg = errBody?.message || `Upstream ${resp.status}`;
        const status = errBody ? 429 : (resp.status >= 500 ? 502 : 429);
        console.log("[OAI UPSTREAM ERR]", resp.status, errMsg);
        return res.status(status).json({ error: { message: errMsg, type: "api_error", code: "upstream_error" } });
      }
      res.json(resp.data);
    }).catch((e) => {
      console.log("[ZEN ERROR]", e.message);
      if (!res.headersSent) res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    });
  }
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }

  const { model, stream } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` },
    });
  }

  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  if (stream) {
    const { body, options } = zenRequest(model, messages, true, tools, undefined, sessionId);
    pipeZenAsAnthropic(options, body, model, res, inputTokens);
  } else {
    try {
      const { ok, resp, model: usedModel } = await zenSyncWithFallback(model, messages, tools, undefined, sessionId);
      if (!ok) {
        const zenErr = resp.data?.error || (resp.data?.type === "error" ? resp.data : null);
        const errMsg = zenErr?.message || resp.data?.message || "Rate limit exceeded";
        const isLimit = (resp.status === 403 || resp.status === 429);
        console.log("[ANT UPSTREAM ERR]", resp.status, errMsg);
        return res.status(isLimit ? 429 : 502).json({
          type: "error", error: { type: isLimit ? "rate_limit_error" : "upstream_error", message: errMsg },
        });
      }
      res.json(openAIToAnthropic(resp.data, usedModel, inputTokens));
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
}));

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} on http://0.0.0.0:${PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  console.log("  Health:    GET  /health");
  console.log("  Models:", MODELS.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
});
