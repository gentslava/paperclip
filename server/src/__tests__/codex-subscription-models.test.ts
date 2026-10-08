import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  credential: vi.fn(),
  refresh: vi.fn(),
  catalog: vi.fn(),
  version: vi.fn(),
}));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({
    quotaAccounts: mocks.accounts,
    credential: mocks.credential,
    refreshQuotaCredential: mocks.refresh,
  }),
}));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  fetchCodexModelCatalog: mocks.catalog,
  readCodexCommandVersion: mocks.version,
}));
import {
  listCodexSubscriptionModels,
  resetCodexSubscriptionModelsCacheForTests,
} from "../services/codex-subscription-models.js";

const db = {} as Db;
const account = (id: string, provider = "openai", status = "connected") => ({
  connection: { id, updatedAt: new Date(0) },
  grant: { id, updatedAt: new Date(0), credentialSecretRefs: [{ secretId: `secret-${id}` }] },
  summary: { provider, name: id, status },
});
const subscription = (accessToken: string) =>
  JSON.stringify({ tokens: { access_token: accessToken, account_id: "account" } });

describe("Codex subscription model catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCodexSubscriptionModelsCacheForTests();
    mocks.version.mockResolvedValue("0.161.0");
    mocks.credential.mockResolvedValue(subscription("access"));
    mocks.catalog.mockResolvedValue([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]);
  });

  it("lists the connected subscription's catalog at the installed Codex version", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    await expect(listCodexSubscriptionModels(db, "company", "user"))
      .resolves.toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]);
    expect(mocks.catalog).toHaveBeenCalledWith({ accessToken: "access", accountId: "account", clientVersion: "0.161.0" });
    expect(mocks.version).toHaveBeenCalledWith(expect.objectContaining({ command: "codex", target: null }));
  });

  it("keeps the static list without a connected ChatGPT subscription or a known CLI version", async () => {
    mocks.accounts.mockResolvedValue([account("claude", "anthropic"), account("stale", "openai", "reconnect_required")]);
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toEqual([]);
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.version.mockResolvedValue(null);
    await expect(listCodexSubscriptionModels(db, "company", "user", { refresh: true })).resolves.toEqual([]);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });

  it("refreshes an expired token once, then retries", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.catalog.mockRejectedValueOnce(new Error("chatgpt codex models api returned 401"));
    mocks.refresh.mockResolvedValue(subscription("fresh"));
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toHaveLength(1);
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ grant: expect.objectContaining({ id: "chatgpt" }) }), subscription("access"), expect.any(AbortSignal));
    expect(mocks.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: "fresh" }));
  });

  it("falls back quietly when the backend fails, and does not cache the failure", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    mocks.catalog.mockRejectedValueOnce(new Error("chatgpt codex models api returned 503"));
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toEqual([]);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toHaveLength(1);
  });

  it("caches per account and skips the cache on Refresh", async () => {
    mocks.accounts.mockResolvedValue([account("chatgpt")]);
    await listCodexSubscriptionModels(db, "company", "user");
    await listCodexSubscriptionModels(db, "company", "user");
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
    await listCodexSubscriptionModels(db, "company", "user", { refresh: true });
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
  });

  it("merges several subscriptions without duplicates", async () => {
    mocks.accounts.mockResolvedValue([account("plus"), account("pro")]);
    mocks.catalog
      .mockResolvedValueOnce([{ id: "gpt-6-sol", label: "GPT-6-Sol" }])
      .mockResolvedValueOnce([{ id: "gpt-6-sol", label: "GPT-6-Sol" }, { id: "gpt-6-astra", label: "GPT-6-Astra" }]);
    await expect(listCodexSubscriptionModels(db, "company", "user")).resolves.toEqual([
      { id: "gpt-6-sol", label: "GPT-6-Sol" },
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
    ]);
  });
});
