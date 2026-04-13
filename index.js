const core = require("@actions/core");
const fs = require("fs");
const path = require("path");

const USER_AGENT = "AgentScore-GitHubAction/2.1";

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

function findMcpDependencies() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    core.warning("No package.json found in workspace root.");
    return [];
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const lockfile = readJsonIfExists(path.join(process.cwd(), "package-lock.json"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const mcpPatterns = [/mcp/i, /@modelcontextprotocol/i, /model-context-protocol/i];

  return Object.entries(allDeps)
    .filter(([name]) => mcpPatterns.some((pattern) => pattern.test(name)))
    .map(([name, requestedVersion]) => ({
      name,
      requested_version: requestedVersion,
      version: resolveLockedVersion(lockfile, name) || normalizeRequestedVersion(requestedVersion),
    }));
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
    }

    if (decision.exceptions_applied?.length > 0) {
      core.info("");
      core.info("Exceptions applied:");
      for (const exception of decision.exceptions_applied) {
        core.info(`  ${exception.package}: ${exception.original_verdict} -> ${exception.effective_verdict} (${exception.reason || "no reason"})`);
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
  }

  if (decision.exceptions_applied?.length > 0) {
    core.info("");
    core.info("Exceptions applied:");
    for (const exception of decision.exceptions_applied) {
      core.info(`  ${exception.package}: ${exception.original_verdict} -> ${exception.effective_verdict} (${exception.reason || "no reason"})`);
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

  if (!decision.passed) {
    core.setFailed("One or more MCP packages failed the policy check.");
  } else {
    core.info("All MCP packages passed the policy check.");
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
