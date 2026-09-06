/**
 * Fork-carried UI flags. TEMPORARY — each one here is meant to be removed.
 *
 * These are compile-time constants rather than instance settings on purpose:
 * they exist because upstream offers no supported switch, and a constant makes
 * the revert a one-line diff that `git log` can find. Anything that earns a
 * real setting should graduate out of this file.
 */

/**
 * Hide the "Connectors" item from the sidebar navigation.
 *
 * WHY. Connectors brokers OAuth through Paperclip Cloud at `my.paperclip.app`
 * (server/src/services/paperclip-cloud-connector.ts:142). This deployment is
 * not enrolled with that broker and we are not ready to expose the surface to
 * users, so the entry point is hidden while we decide between enrolling,
 * running our own broker, or using the generic remote-MCP route.
 *
 * WHY A CONSTANT AND NOT A SETTING. The upstream flag `enableApps` is retired:
 * the server hardcodes it to `true` and explicitly drops managed overrides
 * ("never let the retired flag disable Apps",
 * server/src/services/instance-settings.ts:230, :267, :323), and
 * PAPERCLIP_HIDDEN_SETTINGS has no key for this surface
 * (packages/shared/src/settings-visibility.ts). There is nothing to configure.
 *
 * SCOPE. Navigation only, deliberately. The `/apps/*` routes in ui/src/App.tsx
 * (:194-217) still resolve, so a bookmark or an in-product link still works,
 * and the feature can be exercised while it is hidden. This does not disable
 * the connector either — an enrolled identity or the PAPERCLIP_CLOUD_CONNECTOR_*
 * variables keep the broker live behind the hidden page.
 *
 * DEFERRED. Whether to also block the routes is an open question, left open on
 * purpose: blocking them means choosing a redirect / 404 / "unavailable" page,
 * which is a product decision and breaks links. Revisit it alongside the wider
 * connector work, once we know whether we are enrolling with Paperclip Cloud,
 * running our own broker, or staying on generic remote MCP.
 *
 * TO REVERT: set this to `false` and restore the three assertions marked
 * `HIDE_CONNECTORS_NAV` in ui/src/components/Sidebar.test.tsx. Then delete the
 * flag and its three call sites.
 *
 * See CustomCodeDoc/ReverseProxyCustomChanges.md for the change register entry.
 */
export const HIDE_CONNECTORS_NAV = true;
