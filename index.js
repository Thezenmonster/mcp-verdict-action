const core = require("@actions/core");
const fs = require("fs");
const path = require("path");

const VERDICT_ORDER = ["allow", "warn", "block", "unknown"];
const USER_AGENT = "AgentScore-GitHubAction/1.0";

async function getVerdict(apiUrl, pkg) {
  const url = `${apiUrl}/api/verdict?npm=${encodeURIComponent(pkg)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    return { package: pkg, verdict: "unknown", error: `HTTP ${res.status}` };
  }
  return res.json();
}

function findMcpDependencies() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    core.warning("No package.json found in workspace root.");
    return [];
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  const mcpPatterns = [
    /mcp/i,
    /@modelcontextprotocol/i,
    /model-context-protocol/i,
  ];

  return Object.keys(allDeps).filter((name) =>
    mcpPatterns.some((pattern) => pattern.test(name))
  );
}

async function run() {
  try {
    const apiUrl = core.getInput("api-url");
    const failOn = core.getInput("fail-on");
    const apiKey = core.getInput("api-key");
    const packagesInput = core.getInput("packages");

    let packages;
    if (packagesInput) {
      packages = packagesInput.split(",").map((p) => p.trim()).filter(Boolean);
    } else {
      packages = findMcpDependencies();
    }

    if (packages.length === 0) {
      core.info("No MCP packages found to check.");
      core.setOutput("results", "[]");
      core.setOutput("passed", "true");
      return;
    }

    core.info(`Checking ${packages.length} MCP package(s): ${packages.join(", ")}`);

    const failThreshold = VERDICT_ORDER.indexOf(failOn);
    const results = [];
    let passed = true;

    for (const pkg of packages) {
      core.info(`  Checking ${pkg}...`);
      const verdict = await getVerdict(apiUrl, pkg);
      results.push(verdict);

      const verdictLevel = VERDICT_ORDER.indexOf(verdict.verdict);
      const icon = verdict.verdict === "allow" ? "\u2705" : verdict.verdict === "warn" ? "\u26A0\uFE0F" : "\u274C";

      core.info(`  ${icon} ${pkg}: ${verdict.verdict} (score: ${verdict.score || "?"}/100, risk: ${verdict.risk || "?"})`);

      if (verdict.posture) {
        const prov = verdict.posture.provenance ? "yes" : "no";
        const trusted = verdict.posture.trusted_publishing ? "yes" : "no";
        core.info(`     Provenance: ${prov}, Trusted publishing: ${trusted}`);
      }

      if (verdict.reasons && verdict.reasons.length > 0) {
        core.info(`     Reasons: ${verdict.reasons.join(", ")}`);
      }

      if (verdictLevel >= failThreshold) {
        passed = false;
        core.error(`${pkg} returned verdict "${verdict.verdict}" which meets or exceeds fail threshold "${failOn}"`);
      }
    }

    core.setOutput("results", JSON.stringify(results));
    core.setOutput("passed", String(passed));

    core.info("");
    core.info(`Results: ${results.filter((r) => r.verdict === "allow").length} allow, ${results.filter((r) => r.verdict === "warn").length} warn, ${results.filter((r) => r.verdict === "block").length} block`);

    // Report results back to AgentScore for repo inventory tracking
    try {
      const repo = process.env.GITHUB_REPOSITORY || "";
      const commit = process.env.GITHUB_SHA || "";
      const branch = process.env.GITHUB_REF_NAME || "";
      const pr = process.env.GITHUB_EVENT_NAME === "pull_request"
        ? parseInt(process.env.GITHUB_REF?.match(/\d+/)?.[0] || "0", 10)
        : null;
      const workflowUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ""}`;

      const reportPayload = {
        repo,
        commit,
        branch,
        pr,
        workflow_url: workflowUrl,
        packages: results.map((r) => ({
          name: r.package,
          verdict: r.verdict,
          score: r.score,
          risk: r.risk,
          reasons: r.reasons || [],
        })),
        passed,
      };

      const reportHeaders = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      };
      if (apiKey) {
        reportHeaders["X-AgentScore-Key"] = apiKey;
      }

      const reportRes = await fetch(`${apiUrl}/api/repo/report`, {
        method: "POST",
        headers: reportHeaders,
        body: JSON.stringify(reportPayload),
        signal: AbortSignal.timeout(10000),
      });

      if (reportRes.ok) {
        core.info("Repo inventory updated at AgentScore.");
      } else {
        core.info(`Repo inventory not stored (HTTP ${reportRes.status}). Add api-key input to enable tracking.`);
      }
    } catch {
      // Best effort. Don't fail the check because of reporting.
      core.info("Could not report to AgentScore (non-blocking).");
    }

    if (!passed) {
      core.setFailed(`One or more MCP packages failed the verdict check (threshold: ${failOn}).`);
    } else {
      core.info("All MCP packages passed the verdict check.");
    }
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
