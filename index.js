const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");

const USER_AGENT = "AgentScore-GitHubAction/2.3";

const CAPABILITY_LABELS = {
  filesystem_read: "file read",
  filesystem_write: "file write",
  network_egress: "outbound network",
  browser_automation: "browser",
  repo_read: "repo read",
  repo_write: "repo write",
  database_access: "database",
  secrets_access: "secrets",
  shell_exec: "shell exec",
  email_messaging: "email/messaging",
  cloud_infra: "cloud infra",
  memory_state: "memory",
  search_index: "search",
  code_analysis: "code analysis",
  unknown: "unknown",
};

function formatResultLine(result) {
  const icon = result.effective_verdict === "allow"
    ? "\u2705"
    : result.effective_verdict === "warn"
      ? "\u26A0\uFE0F"
      : "\u274C";
  const versionText = result.version ? `@${result.version}` : "";
  let line = `  ${icon} ${result.name}${versionText}: ${result.effective_verdict} (score: ${result.score ?? "?"}/100)`;

  if (result.requested_version && result.version && result.requested_version !== result.version) {
    line += ` [requested ${result.requested_version}]`;
  }
  if (result.verdict !== result.effective_verdict) {
    line += ` [exception: ${result.verdict} -> ${result.effective_verdict}]`;
  }

  core.info(line);

  // Show capabilities if present
  if (result.capabilities?.length > 0) {
    const labels = result.capabilities
      .map((c) => CAPABILITY_LABELS[c] || c)
      .join(", ");
    core.info(`     powers: ${labels}`);
  }

  if (result.approval_review?.unapproved?.length > 0) {
    const labels = result.approval_review.unapproved
      .map((entry) => CAPABILITY_LABELS[entry.capability] || entry.capability)
      .join(", ");
    core.info(`     review required: ${labels}`);
  }

  if (result.approval_review?.stale?.length > 0) {
    const labels = result.approval_review.stale
      .map((entry) => `${CAPABILITY_LABELS[entry.capability] || entry.capability} (${(entry.reasons || []).join("; ")})`)
      .join(", ");
    core.info(`     reapproval required: ${labels}`);
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeRequestedVersion(spec) {
  if (!spec || typeof spec !== "string") return null;
  const trimmed = spec.trim();
  if (/^\d+\.\d+\.\d+([-.].+)?$/.test(trimmed)) return trimmed;

  const cleaned = trimmed.replace(/^[~^]/, "");
  if (/^\d+\.\d+\.\d+([-.].+)?$/.test(cleaned)) return cleaned;
  return null;
}

function resolveLockedVersion(lockfile, packageName) {
  if (!lockfile) return null;

  const packageEntry = lockfile.packages?.[`node_modules/${packageName}`];
  if (packageEntry?.version) return packageEntry.version;

  const dependencyEntry = lockfile.dependencies?.[packageName];
  if (dependencyEntry?.version) return dependencyEntry.version;

  return null;
}

const MCP_NAME_PATTERNS = [/mcp/i, /@modelcontextprotocol/i, /model-context-protocol/i];

const MCP_CONFIG_FILES = [
  ".mcp.json",
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  "claude_desktop_config.json",
];

function isMcpPackageName(name) {
  return MCP_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Extract npm package names from MCP config command objects.
 * Handles patterns like: { "command": "npx", "args": ["-y", "@scope/mcp-server"] }
 */
function extractPackagesFromConfig(config) {
  const packages = [];
  const unsupported = [];

  function walkServers(obj) {
    if (!obj || typeof obj !== "object") return;

    for (const [serverName, server] of Object.entries(obj)) {
      if (!server || typeof server !== "object") continue;

      // HTTP/URL-based servers -- not npm packages
      if (server.url || server.type === "http") continue;

      const command = typeof server.command === "string" ? server.command : "";
      const args = Array.isArray(server.args) ? server.args.filter((a) => typeof a === "string") : [];

      if (!command) continue;

      // Check for non-npm install patterns
      if (command === "uvx" || command === "pipx") {
        const fromArg = args.indexOf("--from");
        const source = fromArg >= 0 ? args[fromArg + 1] : args.find((a) => !a.startsWith("-"));
        if (source && (source.startsWith("git+") || source.includes("github.com"))) {
          unsupported.push({ server: serverName, source, reason: "git URL install (not an npm package)" });
        } else if (source) {
          unsupported.push({ server: serverName, source, reason: "Python package (not scannable via npm)" });
        }
        continue;
      }

      if (command === "docker") {
        unsupported.push({ server: serverName, source: args.join(" "), reason: "Docker container (not scannable via npm)" });
        continue;
      }

      // npm-based commands: npx, pnpm, pnpx, bunx, yarn, npm
      const npmCommands = ["npx", "pnpm", "pnpx", "bunx", "yarn", "npm"];
      if (!npmCommands.includes(command)) continue;

      for (const arg of args) {
        if (!arg || arg.startsWith("-")) continue;
        if (["exec", "dlx", "create", "-y"].includes(arg)) continue;
        // Strip @latest or @version suffix for the name check
        const nameOnly = arg.replace(/@(latest|[\d.]+.*)$/, "");
        if (isMcpPackageName(nameOnly) || isMcpPackageName(arg)) {
          packages.push({
            name: nameOnly,
            requested_version: arg.includes("@") && !arg.endsWith("@latest") ? arg.split("@").pop() : null,
            version: null,
            source: "mcp-config",
          });
        }
      }
    }
  }

  // Handle { mcpServers: { ... } } or { "mcpServers": { ... } }
  if (config.mcpServers) {
    walkServers(config.mcpServers);
  }
  // Handle { context_servers: { ... } } (Zed format)
  if (config.context_servers) {
    walkServers(config.context_servers);
  }
  // Handle top-level server objects
  if (!config.mcpServers && !config.context_servers) {
    walkServers(config);
  }

  return { packages, unsupported };
}

/**
 * Find MCP config files and extract packages from them.
 */
function findMcpConfigPackages() {
  const packages = [];
  const allUnsupported = [];
  const checkedFiles = [];

  for (const configFile of MCP_CONFIG_FILES) {
    const configPath = path.join(process.cwd(), configFile);
    const config = readJsonIfExists(configPath);
    if (!config) continue;

    checkedFiles.push(configFile);
    const { packages: found, unsupported } = extractPackagesFromConfig(config);
    packages.push(...found);
    allUnsupported.push(...unsupported);
  }

  return { packages, unsupported: allUnsupported, checkedFiles };
}

/**
 * Find MCP packages in workspace subdirectories.
 */
function findWorkspacePackages() {
  const pkgPath = path.join(process.cwd(), "package.json");
  const pkg = readJsonIfExists(pkgPath);
  if (!pkg || !pkg.workspaces) return [];

  const workspaceDirs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
  const packages = [];

  for (const pattern of workspaceDirs) {
    // Simple glob: replace * with directory listing
    const base = pattern.replace(/\/?\*.*$/, "");
    const basePath = path.join(process.cwd(), base);
    if (!fs.existsSync(basePath) || !fs.statSync(basePath).isDirectory()) continue;

    const entries = pattern.includes("*")
      ? fs.readdirSync(basePath).map((d) => path.join(basePath, d))
      : [basePath];

    for (const dir of entries) {
      const wsPkgPath = path.join(dir, "package.json");
      const wsPkg = readJsonIfExists(wsPkgPath);
      if (!wsPkg) continue;

      const allDeps = { ...wsPkg.dependencies, ...wsPkg.devDependencies };
      const lockfile = readJsonIfExists(path.join(dir, "package-lock.json"))
        || readJsonIfExists(path.join(process.cwd(), "package-lock.json"));

      for (const [name, requestedVersion] of Object.entries(allDeps)) {
        if (!isMcpPackageName(name)) continue;
        packages.push({
          name,
          requested_version: requestedVersion,
          version: resolveLockedVersion(lockfile, name) || normalizeRequestedVersion(requestedVersion),
          source: "workspace",
        });
      }
    }
  }

  return packages;
}

function findMcpDependencies() {
  const seen = new Set();
  const results = [];

  function addUnique(pkg) {
    if (seen.has(pkg.name)) return;
    seen.add(pkg.name);
    results.push(pkg);
  }

  // 1. Root package.json
  const pkgPath = path.join(process.cwd(), "package.json");
  const pkg = readJsonIfExists(pkgPath);
  if (pkg) {
    const lockfile = readJsonIfExists(path.join(process.cwd(), "package-lock.json"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const [name, requestedVersion] of Object.entries(allDeps)) {
      if (!isMcpPackageName(name)) continue;
      addUnique({
        name,
        requested_version: requestedVersion,
        version: resolveLockedVersion(lockfile, name) || normalizeRequestedVersion(requestedVersion),
        source: "package.json",
      });
    }
  }

  // 2. MCP config files (.mcp.json, mcp.json, etc.)
  const { packages: configPackages, unsupported, checkedFiles } = findMcpConfigPackages();
  for (const cp of configPackages) addUnique(cp);

  if (checkedFiles.length > 0) {
    core.info(`MCP config files found: ${checkedFiles.join(", ")}`);
  }

  // Warn about unsupported sources
  for (const u of unsupported) {
    core.warning(`${u.server}: ${u.reason} (${u.source}). Not scannable by AgentScore.`);
  }

  // 3. Workspace subdirectories
  const workspacePackages = findWorkspacePackages();
  for (const wp of workspacePackages) addUnique(wp);

  if (workspacePackages.length > 0) {
    core.info(`Found ${workspacePackages.length} MCP package(s) in workspace subdirectories.`);
  }

  if (results.length === 0 && !pkg) {
    core.warning("No package.json or MCP config files found in workspace root.");
  }

  return results;
}

async function run() {
  try {
    const apiUrl = core.getInput("api-url");
    const apiKey = core.getInput("api-key");
    const failOn = core.getInput("fail-on") || "block";
    const failOpen = core.getInput("fail-open") === "true";
    const packagesInput = core.getInput("packages");

    let packages;
    if (packagesInput) {
      packages = packagesInput
        .split(",")
        .map((pkg) => pkg.trim())
        .filter(Boolean)
        .map((name) => ({ name, requested_version: null, version: null }));
    } else {
      packages = findMcpDependencies();
    }

    if (packages.length === 0) {
      core.info("No MCP packages found to check.");
      core.setOutput("results", "[]");
      core.setOutput("passed", "true");
      return;
    }

    core.info(`Checking ${packages.length} MCP package(s): ${packages.map((pkg) => pkg.name).join(", ")}`);

    if (!apiKey) {
      // Try OIDC self-provisioning if the workflow has id-token: write permission
      const oidcToken = await requestOidcToken();
      if (oidcToken) {
        core.info("No api-key provided. Using GitHub OIDC for authentication.");
        await runWithOidc(apiUrl, oidcToken, packages, failOn, failOpen);
        return;
      }
      core.info("No api-key and no OIDC token available. Running without repo inventory tracking.");
      await runWithoutKey(apiUrl, packages, failOn);
      return;
    }

    const repo = process.env.GITHUB_REPOSITORY || "";
    const commit = process.env.GITHUB_SHA || "";
    const branch = process.env.GITHUB_REF_NAME || "";
    const pr = process.env.GITHUB_EVENT_NAME === "pull_request"
      ? parseInt(process.env.GITHUB_REF?.match(/\d+/)?.[0] || "0", 10) || null
      : null;
    const workflowUrl = repo && process.env.GITHUB_RUN_ID
      ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

    const checkRes = await fetch(`${apiUrl}/api/repo/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-AgentScore-Key": apiKey,
      },
      body: JSON.stringify({
        repo,
        commit,
        branch,
        pr,
        workflow_url: workflowUrl,
        packages,
        fail_on: failOn,
        fail_open: failOpen,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!checkRes.ok) {
      if (failOpen) {
        core.warning(`Policy check failed (HTTP ${checkRes.status}). Fail-open: passing.`);
        core.setOutput("results", "[]");
        core.setOutput("passed", "true");
        return;
      }

      const body = await checkRes.text();
      core.setFailed(`Policy check failed (HTTP ${checkRes.status}): ${body}`);
      return;
    }

    const decision = await checkRes.json();

    if (decision.error) {
      core.warning(decision.error);
    }

    for (const result of decision.results) {
      formatResultLine(result);
    }

    if (decision.exceptions_applied?.length > 0) {
      core.info("");
      core.info("Exceptions applied:");
      for (const exception of decision.exceptions_applied) {
        core.info(`  ${exception.package}: ${exception.original_verdict} -> ${exception.effective_verdict} (${exception.reason || "no reason"})`);
      }
    }

    // Capability changes
    if (decision.capability_diff) {
      const cd = decision.capability_diff;
      if (cd.new_capabilities?.length > 0) {
        core.info("");
        core.info("New AI capabilities introduced:");
        for (const nc of cd.new_capabilities) {
          const label = CAPABILITY_LABELS[nc.capability] || nc.capability;
          core.info(`  + ${nc.package}: ${label}`);
        }
      }
      if (cd.removed_capabilities?.length > 0) {
        core.info("");
        core.info("AI capabilities removed:");
        for (const rc of cd.removed_capabilities) {
          const label = CAPABILITY_LABELS[rc.capability] || rc.capability;
          core.info(`  - ${rc.package}: ${label}`);
        }
      }
    }

    core.info("");
    const allow = decision.results.filter((result) => result.effective_verdict === "allow").length;
    const warn = decision.results.filter((result) => result.effective_verdict === "warn").length;
    const block = decision.results.filter((result) => result.effective_verdict === "block").length;
    core.info(`Results: ${allow} allow, ${warn} warn, ${block} block | Policy: ${decision.policy_version || "legacy"} | fail-on: ${decision.fail_on || failOn}`);
    core.info(`Repo inventory updated. Decision: ${decision.decision_id}`);

    core.setOutput("results", JSON.stringify(decision.results));
    core.setOutput("passed", String(decision.passed));

    await postPRComment(decision);

    if (!decision.passed) {
      core.setFailed("One or more MCP packages failed the policy check.");
    } else {
      core.info("All MCP packages passed the policy check.");
    }
  } catch (error) {
    if (core.getInput("fail-open") === "true") {
      core.warning(`Action error: ${error.message}. Fail-open: passing.`);
      core.setOutput("results", "[]");
      core.setOutput("passed", "true");
      return;
    }

    core.setFailed(`Action failed: ${error.message}`);
  }
}

async function requestOidcToken() {
  const tokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const tokenReqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!tokenUrl || !tokenReqToken) return null;

  try {
    const url = `${tokenUrl}&audience=agentscores.xyz`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenReqToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.value || null;
  } catch {
    return null;
  }
}

async function runWithOidc(apiUrl, oidcToken, packages, failOn, failOpen) {
  const repo = process.env.GITHUB_REPOSITORY || "";
  const commit = process.env.GITHUB_SHA || "";
  const branch = process.env.GITHUB_REF_NAME || "";
  const pr = process.env.GITHUB_EVENT_NAME === "pull_request"
    ? parseInt(process.env.GITHUB_REF?.match(/\d+/)?.[0] || "0", 10) || null
    : null;
  const workflowUrl = repo && process.env.GITHUB_RUN_ID
    ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

  const checkRes = await fetch(`${apiUrl}/api/repo/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-GitHub-OIDC-Token": oidcToken,
    },
    body: JSON.stringify({
      repo,
      commit,
      branch,
      pr,
      workflow_url: workflowUrl,
      packages,
      fail_on: failOn,
      fail_open: failOpen,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!checkRes.ok) {
    if (failOpen) {
      core.warning(`Policy check failed (HTTP ${checkRes.status}). Fail-open: passing.`);
      core.setOutput("results", "[]");
      core.setOutput("passed", "true");
      return;
    }
    const body = await checkRes.text();
    core.setFailed(`Policy check failed (HTTP ${checkRes.status}): ${body}`);
    return;
  }

  const decision = await checkRes.json();

  if (decision.autoProvisioned) {
    core.info("Repo auto-provisioned via GitHub OIDC. No API key needed.");
  }

  if (decision.error) {
    core.warning(decision.error);
  }

  for (const result of decision.results) {
    formatResultLine(result);
  }

  if (decision.exceptions_applied?.length > 0) {
    core.info("");
    core.info("Exceptions applied:");
    for (const exception of decision.exceptions_applied) {
      core.info(`  ${exception.package}: ${exception.original_verdict} -> ${exception.effective_verdict} (${exception.reason || "no reason"})`);
    }
  }

  // Capability changes
  if (decision.capability_diff) {
    const cd = decision.capability_diff;
    if (cd.new_capabilities?.length > 0) {
      core.info("");
      core.info("New AI capabilities introduced:");
      for (const nc of cd.new_capabilities) {
        const label = CAPABILITY_LABELS[nc.capability] || nc.capability;
        core.info(`  + ${nc.package}: ${label}`);
      }
    }
    if (cd.removed_capabilities?.length > 0) {
      core.info("");
      core.info("AI capabilities removed:");
      for (const rc of cd.removed_capabilities) {
        const label = CAPABILITY_LABELS[rc.capability] || rc.capability;
        core.info(`  - ${rc.package}: ${label}`);
      }
    }
  }

  core.info("");
  const allow = decision.results.filter((r) => r.effective_verdict === "allow").length;
  const warn = decision.results.filter((r) => r.effective_verdict === "warn").length;
  const block = decision.results.filter((r) => r.effective_verdict === "block").length;
  core.info(`Results: ${allow} allow, ${warn} warn, ${block} block | Policy: ${decision.policy_version || "legacy"} | fail-on: ${decision.fail_on || failOn}`);
  core.info(`Repo inventory updated. Decision: ${decision.decision_id}`);

  core.setOutput("results", JSON.stringify(decision.results));
  core.setOutput("passed", String(decision.passed));

  await postPRComment(decision);

  if (!decision.passed) {
    core.setFailed("One or more MCP packages failed the policy check.");
  } else {
    core.info("All MCP packages passed the policy check.");
  }
}

async function postPRComment(decision) {
  // Only post on pull_request events
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return;

  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const prNumber = github.context.payload.pull_request?.number;
    if (!prNumber) return;

    const results = decision.results || [];
    if (results.length === 0) return;

    // Build the comment body
    const lines = [];
    const passed = decision.passed;
    const icon = passed ? "&#x2705;" : "&#x26A0;&#xFE0F;";

    lines.push(`## ${icon} AgentScore Policy Gate`);
    lines.push("");
    lines.push(`| Package | Score | Verdict | Powers |`);
    lines.push(`|---------|-------|---------|--------|`);

    for (const r of results) {
      const versionText = r.version ? `@${r.version}` : "";
      const verdict = r.effective_verdict || r.verdict || "unknown";
      const verdictBadge = verdict === "allow" ? "&#x2705; allow" : verdict === "warn" ? "&#x26A0;&#xFE0F; warn" : verdict === "block" ? "&#x274C; block" : "? unknown";
      const powers = (r.capabilities || [])
        .map((c) => CAPABILITY_LABELS[c] || c)
        .join(", ") || "none detected";
      lines.push(`| \`${r.name}${versionText}\` | ${r.score ?? "?"}/100 | ${verdictBadge} | ${powers} |`);
    }

    // Capability diff
    if (decision.capability_diff) {
      const cd = decision.capability_diff;
      if (cd.new_capabilities?.length > 0) {
        lines.push("");
        lines.push("**New AI capabilities introduced:**");
        for (const nc of cd.new_capabilities) {
          lines.push(`- \`${nc.package}\`: ${CAPABILITY_LABELS[nc.capability] || nc.capability}`);
        }
      }
      if (cd.removed_capabilities?.length > 0) {
        lines.push("");
        lines.push("**AI capabilities removed:**");
        for (const rc of cd.removed_capabilities) {
          lines.push(`- \`${rc.package}\`: ${CAPABILITY_LABELS[rc.capability] || rc.capability}`);
        }
      }
    }

    // Exceptions
    if (decision.exceptions_applied?.length > 0) {
      lines.push("");
      lines.push("**Exceptions applied:**");
      for (const ex of decision.exceptions_applied) {
        lines.push(`- \`${ex.package}\`: ${ex.original_verdict} -> ${ex.effective_verdict} (${ex.reason || "no reason"})`);
      }
    }

    lines.push("");
    lines.push(`Policy: ${decision.policy_version || "latest"} | fail-on: ${decision.fail_on || "block"}`);
    lines.push("");
    lines.push(`<sub>[Full report](https://agentscores.xyz/policy-gate) | [AgentScore](https://agentscores.xyz)</sub>`);

    const body = lines.join("\n");

    // Check if we already commented on this PR (update instead of duplicate)
    const { data: comments } = await octokit.rest.issues.listComments({
      owner, repo, issue_number: prNumber,
    });
    const existing = comments.find((c) =>
      c.user?.login === "github-actions[bot]" && c.body?.includes("AgentScore Policy Gate")
    );

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner, repo, comment_id: existing.id, body,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body,
      });
    }

    core.info("PR comment posted.");
  } catch (err) {
    core.warning(`Could not post PR comment: ${err.message}`);
  }
}

async function runWithoutKey(apiUrl, packages, failOn) {
  const VERDICT_ORDER = ["allow", "warn", "block", "unknown"];
  const failThreshold = VERDICT_ORDER.indexOf(failOn);
  const results = [];
  let passed = true;

  for (const pkg of packages) {
    const url = `${apiUrl}/api/verdict?npm=${encodeURIComponent(pkg.name)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": USER_AGENT },
    });
    const verdict = res.ok ? await res.json() : { package: pkg.name, verdict: "unknown" };
    results.push(verdict);

    const icon = verdict.verdict === "allow" ? "\u2705" : verdict.verdict === "warn" ? "\u26A0\uFE0F" : "\u274C";
    core.info(`  ${icon} ${verdict.package || pkg.name}: ${verdict.verdict} (score: ${verdict.score ?? "?"}/100)`);

    if (VERDICT_ORDER.indexOf(verdict.verdict) >= failThreshold) {
      passed = false;
    }
  }

  core.setOutput("results", JSON.stringify(results));
  core.setOutput("passed", String(passed));

  if (!passed) {
    core.setFailed(`One or more packages failed (threshold: ${failOn}).`);
  } else {
    core.info("All packages passed.");
  }
}

run();
