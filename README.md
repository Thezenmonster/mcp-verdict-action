# MCP Verdict Check

GitHub Action that checks MCP package trust verdicts before deploy.

Powered by [AgentScore](https://agentscores.xyz).

## Example Output

```
Checking 3 MCP package(s): @modelcontextprotocol/server-github, exa-mcp-server, mcp-trust-guard
  ⚠️ @modelcontextprotocol/server-github: warn (score: 85/100, risk: LOW)
     Provenance: no, Trusted publishing: no
     Reasons: no_repository, no_provenance
  ✅ exa-mcp-server: allow (score: 90/100, risk: LOW)
     Provenance: no, Trusted publishing: no
     Reasons: no_license, no_provenance
  ✅ mcp-trust-guard: allow (score: 95/100, risk: LOW)
     Provenance: no, Trusted publishing: no
     Reasons: no_provenance

Results: 2 allow, 1 warn, 0 block
All MCP packages passed the verdict check.
```

From a real CI run: [mcp-verdict-demo](https://github.com/Thezenmonster/mcp-verdict-demo/actions)

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

- [Demo Repo](https://github.com/Thezenmonster/mcp-verdict-demo)
- [AgentScore](https://agentscores.xyz)
- [API Docs](https://agentscores.xyz/docs)

MIT
