// @vitest-environment jsdom

import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineBatchIngestResult, PipelineIntakeField } from "../api/pipelines";
import { buildBatchPayload, GeneratedField, PipelineItemDetailView, plainBatchError, validateDraftRows } from "./Pipelines";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockIssueChatThreadRender = vi.hoisted(() => vi.fn());
const mockPipelinesApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getIntakeForm: vi.fn(),
  listCases: vi.fn(),
  getCase: vi.fn(),
  getCaseChildren: vi.fn(),
  getCaseEvents: vi.fn(),
  getCaseIssueLinks: vi.fn(),
  createIssueLink: vi.fn(),
  updateCase: vi.fn(),
  resolveSuggestion: vi.fn(),
  transitionCase: vi.fn(),
  ingestCasesBatch: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/pipelines/pipeline-1/add" }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ pipelineId: "pipeline-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: (props: { comments: unknown[] }) => {
    mockIssueChatThreadRender(props);
    return <div data-testid="issue-chat-thread">Embedded thread · {props.comments.length} comments</div>;
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: (event: { preventDefault: () => void }) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.({ preventDefault: () => undefined })}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../api/pipelines", () => ({
  pipelinesApi: mockPipelinesApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fields: PipelineIntakeField[] = [
  { key: "title", label: "Name", type: "text", required: true },
  { key: "kind", label: "Type", type: "select", required: true, options: ["Blog post", "Launch tweet"] },
  { key: "notes", label: "Notes for the agent", type: "multiline", required: false },
];

describe("pipeline add-items helpers", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders generated fields from the intake schema", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <div>
          {fields.map((field) => (
            <GeneratedField key={field.key} field={field} value="" onChange={() => undefined} />
          ))}
        </div>,
      );
    });

    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Type");
    expect(container.textContent).toContain("Notes for the agent");
    expect(container.querySelector("input")).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("validates required fields from the intake schema", () => {
    const errors = validateDraftRows(
      [
        { id: "row-1", expanded: true, values: { title: "", kind: "" } },
        { id: "row-2", expanded: true, values: { title: "Launch blog post", kind: "Blog post" } },
      ],
      fields,
    );

    expect(errors["row-1"]).toEqual({
      title: "Name is required.",
      kind: "Type is required.",
    });
    expect(errors["row-2"]).toBeUndefined();
  });

  it("maps generated fields into the batch ingest payload", () => {
    const payload = buildBatchPayload(
      [
        {
          id: "row-1",
          expanded: true,
          values: {
            title: " Launch blog post ",
            kind: "Blog post",
            notes: " Keep it plain. ",
          },
        },
      ],
      fields,
    );

    expect(payload).toEqual([
      {
        title: "Launch blog post",
        fields: {
          kind: "Blog post",
          notes: "Keep it plain.",
        },
      },
    ]);
  });

  it("translates server row failures into plain language", () => {
    const result: PipelineBatchIngestResult = {
      ok: false,
      caseKey: null,
      error: {
        details: { code: "required_field", label: "Audience" },
      },
    };

    expect(plainBatchError(result)).toBe("Audience is required.");
  });
});

const pipeline = {
  id: "pipeline-1",
  companyId: "company-1",
  key: "content",
  name: "Content",
  description: null,
  projectId: null,
  enforceTransitions: false,
  archivedAt: null,
  stageCount: 3,
  openCaseCount: 1,
  createdAt: "2026-06-10T12:00:00.000Z",
  updatedAt: "2026-06-10T12:00:00.000Z",
  stages: [
    { id: "stage-intake", pipelineId: "pipeline-1", key: "intake", name: "Intake", kind: "open", position: 100 },
    { id: "stage-review", pipelineId: "pipeline-1", key: "review", name: "Review", kind: "review", position: 200 },
    { id: "stage-cancelled", pipelineId: "pipeline-1", key: "cancelled", name: "Removed", kind: "cancelled", position: 1000 },
  ],
  transitions: [],
};

const linkedIssue = {
  id: "issue-1",
  companyId: "company-1",
  projectId: null,
  identifier: "PAP-1",
  title: "Discuss launch post",
  status: "todo",
};

