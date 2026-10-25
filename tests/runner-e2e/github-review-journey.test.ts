import { describe, expect, it, vi } from "vitest";
import { parseJourneyCredentialBinding, resolveJourneyCredential } from "./journey-dependencies.js";
import { parseGitHubReviewJourneyConfig } from "./github-review-config.js";
import { githubJourneyCheckpoints, gradeGitHubReviewJourney, hasOnlyOpenedAutomaticReview, verifyGitHubReview, verifyGitHubReviewRun, type GitHubReviewJourneyEvidence } from "./github-review-evidence.js";
import { runnerMatrix } from "./catalog.js";
import { buildMatrixJobs, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import type { GitHubTaskReview } from "../../packages/shared/src/types/chat-github.js";
import { verifyConnectionTarget } from "./connection-target.js";
import { parseConnectionConfig } from "./connection-config.js";
import type { APIRequestContext } from "@playwright/test";
import { captureOwnedGitHubApp, readOwnedGitHubReviewRuns, type GitHubJourneyResources } from "./github-review-ownership.js";
import type { ChatEndpoint } from "../../packages/shared/src/types/chat-channels.js";
import { enterGitHubJourneyCompany, isGitHubJourneyEvidencePage } from "./github-review-browser.js";
import { attendGitHubJourneyAction } from "./github-review-attendance.js";
import { PassThrough } from "node:stream";
import type { Locator, Page } from "@playwright/test";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { runGitHubReviewCampaign } from "./github-review-launch.js";
import type { ConnectionApi } from "./connection-target.js";
import { runGitHubReviewFlow } from "./github-review-flow.js";

describe("reused target ownership", () => {
  it("admits an inherited environment before setup and still leaves actual-run verification mandatory", async () => {
    const setup = parseGitHubReviewJourneyConfig(config());
    const company = { id: setup.target.companyId, issuePrefix: "QA" };
    const rows: Record<string, unknown> = {
      "/api/instance/settings/experimental": { enableGitHubReviewBots: true },
      [`/api/companies/${company.id}`]: company,
      [`/api/agents/${setup.agent.id}`]: { companyId: company.id, name: setup.agent.name, status: "idle", defaultEnvironmentId: null, adapterConfig: { model: setup.agent.model } },
      [`/api/environments/${setup.target.environmentId}`]: { id: setup.target.environmentId, driver: "local", status: "active", config: {} },
      [`/api/companies/${company.id}/budgets/overview`]: { policies: [] },
    };
    const api = { origin: setup.target.baseURL, get: async (route: string) => rows[route] };
    const page = { goto: async () => {}, waitForURL: async () => {} };
    await expect(runGitHubReviewFlow({ api: api as unknown as ConnectionApi, page: page as unknown as Page, github: {} as Page,
      githubUsername: "fixture", config: setup, resources: { branch: "owned", appName: "owned", runIds: [] },
      evidence: { version: 1, setupId: "qa", hosting: "paperclip-cloud", targetCommit: null, assisted: false, outcome: "running", phase: "setup", dependencies: [], checkpoints: {}, cleanup: { endpoint: true, app: true, pullRequest: true, branch: true } },
      signal: new AbortController().signal, phase: async () => {}, persistResources: async () => {},
      checkpoint: async id => { if (id === "agent") throw new Error("preflight_admitted"); },
    })).rejects.toThrow("preflight_admitted");
  });
  it("enters the configured company before using its navigation despite remembered browser state", async () => {
    let current = new URL("https://qa.example.test/OTHER/dashboard");
    const page = { goto: vi.fn(async (url: string) => { current = new URL(url); }),
      waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => { expect(predicate(current)).toBe(true); }) };
    await enterGitHubJourneyCompany(page as unknown as Page, current.origin, { issuePrefix: "QA" });
    expect(current.pathname).toBe("/QA/dashboard");
  });
  it("finds the owned run outside company history windows and excludes related foreign-task activity", async () => {
    const get = vi.fn(async (route: string) => {
      if (route === "/api/issues/issue/runs") return [{ runId: "old-owned" }, { runId: "related" }, { runId: "old-owned" }];
      if (route === "/api/heartbeat-runs/old-owned") return { id: "old-owned", companyId: "company", agentId: "agent", issueId: "issue" };
      if (route === "/api/heartbeat-runs/related") return { id: "related", companyId: "company", agentId: "agent", issueId: "other-issue" };
      throw new Error("company_history_must_not_be_used");
    });
    const runs = await readOwnedGitHubReviewRuns({ get } as unknown as Pick<ConnectionApi, "get">, { companyId: "company", agentId: "agent", issueId: "issue" });
    expect(runs.map(run => run.id)).toEqual(["old-owned"]);
    expect(get).toHaveBeenCalledTimes(3);
  });
  it("rejects a foreign company in hydrated run inventory", async () => {
    const get = vi.fn(async (route: string) => route.endsWith("/runs") ? [{ runId: "foreign" }] : { id: "foreign", companyId: "other", agentId: "agent", issueId: "issue" });
    await expect(readOwnedGitHubReviewRuns({ get } as unknown as Pick<ConnectionApi, "get">, { companyId: "company", agentId: "agent", issueId: "issue" })).rejects.toThrow("issue_run_company_mismatch");
  });
});

