import type { ChatEndpoint } from "../../packages/shared/src/types/chat-channels.js";
import { ConnectionFailure } from "./connection-config.js";
import type { GitHubReviewJourneyConfig } from "./github-review-config.js";
import type { ConnectionApi } from "./connection-target.js";

/** The issue run source includes history beyond company list windows. Related
 * activity can name a run for another task, so hydrate and check direct ownership. */
export async function readOwnedGitHubReviewRuns(api: Pick<ConnectionApi, "get">, scope: { companyId: string; agentId: string; issueId: string }) {
  const rows = await api.get<Array<{ runId: string }>>(`/api/issues/${scope.issueId}/runs`);
  if (!Array.isArray(rows) || rows.some(row => typeof row.runId !== "string" || !row.runId)) throw new ConnectionFailure("invalid_issue_run_inventory");
  const runs = await Promise.all([...new Set(rows.map(row => row.runId))].map(id => api.get<Record<string, any>>(`/api/heartbeat-runs/${id}`)));
  if (runs.some(run => run.companyId !== scope.companyId)) throw new ConnectionFailure("issue_run_company_mismatch");
  return runs.filter(run => run.issueId === scope.issueId && run.agentId === scope.agentId);
}

export interface GitHubJourneyResources {
  endpointId?: string; pullNumber?: number; branch: string; appName: string;
  appId?: string; appSlug?: string; appSettingsUrl?: string; installationSettingsUrl?: string;
  issueId?: string; runIds: string[];
}

/** Bind cleanup to GitHub-confirmed identity on this attempt's owned endpoint. */
export function captureOwnedGitHubApp(resources: GitHubJourneyResources, endpoint: ChatEndpoint, config: GitHubReviewJourneyConfig) {
  if (!endpoint.botExternalId || endpoint.setup.github?.registrationStatus !== "completed") return false;
  const app = endpoint.setup.github;
  if (endpoint.id !== resources.endpointId || endpoint.companyId !== config.target.companyId || endpoint.provider !== "github"
    || endpoint.assignedAgentId !== config.agent.id || endpoint.botLabel !== resources.appName
    || !/^[1-9][0-9]*$/.test(endpoint.botExternalId) || !app.appSlug || !/^[a-z0-9-]+$/.test(app.appSlug)
    || endpoint.botUsername !== `${app.appSlug}[bot]` || app.appOwnerType !== config.github.ownerType
    || app.appOwnerLogin?.toLowerCase() !== config.github.appOwner.toLowerCase()
    || (resources.appId && resources.appId !== endpoint.botExternalId)
    || (resources.appSlug && resources.appSlug !== app.appSlug)) throw new ConnectionFailure("owned_github_app_binding_mismatch");
  resources.appId = endpoint.botExternalId;
  resources.appSlug = app.appSlug;
  const owner = encodeURIComponent(app.appOwnerLogin!);
  resources.appSettingsUrl = app.appOwnerType === "organization"
    ? `https://github.com/organizations/${owner}/settings/apps/${app.appSlug}`
    : `https://github.com/settings/apps/${app.appSlug}`;
  // Installation management is a different resource. Uninstalling is not proof
  // that the owned App registration was deleted.
  resources.installationSettingsUrl = app.managementUrl;
  return true;
}
