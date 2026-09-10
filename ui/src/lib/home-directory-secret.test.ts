// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../api/secrets", () => ({ secretsApi: secrets }));

const {
  homeDirectorySecretName,
  ensureOrganizationDirectorySecret,
  bindEnvPresetToOrganizationSecrets,
} = await import("./home-directory-secret");

describe("homeDirectorySecretName", () => {
  it.each([
    ["/sysops/llm/codex/team", "CODEX_HOME_team"],
    ["/sysops/llm/codex/team/", "CODEX_HOME_team"],
    ["/sysops/llm/codex/team.one", "CODEX_HOME_team_one"],
    ["/", "CODEX_HOME_vault"],
  ])("derives a stable name from %s", (dir, expected) => {
    expect(homeDirectorySecretName("CODEX_HOME", dir)).toBe(expected);
  });

  it("is stable across calls, which is what makes reuse work", () => {
    const a = homeDirectorySecretName("CLAUDE_CONFIG_DIR", "/sysops/llm/claude/ops");
    const b = homeDirectorySecretName("CLAUDE_CONFIG_DIR", "/sysops/llm/claude/ops");
    expect(a).toBe(b);
  });
});

describe("ensureOrganizationDirectorySecret", () => {
  beforeEach(() => {
    secrets.list.mockReset();
    secrets.create.mockReset();
  });

  it("creates the secret when the organization has none", async () => {
    secrets.list.mockResolvedValue([]);
    secrets.create.mockResolvedValue({ id: "sec-1" });
    const binding = await ensureOrganizationDirectorySecret("co-1", "CODEX_HOME", "/sysops/llm/codex/team");
    expect(secrets.create.mock.calls[0][1]).toMatchObject({
      name: "CODEX_HOME_team",
      value: "/sysops/llm/codex/team",
    });
    expect(binding).toEqual({ type: "secret_ref", secretId: "sec-1", version: "latest" });
  });

  it("reuses a secret of the same name rather than making a second", async () => {
    secrets.list.mockResolvedValue([{ id: "sec-existing", name: "CODEX_HOME_team" }]);
    const binding = await ensureOrganizationDirectorySecret("co-1", "CODEX_HOME", "/sysops/llm/codex/team");
    expect(secrets.create).not.toHaveBeenCalled();
    expect(binding).toEqual({ type: "secret_ref", secretId: "sec-existing", version: "latest" });
  });
});

describe("bindEnvPresetToOrganizationSecrets", () => {
  beforeEach(() => {
    secrets.list.mockReset();
    secrets.create.mockReset();
  });

  it("leaves a binding that is already a reference alone", async () => {
    secrets.list.mockResolvedValue([]);
    const ref = { type: "secret_ref" as const, secretId: "sec-9", version: "latest" as const };
    const out = await bindEnvPresetToOrganizationSecrets("co-1", { CODEX_HOME: ref });
    expect(out.CODEX_HOME).toBe(ref);
    expect(secrets.create).not.toHaveBeenCalled();
  });

  it("throws when binding fails instead of silently falling back to plain", async () => {
    // CHANGED 2026-09-10. This used to swallow the error and return the plain
    // binding. That is indistinguishable from the feature not being deployed:
    // the operator saw the original redaction bug, could not tell whether the
    // build was stale, and lost a testing round to it. The caller surfaces the
    // message in the form now.
    secrets.list.mockRejectedValue(new Error("network"));
    await expect(
      bindEnvPresetToOrganizationSecrets("co-1", {
        CODEX_HOME: { type: "plain", value: "/sysops/llm/codex/team" },
      }),
    ).rejects.toThrow("network");
  });
});