describe("governed campaign admission", () => {
  it("rejects operations-managed selection before opening credentials or browsers", async () => {
    const execution = runnerMatrix.find(entry => entry.id === "github-review-journey.configured-agent.daytona.setup-and-first-review")!;
    vi.stubEnv("PAPERCLIP_E2E_OPERATIONS_MANIFEST", "/private/campaign.json");
    try {
      await expect(runGitHubReviewCampaign({ executions: [execution], catalog: runnerMatrix, repositoryRoot: "/does-not-exist" }))
        .rejects.toThrow("no budgeted routing qualification");
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("automatic review event policy", () => {
  it("accepts opened-only automation while ordinary mentions and comment replies remain available", () => {
    expect(hasOnlyOpenedAutomaticReview({ events: ["opened", "mention", "comment"], issueOpened: false })).toBe(true);
  });
  it("rejects missing opened events, other automatic triggers, and issue intake", () => {
    for (const events of [["mention", "comment"], ["opened", "synchronize"], ["opened", "reopened"], ["opened", "ready_for_review"]] as const) {
      expect(hasOnlyOpenedAutomaticReview({ events: [...events] })).toBe(false);
    }
    expect(hasOnlyOpenedAutomaticReview({ events: ["opened"], issueOpened: true })).toBe(false);
  });
});

describe("retained journey metadata", () => {
  it("accepts actual budget/execution fields while rejecting unrelated private metadata", () => {
    const evidence: GitHubReviewJourneyEvidence = { version: 1, outcome: "failed", phase: "review_execution_completion", setupId: "qa", hosting: "paperclip-cloud", targetCommit: "a".repeat(40), assisted: true,
      dependencies: [], checkpoints: { automatic_task: true }, cleanup: { endpoint: true, app: true, branch: true, pullRequest: true }, budgetPolicyRead: "verified",
      budgetPolicies: [{ scopeType: "agent", amount: 100, hardStopEnabled: true, unpricedUsagePolicy: "allow" }],
      execution: { reviewId: "review", issueId: "issue", runId: "run", runStatus: "failed", issueStatus: "in_progress", runtimeMode: "native", environmentId: "sandbox", provider: "opencode", model: "configured-model" } };
    const result = { schema: "paperclip.runner-e2e.result/v2", executionId: "github-review-journey.configured-agent.local.setup-and-first-review", suiteId: "github-review-journey", suiteDefinitionHash: "definition",
      attempt: 1, status: "failed", profileId: "configured-agent", environmentId: "local", caseId: "setup-and-first-review", provider: "opencode", model: "configured-model", runtimeMode: "native",
      startedAt: "2026-10-24T00:00:00Z", finishedAt: "2026-10-24T00:01:00Z", durationMs: 60000, cleanup: "passed", githubReviewJourney: evidence };
    expect(() => validateRetainedRunnerResult(result)).not.toThrow();
    expect(() => validateRetainedRunnerResult({ ...result, githubReviewJourney: { ...evidence, execution: { ...evidence.execution, credential: "not-allowed" } } })).toThrow(/execution/);
    expect(() => validateRetainedRunnerResult({ ...result, githubReviewJourney: { ...evidence, budgetPolicies: [{ ...evidence.budgetPolicies![0], credential: "not-allowed" }] } })).toThrow(/budgetPolicies/);
  });
});

describe("review execution attribution", () => {
  const expected = { runId: "run", companyId: "company", agentId: "agent", issueId: "issue", runtimeMode: "native", environmentId: "sandbox", executionEnvironment: "daytona" as const,
    environment: { id: "sandbox", driver: "sandbox", config: { provider: "daytona" } }, provider: "opencode", model: "configured-model" };
  const run = () => ({ id: "run", companyId: "company", agentId: "agent", issueId: "issue", status: "succeeded", runtimeMode: "native",
    contextSnapshot: { paperclipEnvironment: { id: "sandbox", driver: "sandbox" } }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "configured-model" } } } });
  it("rejects a mismatched environment kind or provider even when the ID matches", () => {
    expect(verifyGitHubReviewRun(run(), { ...expected, executionEnvironment: "local" })).toBe(false);
    expect(verifyGitHubReviewRun(run(), { ...expected, environment: { ...expected.environment, config: { provider: "fake" } } })).toBe(false);
    expect(verifyGitHubReviewRun({ ...run(), contextSnapshot: { paperclipEnvironment: { id: "sandbox", driver: "local" } } }, expected)).toBe(false);
    const local = { ...run(), contextSnapshot: { paperclipEnvironment: { id: "local", driver: "local" } } };
    expect(verifyGitHubReviewRun(local, { ...expected, executionEnvironment: "local", environmentId: "local", environment: { id: "local", driver: "local", config: {} } })).toBe(true);
  });
  it("requires the actual successful native run, environment, provider, and model", () => {
    expect(verifyGitHubReviewRun(run(), expected)).toBe(true);
    expect(verifyGitHubReviewRun(undefined, expected)).toBe(false);
    expect(verifyGitHubReviewRun({ ...run(), runnerProfileJson: {} }, expected)).toBe(false);
    expect(verifyGitHubReviewRun(run(), { ...expected, model: "another-model" })).toBe(false);
    expect(verifyGitHubReviewRun(run(), { ...expected, environmentId: "another-sandbox" })).toBe(false);
  });
  it.each(["queued", "running", "failed", "cancelled"])("does not accept a %s run merely because a review record completed", status => {
    expect(verifyGitHubReviewRun({ ...run(), status }, expected)).toBe(false);
  });
  it.each(["runId", "companyId", "agentId", "issueId"] as const)("rejects foreign %s attribution", key => {
    expect(verifyGitHubReviewRun(run(), { ...expected, [key]: "foreign" })).toBe(false);
  });
});

describe("attended terminal control", () => {
  it("ignores another App/action, accepts the current action once, and does not retain consent", async () => {
    const terminal = Object.assign(new PassThrough(), { isTTY: true });
    const control = { isVisible: vi.fn(async () => true), click: vi.fn(async () => {}) };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const first = attendGitHubJourneyAction({ control: control as unknown as Locator, action: "create-app", appName: "Ponytail QA one", signal: new AbortController().signal, timeoutMs: 5_000 }, terminal);
      terminal.write("create-app Ponytail QA another\ninstall-app Ponytail QA one\n");
      await vi.advanceTimersByTimeAsync(500);
      expect(control.click).not.toHaveBeenCalled();
      terminal.write("create-app Ponytail QA one\n");
      await vi.advanceTimersByTimeAsync(500);
      await first;
      expect(control.click).toHaveBeenCalledTimes(1);
      const abort = new AbortController();
      const second = attendGitHubJourneyAction({ control: control as unknown as Locator, action: "install-app", appName: "Ponytail QA one", signal: abort.signal, timeoutMs: 5_000 }, terminal);
      const stopped = expect(second).rejects.toThrow("journey_interrupted");
      abort.abort();
      await vi.advanceTimersByTimeAsync(500);
      await stopped;
      expect(control.click).toHaveBeenCalledTimes(1);
    } finally { terminal.destroy(); vi.useRealTimers(); log.mockRestore(); }
  });
  it("never treats piped input as attended confirmation", async () => {
    const terminal = Object.assign(new PassThrough(), { isTTY: false });
    const control = { isVisible: vi.fn(async () => true), click: vi.fn(async () => {}) };
    const abort = new AbortController();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const pending = attendGitHubJourneyAction({ control: control as unknown as Locator, action: "create-app", appName: "Ponytail QA one", signal: abort.signal, timeoutMs: 5_000 }, terminal);
      const stopped = expect(pending).rejects.toThrow("journey_interrupted");
      terminal.write("create-app Ponytail QA one\n");
      abort.abort();
      await vi.advanceTimersByTimeAsync(500);
      await stopped;
      expect(control.click).not.toHaveBeenCalled();
    } finally { terminal.destroy(); vi.useRealTimers(); log.mockRestore(); }
  });
});

