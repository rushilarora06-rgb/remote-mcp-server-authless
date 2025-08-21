# Goal
Create and maintain an OpenAPI 3.0 spec that explains our MCP server.

## Server facts
- HTTP endpoints:
  - POST /mcp (JSON-RPC 2.0 "tools/call": params = { tool, args })
  - GET  /mcp/stream (optional Server-Sent Events)
  - GET  /health (returns { ok: true })
- Security: Bearer token in Authorization header.
- Describe input/output schemas for each MCP tool.

## Deliverables
- docs/openapi/openapi.yaml (valid OpenAPI 3.0)
- Add npm scripts to lint/generate types for the spec.
- Update README with an “API” section and example curl.
