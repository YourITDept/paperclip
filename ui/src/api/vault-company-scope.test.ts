// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// FORK-CARRIED (CustomCodeDoc §4 change sets 3 and 4).
//
// Vault routes are company-scoped and every one of them refuses a request with
// no companyId. The failure mode this guards is not subtle but it IS silent
// until a human clicks the right button: `submitCode` shipped without the scope
// and only surfaced when an operator was midway through a Claude device login,
// with "A companyId is required to address a credential vault." A per-method
// audit is the only thing that catches a method nobody wrote a flow test for.
const calls = vi.hoisted(() => [] as { url: string; body?: unknown }[]);
vi.mock("./client", () => ({
  api: {
    get: (url: string) => { calls.push({ url }); return Promise.resolve({}); },
    post: (url: string, body?: unknown) => { calls.push({ url, body }); return Promise.resolve({}); },
    delete: (url: string, body?: unknown) => { calls.push({ url, body }); return Promise.resolve({}); },
  },
}));

const { codexVaultsApi } = await import("./codexVaults");
const { claudeVaultsApi } = await import("./claudeVaults");

const CO = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";

/** Every call each client can make, with the scope supplied first. */
const INVOCATIONS: Record<string, Array<[string, () => Promise<unknown>]>> = {
  codex: [
    ["list", () => codexVaultsApi.list(CO)],
    ["create", () => codexVaultsApi.create(CO, "v")],
    ["startLogin", () => codexVaultsApi.startLogin(CO, "v")],
    ["readSession", () => codexVaultsApi.readSession(CO, "s")],
    ["cancelSession", () => codexVaultsApi.cancelSession(CO, "s")],
    ["signOut", () => codexVaultsApi.signOut(CO, "v")],
    ["remove", () => codexVaultsApi.remove(CO, "v")],
  ],
  claude: [
    ["list", () => claudeVaultsApi.list(CO)],
    ["create", () => claudeVaultsApi.create(CO, "v")],
    ["startLogin", () => claudeVaultsApi.startLogin(CO, "v")],
    ["readSession", () => claudeVaultsApi.readSession(CO, "s")],
    ["submitCode", () => claudeVaultsApi.submitCode(CO, "s", "code")],
    ["cancelSession", () => claudeVaultsApi.cancelSession(CO, "s")],
    ["signOut", () => claudeVaultsApi.signOut(CO, "v")],
    ["remove", () => claudeVaultsApi.remove(CO, "v")],
  ],
};

describe.each(Object.entries(INVOCATIONS))("%s vault client", (_name, invocations) => {
  beforeEach(() => { calls.length = 0; });

  it.each(invocations)("%s sends the company scope", async (_method, invoke) => {
    await invoke();
    expect(calls).toHaveLength(1);
    const { url, body } = calls[0];
    const inUrl = url.includes(`companyId=${encodeURIComponent(CO)}`);
    const inBody = Boolean(body && typeof body === "object" && (body as { companyId?: string }).companyId === CO);
    // Either carrier is fine; sending neither is what the server rejects.
    expect(inUrl || inBody).toBe(true);
  });
});

describe("client surface", () => {
  // A new method added without the scope would pass the cases above only by
  // being absent from them. Assert the lists are complete.
  it.each([
    ["codex", codexVaultsApi, INVOCATIONS.codex],
    ["claude", claudeVaultsApi, INVOCATIONS.claude],
  ])("%s: every exported method is covered above", (_n, api, invocations) => {
    expect(Object.keys(api).sort()).toEqual(invocations.map(([m]) => m).sort());
  });
});
