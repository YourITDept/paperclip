// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout.production";

const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
}));
const mockSidebarState = vi.hoisted(() => ({
  sidebarOpen: true,
  isMobile: false,
  collapsed: false,
  peeking: false,
}));
let currentPathname = "/PAP/dashboard";

vi.mock("@/lib/router", () => ({
  Outlet: () => <div>Outlet content</div>,
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(),
  useNavigationType: () => "PUSH",
  useParams: () => {
    const [firstSegment, secondSegment, entityId] = currentPathname.split("/").filter(Boolean);
    return {
      companyPrefix: firstSegment ?? "PAP",
      pluginRoutePath: secondSegment,
      agentId: secondSegment === "agents" ? entityId : undefined,
    };
  },
}));

vi.mock("./Sidebar.production", () => ({
  Sidebar: () => <div>Main company nav</div>,
}));
vi.mock("./CompanySettingsSidebar.production", () => ({
  CompanySettingsSidebar: () => <div>Company settings sidebar</div>,
}));
vi.mock("./AppsSidebar.production", () => ({
  AppsSidebar: () => <div>Apps sidebar</div>,
}));
vi.mock("./AppConnectionSidebar.production", () => ({
  AppDetailSidebar: () => <div>App detail sidebar</div>,
}));
vi.mock("./AgentContextualSidebar", () => ({
  AgentContextualSidebar: ({ agentRef }: { agentRef: string }) => <div>Agent sidebar {agentRef}</div>,
}));
vi.mock("./BreadcrumbBar.production", () => ({ BreadcrumbBar: () => <div>Breadcrumbs</div> }));
vi.mock("./SidebarAccountMenu.production", () => ({ SidebarAccountMenu: () => <div>Account menu</div> }));
vi.mock("./SidebarShell.production", () => ({
  SidebarShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./access/CompanySettingsNav", () => ({ CompanySettingsNav: () => null }));
vi.mock("./PropertiesPanel", () => ({ PropertiesPanel: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./NewIssueDialog", () => ({ NewIssueDialog: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./NewGoalDialog", () => ({ NewGoalDialog: () => null }));
vi.mock("./NewAgentDialog", () => ({ NewAgentDialog: () => null }));
vi.mock("./KeyboardShortcutsCheatsheet", () => ({ KeyboardShortcutsCheatsheet: () => null }));
vi.mock("./ToastViewport", () => ({ ToastViewport: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./WorktreeBanner", () => ({ WorktreeBanner: () => null }));
vi.mock("./DevRestartBanner", () => ({ DevRestartBanner: () => null }));
vi.mock("./StandaloneBrowserControls", () => ({ StandaloneBrowserControls: () => null }));
vi.mock("./RouteErrorBoundary", () => ({
  RouteErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../plugins/slots", async () => {
  const actual = await vi.importActual<typeof import("../plugins/slots")>("../plugins/slots");
  return {
    resolveRouteSidebarSlot: actual.resolveRouteSidebarSlot,
    usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }),
    PluginSlotMount: () => <div>Plugin route sidebar</div>,
  };
});

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn(), openOnboarding: vi.fn() }),
}));
vi.mock("../context/GeneralSettingsContext", () => ({
  GeneralSettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ togglePanelVisible: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useOptionalToastActions: () => null }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP", name: "Paperclip" }],
    loading: false,
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
    selectedCompanyId: "company-1",
    selectionSource: "manual",
    setSelectedCompanyId: vi.fn(),
  }),
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    sidebarOpen: mockSidebarState.sidebarOpen,
    setSidebarOpen: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleCollapsed: vi.fn(),
    collapsed: mockSidebarState.collapsed,
    peeking: mockSidebarState.peeking,
    setPeeking: vi.fn(),
    setForceCollapsed: vi.fn(),
    isMobile: mockSidebarState.isMobile,
    routeRequestsCollapsed: false,
    setRouteRequestsCollapsed: vi.fn(),
  }),
}));
vi.mock("../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: () => undefined }));
vi.mock("../hooks/useCompanyPageMemory", () => ({ useCompanyPageMemory: () => undefined }));
vi.mock("../api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../lib/company-selection", () => ({
  shouldSyncCompanySelectionFromRoute: () => false,
  resolveArchivedCompanyBounce: () => null,
}));
vi.mock("../lib/main-content-focus", () => ({ scheduleMainContentFocus: () => () => undefined }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Layout.production agent navigation", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/PAP/dashboard";
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      version: "1.2.3",
    });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ keyboardShortcuts: false });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableApps: true,
      enableStreamlinedUi: false,
    });
    mockSidebarState.sidebarOpen = true;
    mockSidebarState.isMobile = false;
    mockSidebarState.collapsed = false;
    mockSidebarState.peeking = false;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderAt(pathname: string) {
    currentPathname = pathname;
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  // Upstream #13011 removed AgentDetail's in-page tab bar because the streamlined
  // shell's contextual sidebar replaces it. This fork ships `enableStreamlinedUi`
  // off by default, so without this nav the agent sections have no clickable route.
  it.each([
    ["/PAP/agents/briefing-analyst/instructions", "Agent sidebar briefing-analyst"],
    ["/PAP/agents/briefing-analyst/runtime", "Agent sidebar briefing-analyst"],
    ["/PAP/agents/briefing-analyst/runs/run-1", "Agent sidebar briefing-analyst"],
  ])("renders agent navigation at %s", async (pathname, expected) => {
    const root = await renderAt(pathname);
    expect(container.textContent).toContain(expected);
    expect(container.querySelector("[data-secondary-sidebar]")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it.each(["/PAP/agents/all", "/PAP/agents/new", "/PAP/dashboard"])(
    "does not render agent navigation at %s",
    async (pathname) => {
      const root = await renderAt(pathname);
      expect(container.textContent).not.toContain("Agent sidebar");
      expect(container.textContent).toContain("Main company nav");
      await act(async () => root.unmount());
    },
  );

  it("keeps agent navigation reachable in the mobile drawer", async () => {
    mockSidebarState.isMobile = true;
    const root = await renderAt("/PAP/agents/briefing-analyst/instructions");
    expect(container.textContent).toContain("Agent sidebar briefing-analyst");
    await act(async () => root.unmount());
  });
});
