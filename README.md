# MCP Verdict Check

GitHub Action that checks MCP package trust verdicts before deploy.

Powered by [AgentScore](https://agentscores.xyz).

## Usage

```yaml
- uses: Thezenmonster/mcp-verdict-action@v1
  with:
    fail-on: "block"
```

Auto-detects MCP dependencies from package.json. Returns allow/warn/block for each. No API key needed.

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| packages | Comma-separated package names (auto-detects if empty) | auto-detect |
| fail-on | Fail threshold: warn or block | block |

## Links

- [AgentScore](https://agentscores.xyz)
- [API Docs](https://agentscores.xyz/docs)
- [Demo Repo](https://github.com/Thezenmonster/mcp-verdict-demo)

MIT
