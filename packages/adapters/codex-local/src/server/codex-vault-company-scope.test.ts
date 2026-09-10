import { describe, expect, it } from "vitest";
import {
  assertValidVaultCompanyScope,
  resolveCompanyVaultDir,
  resolveCompanyVaultRoot,
  resolveVaultRoot,
  VAULT_COMPANY_SCOPE_INVALID,
  CODEX_VAULT_NAME_INVALID,
} from "./codex-vault.js";

// FORK-CARRIED (CustomCodeDoc §4 change set 3). The company tier is a security
// boundary, so these assert what CANNOT happen, not only what can.
const ENV = { PAPERCLIP_CODEX_VAULT_ROOT: "/sysops/llm/codex" } as NodeJS.ProcessEnv;
const CO = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const OTHER = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";

describe("vault company scope", () => {
  it("nests a vault under its company id", () => {
    expect(resolveCompanyVaultDir(CO, "alice", ENV)).toBe(`/sysops/llm/codex/${CO}/alice`);
  });

  it("keeps two companies' same-named vaults apart", () => {
    expect(resolveCompanyVaultDir(CO, "alice", ENV))
      .not.toBe(resolveCompanyVaultDir(OTHER, "alice", ENV));
  });

  it("puts the company root directly under the instance root", () => {
    expect(resolveCompanyVaultRoot(CO, ENV)).toBe(`${resolveVaultRoot(ENV)}/${CO}`);
  });

  // The boundary is only real if a crafted id cannot traverse out of the root.
  it.each([
    ["..", "traversal"],
    ["../..", "double traversal"],
    ["../" + OTHER, "sideways into another company"],
    ["/etc", "absolute path"],
    ["not-a-uuid", "non-uuid"],
    ["", "empty"],
  ])("refuses a company scope of %s (%s)", (bad) => {
    expect(() => resolveCompanyVaultRoot(bad, ENV)).toThrow(VAULT_COMPANY_SCOPE_INVALID);
    expect(() => assertValidVaultCompanyScope(bad)).toThrow(VAULT_COMPANY_SCOPE_INVALID);
  });

  // And a crafted NAME must not escape its company either.
  it.each([["../evil"], ["../../etc"], ["a/b"], [".."]])(
    "refuses a vault name of %s inside a valid company",
    (bad) => {
      expect(() => resolveCompanyVaultDir(CO, bad, ENV)).toThrow(CODEX_VAULT_NAME_INVALID);
    },
  );

  it("never resolves to the company root itself", () => {
    expect(() => resolveCompanyVaultDir(CO, ".", ENV)).toThrow();
  });
});
