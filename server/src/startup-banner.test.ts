import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  maskApiKey,
  resolveCodexHomeBannerValue,
  resolveOpenRouterKeyBannerValue,
} from "./startup-banner.js";

// The banner colours its values, and the assertions here are about the text a
// reader compares against a dashboard or a path — not the escape codes.
function plain(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

// Deliberately not key-shaped: real head and tail so the mask assertions stay
// meaningful, middle filled with X so nothing that looks like a credential is
// ever committed or trips a secret scanner. Length matches a real OpenRouter key.
const FAKE_OPENROUTER_KEY = `sk-or-v1-797${"X".repeat(58)}c02`;
const FAKE_OPENROUTER_KEY_MASKED = "sk-or-v1-797...c02";

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe("maskApiKey", () => {
  it("renders the head and tail the way the OpenRouter dashboard does", () => {
    expect(maskApiKey(FAKE_OPENROUTER_KEY)).toBe(FAKE_OPENROUTER_KEY_MASKED);
  });

  it("trims surrounding whitespace before masking", () => {
    expect(maskApiKey(`  ${FAKE_OPENROUTER_KEY}\n`)).toBe(FAKE_OPENROUTER_KEY_MASKED);
  });

  // A short key would have most of its material on screen, which is the one
  // thing the mask exists to prevent.
  it("shows no key material when the key is too short to mask safely", () => {
    expect(maskApiKey("sk-or-v1-short")).toBe("set");
    expect(maskApiKey("a".repeat(31))).toBe("set");
    expect(maskApiKey("a".repeat(32))).toBe(`${"a".repeat(12)}...aaa`);
  });
});

describe("resolveOpenRouterKeyBannerValue", () => {
  it("reports an unset key rather than an empty value", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(plain(resolveOpenRouterKeyBannerValue())).toBe("not set");
    process.env.OPENROUTER_API_KEY = "   ";
    expect(plain(resolveOpenRouterKeyBannerValue())).toBe("not set");
  });

  it("masks a configured key", () => {
    process.env.OPENROUTER_API_KEY = FAKE_OPENROUTER_KEY;
    expect(plain(resolveOpenRouterKeyBannerValue())).toBe(FAKE_OPENROUTER_KEY_MASKED);
  });
});

describe("resolveCodexHomeBannerValue", () => {
  it("says which default agents fall back to when the override is unset", () => {
    delete process.env.PAPERCLIP_CODEX_HOME;
    expect(plain(resolveCodexHomeBannerValue())).toBe(
      "not set (agents use the per-company managed home)",
    );
  });

  it("shows an existing override path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banner-codex-home-"));
    try {
      process.env.PAPERCLIP_CODEX_HOME = dir;
      expect(plain(resolveCodexHomeBannerValue())).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The failure this catches is a typo'd path: the run creates an empty home and
  // then fails the credential gate for a provider config that was never there.
  it("flags an override that does not exist yet", () => {
    process.env.PAPERCLIP_CODEX_HOME = "/nonexistent/codex-home-abc";
    expect(plain(resolveCodexHomeBannerValue())).toBe(
      "/nonexistent/codex-home-abc (missing — created and seeded on first run)",
    );
  });

  it("resolves a relative override to an absolute path", () => {
    process.env.PAPERCLIP_CODEX_HOME = "rel/codex-home";
    expect(plain(resolveCodexHomeBannerValue())).toContain(path.resolve("rel/codex-home"));
  });
});
