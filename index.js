const core = require("@actions/core");
const fs = require("fs");
const path = require("path");

const USER_AGENT = "AgentScore-GitHubAction/2.0";

function findMcpDependencies() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    core.warning("No package.json found in workspace root.");
    return [];
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const mcpPatterns = [/mcp/i, /@modelcontextprotocol/i, /model-context-protocol/i];

  return Object.entries(allDeps)
    .filter(([name]) => mcpPatterns.some((p) => p.test(name)))
    .map(([name, version]) => ({ name, version: version.replace(/^[\^~>=<]/, "") }));
}

async function run() {
  try {
    const apiUrl = core.getInput("api-url");
    const apiKey = core.getInput("api-key");
    const failOpen = core.getInput("fail-open") === "true";
    const packagesInput = core.getInput("packages");

    let packages;
    if (packagesInput) {
      packages = packagesInput.split(",").map((p) => ({ name: p.trim(), version: null })).filter((p) => p.name);
    } else {
      packages = findMcpDependencies();
    }

    if (packages.length === 0) {
      core.info("No MCP packages found to check.");
      core.setOutput("results", "[]");
      core.setOutput("passed", "true");
      return;
    }

    core.info(`Checking ${packages.length} MCP package(s): ${packages.map((p) => p.name).join(", ")}`);

    // If no API key, fall back to individual verdict calls (no repo memory)
    if (!apiKey) {
      core.info("No api-key provided. Running without repo inventory tracking.");
      await runWithoutKey(apiUrl, packages);
      return;
    }

    // Central policy check: send packages, get authoritative decision
    const repo = process.env.GITHUB_REPOSITORY || "";
    const commit = process.env.GITHUB_SHA || "";
    const branch = process.env.GITHUB_REF_NAME || "";
    const pr = process.env.GITHUB_EVENT_NAME === "pull_request"
      ? parseInt(process.env.GITHUB_REF?.match(/\d+/)?.[0] || "0", 10) || null
      : null;

    const checkRes = await fetch(`${apiUrl}/api/repo/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-AgentScore-Key": apiKey,
      },
      body: JSON.stringify({ repo, commit, branch, pr, packages, fail_open: failOpen }),
      signal: AbortSignal.timeout(30000),
    });

    if (!checkRes.ok) {
      if (failOpen) {
        core.warning(`Policy check failed (HTTP ${checkRes.status}). Fail-open: passing.`);
        core.setOutput("results", "[]");
        core.setOutput("passed", "true");
        return;
      }
      core.setFailed(`Policy check failed (HTTP ${checkRes.status}).`);
      return;
    }

    const decision = await checkRes.json();

    // Display results
    for (const r of decision.results) {
      const icon = r.effective_verdict === "allow" ? "\u2705" : r.effective_verdict === "warn" ? "\u26A0\uFE0F" : "\u274C";
      let line = `  ${icon} ${r.name}: ${r.effective_verdict} (score: ${r.score ?? "?"}/100)`;
      if (r.verdict !== r.effective_verdict) {
        line += ` [exception: ${r.verdict} -> ${r.effective_verdict}]`;
      }
      core.info(line);
    }

    if (decision.exceptions_applied?.length > 0) {
      core.info("");
      core.info("Exceptions applied:");
      for (const ex of decision.exceptions_applied) {
        core.info(`  ${ex.package}: ${ex.original_verdict} -> allow (${ex.reason || "no reason"})`);
      }
    }

    core.info("");
    const allow = decision.results.filter((r) => r.effective_verdict === "allow").length;
    const warn = decision.results.filter((r) => r.effective_verdict === "warn").length;
    const block = decision.results.filter((r) => r.effective_verdict === "block").length;
    core.info(`Results: ${allow} allow, ${warn} warn, ${block} block | Policy: ${decision.policy_version}`);
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

// Fallback: no API key, just check verdicts individually (no repo memory)
async function runWithoutKey(apiUrl, packages) {
  const VERDICT_ORDER = ["allow", "warn", "block", "unknown"];
  const failOn = core.getInput("fail-on") || "block";
  const failThreshold = VERDICT_ORDER.indexOf(failOn);
  const results = [];
  let passed = true;

  for (const pkg of packages) {
    const url = `${apiUrl}/api/verdict?npm=${encodeURIComponent(pkg.name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": USER_AGENT } });
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
