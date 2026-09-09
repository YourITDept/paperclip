import { describe, expect, it } from "vitest";
import { INSTANCE_FEATURE_CATALOG } from "@paperclipai/shared";
import {
  applyCloudCatalogDefaults,
  applyExperimentalSettingsPatch,
  applyManagedExperimentalOverlay,
  normalizeExperimentalSettings,
  stripCloudCatalogDefaultEchoes,
} from "../services/instance-settings.js";
import type { ManagedInstanceConfig } from "../services/managed-config.js";

function managedConfig(features: ManagedInstanceConfig["features"] = {}): ManagedInstanceConfig {
  return {
    v: 1,
    mode: "cloud",
    catalogVersion: "test",
    features,
    plugins: { autoInstall: [] },
    environments: [],
  };
}

describe("applyCloudCatalogDefaults", () => {
  it("pins the catalog so this rule has something to guard", () => {
    // The rule exists for flags that default on for self-hosted and off for
    // Cloud. If that set ever empties, the helper is dead code and should go.
    const guarded = Object.entries(INSTANCE_FEATURE_CATALOG)
      .filter(([, entry]) => entry.selfHostedDefault === true && entry.cloudDefault === false)
      .map(([key]) => key);
    // FORK #4 (O-8, 2026-09-09): upstream asserts
    // `expect(guarded).toContain("enableNativeRunner")` — it was the only member
    // of this set, and the fork turned its selfHostedDefault off. The set is now
    // EMPTY here, which by upstream's own comment above makes
    // `applyCloudCatalogDefaults` dead code *on this fork* — it still runs, it
    // just has nothing to re-assert. That is accepted: the helper is Cloud-only
    // logic and this instance is self-hosted. The rest of this file still
    // exercises the helper directly, so it is not untested.
    //
    // Restore the upstream assertion the moment the fork adopts the runner, or
    // if upstream adds a second flag in this direction.
    expect(guarded).toEqual([]);
  });

  it("leaves self-hosted instances on the schema default", () => {
    const experimental = applyCloudCatalogDefaults(normalizeExperimentalSettings({}), {}, null);
    // FORK #4 (O-8): upstream expects `true`. The schema default is now false —
    // the assertion still checks what it is named for, that self-hosted is left
    // on the schema default, whatever that default is.
    expect(experimental.enableNativeRunner).toBe(false);
  });

  it("re-asserts the Cloud default when the tenant row and the overlay omit the flag", () => {
    const experimental = applyCloudCatalogDefaults(
      normalizeExperimentalSettings({}),
      {},
      managedConfig(),
    );
    expect(experimental.enableNativeRunner).toBe(false);
    // Flags with matching defaults are untouched.
    // FORK #3 (streamlined defaults): upstream expects `true`. NOT part of O-8 —
    // this assertion arrived red with the #13068 merge and is change set 3's,
    // found 2026-09-09. Neither typecheck nor any §7.2 suite covers this file.
    expect(experimental.enableStreamlinedUi).toBe(false);
  });

  it("keeps an explicit tenant value", () => {
    const raw = { enableNativeRunner: true };
    const experimental = applyCloudCatalogDefaults(
      normalizeExperimentalSettings(raw),
      raw,
      managedConfig(),
    );
    expect(experimental.enableNativeRunner).toBe(true);
  });

  it("lets a managed feature value win through the overlay", () => {
    const config = managedConfig({ enableNativeRunner: true });
    const { experimental } = applyManagedExperimentalOverlay(
      applyCloudCatalogDefaults(normalizeExperimentalSettings({}), {}, config),
      config,
    );
    expect(experimental.enableNativeRunner).toBe(true);
  });

  it("does not touch flags whose Cloud default is the enabled one", () => {
    // enableOwnerInstanceAdmin defaults off for self-hosted and on for Cloud.
    // That direction is resolved elsewhere; this helper must not flip it.
    const experimental = applyCloudCatalogDefaults(
      normalizeExperimentalSettings({}),
      {},
      managedConfig(),
    );
    expect(experimental.enableOwnerInstanceAdmin).toBe(false);
  });
});

describe("stripCloudCatalogDefaultEchoes", () => {
  /** What `updateExperimental` would persist for a given row and patch. */
  function persisted(rawStored: unknown, patch: Record<string, unknown>, config: ManagedInstanceConfig | null) {
    return stripCloudCatalogDefaultEchoes(
      rawStored,
      patch,
      applyExperimentalSettingsPatch(rawStored, patch),
      config,
    ) as Record<string, unknown>;
  }

  /** What a later read of that persisted row shows. */
  function readBack(stored: Record<string, unknown>, config: ManagedInstanceConfig | null) {
    return applyManagedExperimentalOverlay(
      applyCloudCatalogDefaults(normalizeExperimentalSettings(stored), stored, config),
      config,
    ).experimental;
  }

  it("does not persist the self-hosted default on Cloud during an unrelated write", () => {
    const config = managedConfig();
    const stored = persisted({}, { enablePipelines: true }, config);
    expect(stored.enablePipelines).toBe(true);
    // FORK #4 (O-8): upstream expects `false` — the key stripped as a Cloud-default
    // echo. `stripCloudCatalogDefaultEchoes` only acts on the guarded set, which the
    // fork emptied, so the key is persisted instead. Cloud-only path; inert on this
    // self-hosted instance. The read-back below is unchanged and still authoritative.
    expect("enableNativeRunner" in stored).toBe(true);
    // The Cloud default still applies on the next read.
    expect(readBack(stored, config).enableNativeRunner).toBe(false);
  });

  it("treats a full-GET echo of the Cloud default as no choice", () => {
    const config = managedConfig();
    const stored = persisted({}, { enableNativeRunner: false, enablePipelines: true }, config);
    // FORK #4 (O-8): upstream expects `false` — the key stripped as a Cloud-default
    // echo. `stripCloudCatalogDefaultEchoes` only acts on the guarded set, which the
    // fork emptied, so the key is persisted instead. Cloud-only path; inert on this
    // self-hosted instance. The read-back below is unchanged and still authoritative.
    expect("enableNativeRunner" in stored).toBe(true);
    expect(readBack(stored, config).enableNativeRunner).toBe(false);
  });

  it("persists an explicit Cloud opt-in", () => {
    const config = managedConfig();
    const stored = persisted({}, { enableNativeRunner: true }, config);
    expect(stored.enableNativeRunner).toBe(true);
    expect(readBack(stored, config).enableNativeRunner).toBe(true);
  });

  it("keeps a stored tenant value across unrelated writes", () => {
    const config = managedConfig();
    const stored = persisted({ enableNativeRunner: true }, { enablePipelines: true }, config);
    expect(stored.enableNativeRunner).toBe(true);
    expect(readBack(stored, config).enableNativeRunner).toBe(true);
  });

  it("leaves the whole normalized object in place for self-hosted rows", () => {
    const stored = persisted({}, { enablePipelines: true }, null);
    // FORK #4 (O-8): upstream expects `true` — this is the schema default, now false.
    expect(stored.enableNativeRunner).toBe(false);
    expect(stored).toEqual(applyExperimentalSettingsPatch({}, { enablePipelines: true }));
  });
});
