# OpenAI Chat Proxy for Responses API

一个轻量的 Docker 服务，用于将 OpenAI `chat/completions` 请求转换并转发到上游 OpenAI `responses` 接口。

## 功能

- 提供 `POST /v1/chat/completions`
- 提供 `GET /v1/models`（可选，由环境变量控制）
- 支持非流式和流式（`stream: true`）响应转换
- 支持 `tools` / `tool_choice` 透传，并将上游函数调用转换回 `tool_calls`
- 优先转发请求中的 `Authorization` 头；如果没有，则使用 `UPSTREAM_API_KEY`

## 环境变量

- `PORT`：监听端口，默认值为 `8080`
- `UPSTREAM_BASE`：上游 `responses` API 基础地址，默认值为 `https://new.xychatai.com/codex/v1`
- `UPSTREAM_API_KEY`：上游 API Key，可选但推荐配置
- `AVAILABLE_MODELS`：用于 `/v1/models` 的可选 CSV 模型列表，默认为空

## 构建镜像

```bash
docker build -t codex-openai-proxy .
```

## 发布 GHCR 镜像

仓库内置了一个 GitHub Actions 工作流，用于手动触发构建并发布镜像到 GHCR。

- 触发方式：GitHub Actions 页面手动运行 `Publish GHCR Image`
- 发布地址：`ghcr.io/fqscfqj/codex-responses-proxy`
- 发布标签：`latest`

拉取示例：

```bash
docker pull ghcr.io/fqscfqj/codex-responses-proxy:latest
```

## 运行容器

先在宿主机上准备上游基础地址，再通过 Docker 环境变量传入容器：

```bash
export UPSTREAM_BASE="https://your-upstream-host/codex/v1"
export UPSTREAM_API_KEY="YOUR_UPSTREAM_KEY"
```

```bash
docker run --rm -p 8080:8080 \
  -e UPSTREAM_BASE="$UPSTREAM_BASE" \
  -e UPSTREAM_API_KEY="$UPSTREAM_API_KEY" \
  codex-openai-proxy
```

如果使用 Windows PowerShell：

```powershell
$env:UPSTREAM_BASE = "https://your-upstream-host/codex/v1"
$env:UPSTREAM_API_KEY = "YOUR_UPSTREAM_KEY"

docker run --rm -p 8080:8080 `
  -e UPSTREAM_BASE=$env:UPSTREAM_BASE `
  -e UPSTREAM_API_KEY=$env:UPSTREAM_API_KEY `
  codex-openai-proxy
```

## 请求示例（非流式）

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2-codex",
    "messages": [
      {"role": "user", "content": "请用一句简短的话打个招呼。"}
    ]
  }'
```

## 请求示例（流式）

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "gpt-5.2-codex",
    "stream": true,
    "messages": [
      {"role": "user", "content": "从 1 数到 5"}
    ]
  }'
```

## 健康检查

```bash
curl http://localhost:8080/health
```

## 模型行为说明

- 代理服务本身不会预设默认模型。
- 下游请求必须显式包含 `model`。
- 如果未设置 `AVAILABLE_MODELS`，则 `/v1/models` 返回空列表。