function itemDetail(overrides: Record<string, unknown> = {}) {
  return {
    case: {
      id: "item-1",
      companyId: "company-1",
      pipelineId: "pipeline-1",
      stageId: "stage-intake",
      title: "Draft launch post",
      summary: "Prepare the announcement.",
      fields: { audience: "Operators" },
      version: 4,
      terminalKind: null,
      childCount: 1,
      terminalChildCount: 0,
      pendingSuggestion: {
        id: "suggestion-1",
        toStageKey: "review",
        rationale: "The draft is ready for review.",
        createdAt: "2026-06-10T12:00:00.000Z",
      },
      ...overrides,
    },
    stage: pipeline.stages[0],
    pipeline,
    allowedNextStages: pipeline.stages,
    links: [],
    blockers: [],
    blocks: [],
    childrenSummary: { childCount: 1, terminalChildCount: 0, loadedChildren: 1 },
    pendingSuggestion: null,
  };
}

async function renderItemPage(
  detail = itemDetail(),
  links: unknown[] = [],
  options: {
    children?: unknown[];
    events?: unknown[];
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  mockPipelinesApi.get.mockResolvedValue(pipeline);
  mockPipelinesApi.getCase.mockResolvedValue(detail);
  mockPipelinesApi.getCaseChildren.mockResolvedValue(options.children ?? [
    {
      case: {
        id: "child-1",
        pipelineId: "pipeline-1",
        stageId: "stage-review",
        title: "Child outline",
        fields: {},
        childCount: 2,
        terminalKind: null,
      },
      stage: pipeline.stages[1],
    },
  ]);
  mockPipelinesApi.getCaseEvents.mockResolvedValue({
    items: options.events ?? [
      {
        id: "event-1",
        companyId: "company-1",
        caseId: "item-1",
        type: "transition_suggested",
        actorType: "system",
        payload: { suggestion: { toStageKey: "review" } },
        createdAt: "2026-06-10T12:00:00.000Z",
        updatedAt: "2026-06-10T12:00:00.000Z",
      },
    ],
    pagination: { limit: 100, offset: 0, nextOffset: null, hasMore: false, order: "asc" },
  });
  mockPipelinesApi.getCaseIssueLinks.mockResolvedValue(links);
  mockIssuesApi.listComments.mockResolvedValue([]);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PipelineItemDetailView pipelineId="pipeline-1" caseId="item-1" />
      </QueryClientProvider>,
    );
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  return { container, root };
}

describe("PipelineItemDetailView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a pending suggestion, linked conversation, children, and activity", async () => {
    const { container, root } = await renderItemPage(itemDetail(), [
      {
        link: {
          id: "link-1",
          companyId: "company-1",
          caseId: "item-1",
          issueId: "issue-1",
          role: "conversation",
          createdAt: "2026-06-10T12:00:00.000Z",
          updatedAt: "2026-06-10T12:00:00.000Z",
        },
        issue: linkedIssue,
      },
    ]);

    expect(container.textContent).toContain("Draft launch post");
    expect(container.textContent).toContain("Ready to move to Review?");
    expect(container.textContent).toContain("Open full issue");
    expect(container.textContent).toContain("Child outline");
    expect(container.textContent).toContain("2 nested items hidden");
    expect(container.textContent).toContain("Suggested moving to Review.");
    expect(mockIssueChatThreadRender).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      variant: "embedded",
    }));

    act(() => {
      root.unmount();
    });
  });

  it("renders empty states when there is no suggestion, conversation, or child item", async () => {
    const emptyDetail = itemDetail({
      fields: {},
      summary: null,
      childCount: 0,
      pendingSuggestion: null,
    });
    emptyDetail.childrenSummary = { childCount: 0, terminalChildCount: 0, loadedChildren: 0 };
    const { container, root } = await renderItemPage(emptyDetail, [], { children: [], events: [] });

    expect(container.textContent).not.toContain("Ready to move");
    expect(container.textContent).toContain("Start a conversation");
    expect(container.textContent).toContain("No active conversation yet.");
    expect(container.textContent).toContain("No built-from items.");

    act(() => {
      root.unmount();
    });
  });
});