describe("journey screenshot boundaries", () => {
  it("captures owned PR, check and installation pages while excluding auth and foreign resources", () => {
    const capture = (url: string) => isGitHubJourneyEvidencePage(url, "https://qa.example.test", "fixture/repo", "owned-app");
    for (const url of ["https://qa.example.test/QA/issues/QA-1", "https://github.com/fixture/repo/pull/7", "https://github.com/fixture/repo/runs/123", "https://github.com/apps/owned-app/installations/new"]) expect(capture(url)).toBe(true);
    for (const url of ["https://qa.example.test/QA/apps/connect", "https://qa.example.test/callback?code=secret", "https://github.com/login", "https://github.com/apps/shared-app/installations/new", "https://github.com/foreign/repo/pull/7", "https://github.com/fixture/repo/settings/secrets"]) expect(capture(url)).toBe(false);
  });
});

describe("durable journey credential references", () => {
  it("resolves one selected field through a service-account-only child environment", async () => {
    const secret = vi.fn();
    const read = vi.fn(async () => "resolved-value");
    expect(await resolveJourneyCredential({ source: "onepassword", reference: "op://vault/item/username" }, { env: { PATH: "/bin", OP_SERVICE_ACCOUNT_TOKEN: "service-account", GITHUB_TOKEN: "unrelated", OP_SESSION_user: "personal-session", OPENAI_API_KEY: "foreign-provider" }, read, registerSecret: secret })).toBe("resolved-value");
    expect(read).toHaveBeenCalledWith("op://vault/item/username", { PATH: "/bin", OP_SERVICE_ACCOUNT_TOKEN: "service-account" }, undefined);
    expect(secret.mock.calls.flat()).toEqual(["service-account", "resolved-value"]);
  });
  it("does not fall back to a personal desktop login or another environment credential", async () => {
    const read = vi.fn();
    await expect(resolveJourneyCredential({ source: "onepassword", reference: "op://vault/item/password" }, { env: { OP_SESSION_user: "personal" }, read, registerSecret: vi.fn() })).rejects.toThrow("service_account_unavailable");
    expect(read).not.toHaveBeenCalled();
  });
  it.each([{ source: "onepassword", reference: "op://vault/item/password", value: "raw-password" }, { source: "onepassword", reference: "$(cat secrets)" }, { source: "environment", variable: "OP_SERVICE_ACCOUNT_TOKEN" }])("rejects malformed or literal bindings", binding => {
    expect(() => parseJourneyCredentialBinding(binding)).toThrow("invalid_dependency_binding");
  });
  it("retains only a closed failure code when op fails with sensitive stderr", async () => {
    await expect(resolveJourneyCredential({ source: "onepassword", reference: "op://vault/item/password" }, { env: { OP_SERVICE_ACCOUNT_TOKEN: "secret" }, read: async () => { throw new Error("private token and item path"); }, registerSecret: vi.fn() })).rejects.toThrow(/^credential_unavailable$/);
  });
});

