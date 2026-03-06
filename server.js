import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || "https://new.xychatai.com/codex/v1").replace(/\/$/, "");
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || process.env.CODEX_API_KEY || "";
const AVAILABLE_MODELS = (process.env.AVAILABLE_MODELS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && item.type === "text") return item.text || "";
        return "";
      })
      .join("\n");
  }
  return "";
}

function normalizeMessageContent(role, content) {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  if (!Array.isArray(content)) {
    const text = extractTextContent(content);
    return text ? [{ type: "input_text", text }] : [];
  }

  const parts = [];

  for (const item of content) {
    if (typeof item === "string") {
      parts.push({ type: "input_text", text: item });
      continue;
    }

    if (!item || typeof item !== "object") continue;

    if (item.type === "text") {
      parts.push({ type: "input_text", text: item.text || "" });
      continue;
    }

    if (item.type === "input_text" || item.type === "output_text") {
      parts.push({ type: "input_text", text: item.text || "" });
    }
  }

  return parts;
}

function mapMessagesToInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const input = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const role = message.role || "user";

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || message.call_id || "",
        output: typeof message.content === "string" ? message.content : extractTextContent(message.content)
      });
      continue;
    }

    const content = normalizeMessageContent(role, message.content);

    if (content.length > 0) {
      input.push({ role, content });
    }

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.type !== "function" || !toolCall.function?.name) continue;
        input.push({
          type: "function_call",
          call_id: toolCall.id || randomUUID(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments || ""
        });
      }
    }
  }

  return input;
}

function mapTools(tools) {
  if (!Array.isArray(tools)) return undefined;

  const mapped = tools
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters || { type: "object", properties: {} }
    }));

  return mapped.length > 0 ? mapped : undefined;
}

function mapToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return {
      type: "function",
      name: toolChoice.function.name
    };
  }
  return undefined;
}

function toChatCompletionUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

function buildChatCompletionMessage(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  let text = "";
  const toolCalls = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "message" && Array.isArray(item.content)) {
      for (const contentItem of item.content) {
        if (contentItem?.type === "output_text" || contentItem?.type === "text") {
          text += contentItem.text || "";
        }
      }
    }

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || randomUUID(),
        type: "function",
        function: {
          name: item.name || "",
          arguments: item.arguments || ""
        }
      });
    }
  }

  return {
    message: {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    },
    finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
  };
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function chooseAuthHeader(incomingAuth) {
  if (incomingAuth && incomingAuth.startsWith("Bearer ")) return incomingAuth;
  if (UPSTREAM_API_KEY) return `Bearer ${UPSTREAM_API_KEY}`;
  return "";
}

async function callUpstreamResponses(payload, authHeader) {
  const resp = await fetch(`${UPSTREAM_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const text = await resp.text();
    const msg = text || `upstream error ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }

  return resp;
}

function parseSseChunk(buffer) {
  const events = [];
  let remaining = buffer;

  while (true) {
    const idx = remaining.indexOf("\n\n");
    if (idx === -1) break;

    const rawEvent = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 2);

    const lines = rawEvent.split(/\r?\n/);
    let eventName = "message";
    let data = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }

    if (data) {
      events.push({ event: eventName, data });
    }
  }

  return { events, remaining };
}

async function parseUpstreamSse(resp, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of resp.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.remaining;

    for (const evt of parsed.events) {
      try {
        const obj = JSON.parse(evt.data);
        onEvent(evt.event, obj);
      } catch {
        // Ignore malformed event payloads.
      }
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseChunk(`${buffer}\n\n`);
    for (const evt of parsed.events) {
      try {
        const obj = JSON.parse(evt.data);
        onEvent(evt.event, obj);
      } catch {
        // Ignore malformed event payloads.
      }
    }
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, upstream: UPSTREAM_BASE });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      // Optional passthrough list for clients that require model listing.
      sendJson(res, 200, {
        object: "list",
        data: AVAILABLE_MODELS.map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "proxy"
        }))
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJsonBody(req);
      const model = body.model;
      const stream = Boolean(body.stream);
      const input = mapMessagesToInput(body.messages);
      const authHeader = chooseAuthHeader(req.headers.authorization || "");

      if (!model || typeof model !== "string") {
        sendJson(res, 400, {
          error: {
            message: "Missing required field: model",
            type: "invalid_request_error"
          }
        });
        return;
      }

      if (!authHeader) {
        sendJson(res, 401, {
          error: {
            message: "Missing Authorization header and UPSTREAM_API_KEY not configured",
            type: "invalid_request_error"
          }
        });
        return;
      }

      const upstreamPayload = {
        model,
        input,
        stream: true,
        tools: mapTools(body.tools),
        tool_choice: mapToolChoice(body.tool_choice)
      };

      const upstreamResp = await callUpstreamResponses(upstreamPayload, authHeader);
      const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
      const created = nowSeconds();

      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });

        // First chunk sends assistant role, matching OpenAI streaming shape.
        sendSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
        });

        const toolCallStates = new Map();

        await parseUpstreamSse(upstreamResp, (event, payload) => {
          if (event === "response.output_text.delta") {
            const delta = payload?.delta || "";
            if (!delta) return;
            sendSse(res, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            });
          }

          if (event === "response.function_call_arguments.delta") {
            const itemId = payload?.item_id || payload?.output_index || randomUUID();
            const state = toolCallStates.get(itemId) || {
              index: toolCallStates.size,
              id: payload?.call_id || payload?.item_id || randomUUID(),
              name: payload?.name || ""
            };

            if (payload?.call_id) state.id = payload.call_id;
            if (payload?.name) state.name = payload.name;
            toolCallStates.set(itemId, state);

            sendSse(res, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: state.index,
                        id: state.id,
                        type: "function",
                        function: {
                          ...(state.name ? { name: state.name } : {}),
                          arguments: payload?.delta || ""
                        }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            });
          }

          if (event === "response.completed") {
            const completion = buildChatCompletionMessage(payload?.response);
            sendSse(res, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: completion.finish_reason }]
            });
          }
        });

        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      let completedResponse = null;

      await parseUpstreamSse(upstreamResp, (event, payload) => {
        if (event === "response.completed") {
          completedResponse = payload?.response || null;
        }
      });

      const completion = buildChatCompletionMessage(completedResponse);

      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: completion.message,
            finish_reason: completion.finish_reason
          }
        ],
        usage: toChatCompletionUsage(completedResponse?.usage)
      });
      return;
    }

    sendJson(res, 404, {
      error: {
        message: "Not found",
        type: "invalid_request_error"
      }
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    sendJson(res, status, {
      error: {
        message: error?.message || "Internal error",
        type: "proxy_error"
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`proxy listening on :${PORT}`);
});
