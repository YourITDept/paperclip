import { describe, it, expect } from "vitest";
import {
  ADAPTER_DEFAULTS,
  getAdapterDefaults,
  type AdapterDefaults,
} from "./adapter-defaults.js";

describe("adapter defaults registry", () => {
  it("claude_local has known shape", () => {
    const d = getAdapterDefaults("claude_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-claude/);
    expect(d.envKeys).toContain("ANTHROPIC_API_KEY");
    expect(d.allowFqdns).toContain("api.anthropic.com");
  });

  it("returns defaults for an unknown adapter", () => {
    const d = getAdapterDefaults("totally-made-up");
    // Unknown adapter falls back to base image + zero env keys + zero FQDNs.
    // The driver still functions (will fail to invoke the unknown CLI inside
    // the container) but provisioning succeeds.
    expect(d.runtimeImage).toMatch(/agent-runtime-base/);
    expect(d.envKeys).toEqual([]);
    expect(d.allowFqdns).toEqual([]);
  });

  it("every registered adapter has a non-empty runtimeImage", () => {
    for (const [type, defaults] of Object.entries(ADAPTER_DEFAULTS)) {
      expect(defaults.runtimeImage, `adapter=${type}`).toBeTruthy();
    }
  });

  it("type guard: AdapterDefaults requires the three fields", () => {
    const sample: AdapterDefaults = { runtimeImage: "x", envKeys: [], allowFqdns: [] };
    expect(sample.runtimeImage).toBe("x");
  });

  it("codex_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("codex_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-codex/);
    expect(d.envKeys).toContain("OPENAI_API_KEY");
    expect(d.allowFqdns).toContain("api.openai.com");
  });

  it("gemini_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("gemini_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-gemini/);
    expect(d.envKeys).toEqual(expect.arrayContaining(["GEMINI_API_KEY", "GOOGLE_API_KEY"]));
    expect(d.allowFqdns).toContain("generativelanguage.googleapis.com");
  });

  it("acpx_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("acpx_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-acpx/);
    expect(d.envKeys).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]));
    expect(d.allowFqdns).toEqual(expect.arrayContaining(["api.anthropic.com", "api.openai.com"]));
  });

  it("opencode_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("opencode_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-opencode/);
    expect(d.envKeys).toContain("OPENAI_API_KEY");
    expect(d.allowFqdns).toContain("api.openai.com");
  });

  it("pi_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("pi_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-pi/);
    expect(d.envKeys).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]),
    );
    expect(d.allowFqdns).toEqual(
      expect.arrayContaining(["api.anthropic.com", "api.openai.com", "api.x.ai"]),
    );
  });
});