const config = () => ({ version: 1, setupId: "qa-test", hosting: "paperclip-cloud", target: { mode: "attach", baseURL: "https://qa.example.test", expectedCommit: "a".repeat(40), deploymentMode: "authenticated", companyId: "11111111-1111-4111-8111-111111111111", environmentId: "22222222-2222-4222-8222-222222222222" },
  browser: { headed: true, channel: "chrome", profileDir: "/private/qa-browser", accountAlias: "ralph-qa", freshness: "signed-in" },
  agent: { id: "22222222-2222-4222-8222-222222222222", name: "Ponytail QA", skill: "ponytail-review", model: "configured-model", provider: "openai", runtimeMode: "native" },
  github: { repository: "fixture/ponytail-evals", ownerType: "personal", appOwner: "fixture", login: "passkey", username: { source: "onepassword", reference: "op://vault/item/username" } } });

describe("setup profiles and selection", () => {
  it("requires an actual environment binding for every selected cell", () => {
    const value = config();
    const { environmentId: _environmentId, ...target } = value.target;
    expect(() => parseGitHubReviewJourneyConfig({ ...value, target })).toThrow("invalid_github_journey_configuration");
  });
  it("verifies a protected hosted target through the authenticated session without following redirects", async () => {
    const get = vi.fn(async () => ({ ok: () => true, json: async () => ({ commit: "a".repeat(40), deploymentMode: "authenticated" }) }));
    await expect(verifyConnectionTarget("https://qa.example.test", parseConnectionConfig({ target: config().target }), { get } as unknown as APIRequestContext)).resolves.toMatchObject({ commit: "a".repeat(40) });
    expect(get).toHaveBeenCalledWith("https://qa.example.test/api/health", { maxRedirects: 0, timeout: 15_000 });
    get.mockResolvedValueOnce({ ok: () => false, json: async () => ({}) } as any);
    await expect(verifyConnectionTarget("https://qa.example.test", parseConnectionConfig({ target: config().target }), { get } as unknown as APIRequestContext)).rejects.toThrow("target_health_unavailable_or_redirected");
  });
  it("keeps Cloud hosting separate from agent execution and declares passkey without requiring an exported password", () => {
    expect(parseGitHubReviewJourneyConfig(config())).toMatchObject({ hosting: "paperclip-cloud", github: { login: "passkey" } });
    expect(parseGitHubReviewJourneyConfig({ ...config(), hosting: "self-hosted" }).hosting).toBe("self-hosted");
    expect(parseGitHubReviewJourneyConfig({ ...config(), executionEnvironment: "daytona" }).executionEnvironment).toBe("daytona");
    expect(parseGitHubReviewJourneyConfig(config()).github.account).toBe("fixture");
    expect(() => parseGitHubReviewJourneyConfig({ ...config(), github: { ...config().github, ownerType: "organization" } })).toThrow("invalid_github_journey_configuration");
    expect(() => parseGitHubReviewJourneyConfig({ ...config(), github: { ...config().github, password: "literal" } })).toThrow("invalid_github_journey_configuration");
  });
  it("discovers the exact journey and excludes it from all and CI paid matrices", () => {
    const cells = runnerMatrix.filter(c => c.suite.id === "github-review-journey");
    expect(cells).toHaveLength(2);
    const options = parseRunnerSelectors(["--suite", "github-review-journey", "--environment", "local", "--github-review-config", "/private/profile.json"]);
    expect(selectRunnerExecutions(options).map(c => c.id)).toEqual(cells.filter(c => c.environment.id === "local").map(c => c.id));
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(c => c.suite.id === "github-review-journey")).toBe(false);
    expect(() => buildMatrixJobs(cells)).toThrow(/Attended connection journeys/);
    expect(cells[0]!.requiredCredentials).toEqual([]);
  });
});

