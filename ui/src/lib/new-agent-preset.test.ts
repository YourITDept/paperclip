import { describe, expect, it } from "vitest";
import {
  buildNewAgentPresetPath,
  parseNewAgentEnvPreset,
} from "./new-agent-preset";

describe("buildNewAgentPresetPath", () => {
  it("returns the bare path when there is nothing to preset", () => {
    expect(buildNewAgentPresetPath({})).toBe("/agents/new");
  });

  it("keeps the existing adapterType-only shape the new-agent dialog emits", () => {
    expect(buildNewAgentPresetPath({ adapterType: "claude_local" })).toBe(
      "/agents/new?adapterType=claude_local",
    );
  });

  it("round-trips a login vault preset", () => {
    const path = buildNewAgentPresetPath({
      adapterType: "codex_local",
      env: { CODEX_HOME: "/sysops/llm/codex/codex_device" },
    });
    const params = new URLSearchParams(path.slice(path.indexOf("?")));
    expect(params.get("adapterType")).toBe("codex_local");
    expect(parseNewAgentEnvPreset(params)).toEqual({
      CODEX_HOME: { type: "plain", value: "/sysops/llm/codex/codex_device" },
    });
  });

  it("emits one env parameter per variable", () => {
    const path = buildNewAgentPresetPath({ env: { A: "1", B: "2" } });
    expect(new URLSearchParams(path.slice(path.indexOf("?"))).getAll("env")).toEqual([
      "A=1",
      "B=2",
    ]);
  });
});

describe("parseNewAgentEnvPreset", () => {
  function parse(query: string) {
    return parseNewAgentEnvPreset(new URLSearchParams(query));
  }

  it("returns nothing when the query carries no preset", () => {
    expect(parse("adapterType=claude_local")).toEqual({});
  });

  it("splits on the first = so a value may contain one", () => {
    expect(parse("env=FOO%3Da%3Db")).toEqual({ FOO: { type: "plain", value: "a=b" } });
  });

  it("accepts an empty value", () => {
    expect(parse("env=FOO%3D")).toEqual({ FOO: { type: "plain", value: "" } });
  });

  it("drops entries with no separator or no name", () => {
    expect(parse("env=FOO&env=%3Dbar")).toEqual({});
  });

  it("drops names that are not shell variable names", () => {
    expect(parse("env=not-a-name%3Dx&env=9LEADING%3Dx&env=has%20space%3Dx")).toEqual({});
  });

  it("refuses to preset a runtime-injected PAPERCLIP_ variable", () => {
    expect(parse("env=PAPERCLIP_API_URL%3Dhttp%3A%2F%2Fevil")).toEqual({});
  });

  it("drops an oversized value rather than seeding it", () => {
    const long = "x".repeat(1025);
    expect(parse(`env=FOO%3D${long}`)).toEqual({});
  });

  it("caps how many variables one link can seed", () => {
    const query = Array.from({ length: 12 }, (_, i) => `env=V${i}%3D${i}`).join("&");
    expect(Object.keys(parse(query))).toHaveLength(10);
  });

  it("keeps a bad entry from discarding the good ones", () => {
    expect(parse("env=bad-name%3Dx&env=CLAUDE_CONFIG_DIR%3D%2Fsysops%2Fllm%2Fclaude%2Fa")).toEqual({
      CLAUDE_CONFIG_DIR: { type: "plain", value: "/sysops/llm/claude/a" },
    });
  });
});
