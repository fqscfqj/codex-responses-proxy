# OpenAI Chat Proxy for Responses API

A small Docker service that converts OpenAI `chat/completions` requests to an upstream OpenAI `responses` endpoint.

## Features

- Exposes `POST /v1/chat/completions`
- Exposes `GET /v1/models` (optional, controlled by env)
- Supports non-stream and stream (`stream: true`) response conversion
- Supports `tools` / `tool_choice` passthrough and converts upstream function calls back to `tool_calls`
- Forwards auth from incoming `Authorization` header, or uses `UPSTREAM_API_KEY`

## Environment Variables

- `PORT` (default: `8080`)
- `UPSTREAM_BASE` (default: `https://new.xychatai.com/codex/v1`)
- `UPSTREAM_API_KEY` (optional, recommended)
- `AVAILABLE_MODELS` (optional CSV list for `/v1/models`; empty by default)

## Build

```bash
docker build -t codex-openai-proxy .
```

## Run

```bash
docker run --rm -p 8080:8080 \
  -e UPSTREAM_BASE="https://new.xychatai.com/codex/v1" \
  -e UPSTREAM_API_KEY="YOUR_UPSTREAM_KEY" \
  codex-openai-proxy
```

## Request Example (non-stream)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2-codex",
    "messages": [
      {"role": "user", "content": "Say hello in one short sentence."}
    ]
  }'
```

## Request Example (stream)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "gpt-5.2-codex",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Count 1 to 5"}
    ]
  }'
```

## Health Check

```bash
curl http://localhost:8080/health
```

## Model Behavior

- The proxy does not predefine a default model.
- The downstream request must include `model`.
- `/v1/models` returns an empty list unless `AVAILABLE_MODELS` is set.