describe("GitHub App cleanup ownership", () => {
  const fixture = () => {
    const profile = parseGitHubReviewJourneyConfig(config());
    const resources: GitHubJourneyResources = { endpointId: "endpoint", appName: "Ponytail QA nonce", branch: "owned", runIds: [] };
    const endpoint = { id: "endpoint", companyId: profile.target.companyId, provider: "github", assignedAgentId: profile.agent.id,
      botExternalId: "12345", botUsername: "ponytail-qa-nonce[bot]", botLabel: resources.appName,
      setup: { step: "provider_setup", github: { registrationStatus: "completed", appOwnerType: "personal", appOwnerLogin: "fixture", appSlug: "ponytail-qa-nonce", managementUrl: "https://github.com/settings/installations/67890" } } } as ChatEndpoint;
    return { profile, resources, endpoint };
  };
  it("records the verified App registration separately from its installation", () => {
    const f = fixture();
    expect(captureOwnedGitHubApp(f.resources, f.endpoint, f.profile)).toBe(true);
    expect(f.resources).toMatchObject({ appId: "12345", appSlug: "ponytail-qa-nonce", appSettingsUrl: "https://github.com/settings/apps/ponytail-qa-nonce", installationSettingsUrl: "https://github.com/settings/installations/67890" });
  });
  it("cannot adopt the shared testing App, a foreign endpoint, or a renamed App", () => {
    for (const mutate of [(e: ChatEndpoint) => { e.setup.github!.appOwnerLogin = "paperclipai"; }, (e: ChatEndpoint) => { e.id = "foreign"; },
      (e: ChatEndpoint) => { e.botLabel = "[Test] Paperclip"; }, (e: ChatEndpoint) => { e.botUsername = "foreign[bot]"; }]) {
      const f = fixture(); mutate(f.endpoint);
      expect(() => captureOwnedGitHubApp(f.resources, f.endpoint, f.profile)).toThrow("owned_github_app_binding_mismatch");
      expect(f.resources.appSettingsUrl).toBeUndefined();
    }
  });
  it("rejects replacement of an already recorded immutable App ID", () => {
    const f = fixture(); captureOwnedGitHubApp(f.resources, f.endpoint, f.profile); f.endpoint.botExternalId = "99999";
    expect(() => captureOwnedGitHubApp(f.resources, f.endpoint, f.profile)).toThrow("owned_github_app_binding_mismatch");
    expect(f.resources.appId).toBe("12345");
  });
  it("does not invent a cleanup URL while registration is incomplete", () => {
    const f = fixture(); f.endpoint.setup.github!.registrationStatus = "pending";
    expect(captureOwnedGitHubApp(f.resources, f.endpoint, f.profile)).toBe(false);
    expect(f.resources.appSettingsUrl).toBeUndefined();
  });
});

