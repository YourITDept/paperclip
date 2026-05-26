import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCommands } from "../commands/client/skills.js";
import { resolveCompanySkillReference } from "../commands/client/skills.js";

const ORIGINAL_ENV = { ...process.env };

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerSkillsCommands(program);
  return program;
}

async function runCommand(args: string[]): Promise<void> {
  await makeProgram().parseAsync(args, { from: "user" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "company-1",
    key: "paperclip/review-prs",
    slug: "review-prs",
    name: "Review PRs",
    description: "Review pull requests",
    markdown: "# Review PRs",
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    metadata: null,
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    attachedAgentCount: 2,
    editable: true,
    editableReason: null,
    sourceLabel: null,
    sourceBadge: "local",
    sourcePath: null,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Coder",
    role: "engineer",
    status: "active",
    reportsTo: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("skills CLI helpers", () => {
  it("resolves skill refs by id, key, or unique normalized slug", () => {
    const rows = [
      skill({ id: "skill-a", key: "paperclip/a", slug: "alpha", name: "Alpha" }),
      skill({ id: "skill-b", key: "paperclip/b", slug: "beta-skill", name: "Beta" }),
    ];

    expect(resolveCompanySkillReference(rows, "skill-a").key).toBe("paperclip/a");
    expect(resolveCompanySkillReference(rows, "paperclip/b").id).toBe("skill-b");
    expect(resolveCompanySkillReference(rows, "Beta Skill").id).toBe("skill-b");
  });

  it("rejects ambiguous slug refs", () => {
    const rows = [
      skill({ id: "skill-a", key: "paperclip/a", slug: "same", name: "A" }),
      skill({ id: "skill-b", key: "paperclip/b", slug: "same", name: "B" }),
    ];

    expect(() => resolveCompanySkillReference(rows, "same")).toThrow(/Ambiguous skill slug/);
  });
});

describe("skills CLI commands", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeChunks: unknown[];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_COMPANY_ID;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writeChunks.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists company skills as JSON through the shared client context", async () => {
    const rows = [skill()];
    fetchMock.mockResolvedValueOnce(jsonResponse(rows));

    await runCommand([
      "skills",
      "list",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/skills",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(rows);
  });

  it("resolves a skill slug before reading detail", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([skill()]))
      .mockResolvedValueOnce(jsonResponse({ ...skill(), usedByAgents: [] }));

    await runCommand([
      "skills",
      "show",
      "Review PRs",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/company-1/skills/11111111-1111-1111-1111-111111111111",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("prints skill files as raw pipeable content in human mode", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([skill()]))
      .mockResolvedValueOnce(jsonResponse({
        skillId: "11111111-1111-1111-1111-111111111111",
        path: "SKILL.md",
        kind: "skill",
        content: "# Review PRs",
        language: "markdown",
        markdown: true,
        editable: true,
      }));

    await runCommand([
      "skills",
      "file",
      "review-prs",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
    ]);

    expect(logSpy).not.toHaveBeenCalled();
    expect(writeChunks.join("")).toBe("# Review PRs\n");
  });

  it("syncs desired company skill refs to an agent and returns the runtime snapshot", async () => {
    const snapshot = {
      adapterType: "codex_local",
      supported: true,
      mode: "persistent",
      desiredSkills: ["paperclip/review-prs"],
      entries: [
        {
          key: "paperclip/review-prs",
          runtimeName: "review-prs",
          desired: true,
          managed: true,
          required: false,
          state: "installed",
          origin: "company_managed",
          detail: null,
        },
      ],
      warnings: [],
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(agent()))
      .mockResolvedValueOnce(jsonResponse(snapshot));

    await runCommand([
      "skills",
      "agent",
      "sync",
      "coder",
      "--skill",
      "review-prs",
      "--skill",
      "paperclip/qa",
      "--company-id",
      "company-1",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://paperclip.test/api/agents/coder?companyId=company-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/agents/agent-1/skills/sync",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ desiredSkills: ["review-prs", "paperclip/qa"] }),
      }),
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(snapshot);
  });
});
