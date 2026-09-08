// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * FORK-CARRIED (CustomCodeDoc §4 change sets 3 and 4, §4.1).
 *
 * Upstream maintains a parallel `.production` component family (#12746 /
 * #12748) and `App.tsx` chooses between them at runtime:
 *
 *     <Route path=":companyPrefix"
 *            element={streamlinedUiEnabled ? <Layout /> : <ProductionLayout />}>
 *
 * `Layout` renders `CompanySettingsSidebar.tsx`; `ProductionLayout` renders
 * `CompanySettingsSidebar.production.tsx`. The fork adds two nav entries — the
 * Codex and Claude credential-vault pages — and for a week they existed in the
 * streamlined sidebar only. With the streamlined UI off, which is the default,
 * they were invisible.
 *
 * WHY THAT WENT UNNOTICED, AND WHY THIS TEST IS A SOURCE SCAN.
 *
 * Nothing failed. The routes were registered for both modes, so the pages
 * stayed reachable by URL; the server routes were untouched; all 83 vault tests
 * and both sidebar suites passed throughout. A feature can be perfectly built,
 * perfectly tested and completely unreachable — no behavioural test asks "can a
 * person get here from the nav?", and the rendering test for the streamlined
 * sidebar cannot see the other file at all.
 *
 * The confusing part was that "Adapters", one line above and on the *identical*
 * `showPage("instance.adapters")` gate, stayed visible — because that entry is
 * upstream's and lives in both files. "One of three siblings renders" looks
 * impossible until you know there are two sidebars.
 *
 * So this asserts the thing that actually broke: that every fork-carried entry
 * is present in BOTH files. It reads source rather than rendering, on the same
 * principle as `server/src/__tests__/openapi-routes.test.ts` — the property is
 * about the files existing in sync, not about what one of them renders.
 *
 * THE GENERAL RULE: when upstream adds a `.production` (or any parallel)
 * variant of a file the fork has patched, assume the patch is missing from the
 * new one. Nothing conflicts, nothing fails, and no test notices.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const SIDEBARS = [
  "CompanySettingsSidebar.tsx",
  "CompanySettingsSidebar.production.tsx",
] as const;

/** Fork-carried nav entries that must appear in every settings sidebar. */
const FORK_NAV_ENTRIES = [
  { label: "Codex logins", href: "codex-logins" },
  { label: "Claude logins", href: "claude-logins" },
] as const;

function readSidebar(file: string): string {
  return fs.readFileSync(path.join(here, file), "utf8");
}

describe("settings sidebar parity (fork-carried nav entries)", () => {
  it.each(SIDEBARS)("%s carries every fork nav entry", (file) => {
    const source = readSidebar(file);
    for (const entry of FORK_NAV_ENTRIES) {
      expect(source, `${file} is missing the "${entry.label}" nav entry`).toContain(entry.href);
      expect(source, `${file} is missing the "${entry.label}" label`).toContain(entry.label);
    }
  });

  it("both sidebars agree on which fork entries exist", () => {
    // Guards the asymmetric case specifically: one file gaining an entry the
    // other does not. Comparing the two sets is what would have caught the
    // original bug on the day the `.production` variant was introduced.
    const present = SIDEBARS.map((file) => {
      const source = readSidebar(file);
      return FORK_NAV_ENTRIES.filter((e) => source.includes(e.href)).map((e) => e.href);
    });
    expect(present[0]).toEqual(present[1]);
  });

  it("still renders the entries behind the same gate upstream uses for Adapters", () => {
    // The three entries are siblings on one visibility key. If upstream ever
    // splits that gate, this fails and the fork has to decide which key its own
    // pages belong to rather than inheriting the answer silently.
    for (const file of SIDEBARS) {
      const source = readSidebar(file);
      const gates = source.match(/showPage\("instance\.adapters"\)/g) ?? [];
      expect(gates.length, `${file} should gate Adapters + the two vault pages`).toBe(3);
    }
  });
});