const head = "d".repeat(40);
function oracleInput() {
  const review = { id: "review", companyId: "company", endpointId: "endpoint", issueId: "issue", runId: "run", repositoryId: "repo", repository: "fixture/repo", pullNumber: 7, headSha: head,
    event: { event: "opened", headSha: head, repository: "fixture/repo" }, state: "completed", conclusion: "failure", summaryUrl: "https://github.com/fixture/repo/pull/7#issuecomment-1", checkUrl: "https://github.com/fixture/repo/runs/1",
    assessment: { complete: true, reviewedCommit: head, score: 3, summary: "Decimal prices lose precision.", rationale: "Reproduced currency error", coverage: { reviewedPaths: ["cart-total.js"], omittedPaths: [], limitations: [] }, findings: [{ path: "cart-total.js", side: "RIGHT", line: 5, body: "Decimal price precision fails", severity: "warning", category: "correctness" }] } } as unknown as GitHubTaskReview;
  return { review, companyId: "company", endpointId: "endpoint", issueId: "issue", repository: "fixture/repo", pullNumber: 7, headSha: head, agentId: "agent", issue: { id: "issue", companyId: "company", assigneeAgentId: "agent", status: "done" } };
}

describe("independent GitHub review oracle", () => {
  it("accepts a useful 3/5 review with a correctly failed check", () => expect(verifyGitHubReview(oracleInput())).toBe(true));
  it.each(["headSha", "repository", "issueId", "endpointId", "companyId"] as const)("rejects a stale or foreign %s", key => {
    const input = oracleInput(); input.review[key] = "foreign";
    expect(verifyGitHubReview(input)).toBe(false);
  });
  it("rejects manual triggering, false completion, missing delivery and a 5/5 score for the known defect", () => {
    for (const mutate of [(r: GitHubTaskReview) => { r.event.event = "mention"; }, (r: GitHubTaskReview) => { r.assessment!.complete = false; },
      (r: GitHubTaskReview) => { r.summaryUrl = null; }, (r: GitHubTaskReview) => { r.assessment!.score = 5; }, (r: GitHubTaskReview) => { r.assessment!.findings = []; }]) {
      const input = oracleInput(); mutate(input.review); expect(verifyGitHubReview(input)).toBe(false);
    }
  });
  it("rejects foreign delivery links even when the task and assessment match", () => {
    for (const [field, value] of [["summaryUrl", "https://github.com/fixture/repo/pull/8#issuecomment-1"], ["summaryUrl", "https://github.com/foreign/repo/pull/7#issuecomment-1"],
      ["checkUrl", "https://example.test/fixture/repo/runs/1"], ["checkUrl", "https://github.com/foreign/repo/runs/1"]] as const) {
      const input = oracleInput(); input.review[field] = value;
      expect(verifyGitHubReview(input)).toBe(false);
    }
  });
  it("fails missing checkpoint or cleanup evidence even when every other gate passed", () => {
    const evidence: GitHubReviewJourneyEvidence = { version: 1, outcome: "passed", phase: "finished", hosting: "paperclip-cloud", setupId: "qa", targetCommit: head, assisted: true, dependencies: [],
      checkpoints: Object.fromEntries(githubJourneyCheckpoints.map(id => [id, true])), cleanup: { endpoint: true, app: true, pullRequest: true, branch: true } };
    expect(gradeGitHubReviewJourney(evidence).every(c => c.passed)).toBe(true);
    delete evidence.checkpoints.github_delivery;
    expect(gradeGitHubReviewJourney(evidence).every(c => c.passed)).toBe(false);
    evidence.checkpoints.github_delivery = true; evidence.cleanup.app = false;
    expect(gradeGitHubReviewJourney(evidence).every(c => c.passed)).toBe(false);
  });
});
