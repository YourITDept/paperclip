import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, GitBranch, Info, MessageSquare, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import {
  pipelinesApi,
  type PipelineBatchIngestResult,
  type PipelineCase,
  type PipelineCaseDetail,
  type PipelineCaseEvent,
  type PipelineCaseIssueLinkWithIssue,
  type PipelineIntakeField,
  type PipelineIntakeForm,
  type PipelineStage,
} from "../api/pipelines";
import { issuesApi } from "../api/issues";
import { IssueChatThread } from "../components/IssueChatThread";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import {
  displayPipelineItemFields,
  formatPipelineItemEvent,
  getPendingTransitionBannerState,
  humanizePipelineItemStatus,
  itemHasChangedNotice,
} from "../lib/pipeline-item-detail";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

interface DraftRow {
  id: string;
  expanded: boolean;
  values: Record<string, string>;
  serverError?: string | null;
}

type FieldErrors = Record<string, string>;
type RowErrors = Record<string, FieldErrors>;

let draftCounter = 0;

function newDraftRow(expanded = true): DraftRow {
  draftCounter += 1;
  return { id: `draft-${draftCounter}`, expanded, values: {}, serverError: null };
}

function isBlank(value: string | undefined) {
  return !value || value.trim().length === 0;
}

export function validateDraftRows(rows: DraftRow[], fields: PipelineIntakeField[]): RowErrors {
  const errors: RowErrors = {};
  for (const row of rows) {
    const rowErrors: FieldErrors = {};
    for (const field of fields) {
      if (field.required && isBlank(row.values[field.key])) {
        rowErrors[field.key] = `${field.label} is required.`;
      }
    }
    if (Object.keys(rowErrors).length > 0) {
      errors[row.id] = rowErrors;
    }
  }
  return errors;
}

export function buildBatchPayload(rows: DraftRow[], fields: PipelineIntakeField[]) {
  return rows.map((row) => {
    const title = row.values.title?.trim() ?? "";
    const itemFields: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.key === "title") continue;
      const value = row.values[field.key];
      if (value !== undefined && value.trim().length > 0) {
        itemFields[field.key] = value.trim();
      }
    }
    return { title, fields: itemFields };
  });
}

export function plainBatchError(result: Extract<PipelineBatchIngestResult, { ok: false }>) {
  const details = result.error?.details ?? {};
  if (details.code === "required_field" && typeof details.label === "string") {
    return `${details.label} is required.`;
  }
  if (details.code === "invalid_select_value" && typeof details.label === "string") {
    return `${details.label} needs one of the available choices.`;
  }
  if (details.code === "duplicate_batch_key") {
    return "This item duplicates another row.";
  }
  if (details.code === "blocker_cycle") {
    return "This item waits on another row that also waits on it.";
  }
  if (typeof result.error?.message === "string" && result.error.message.trim()) {
    return result.error.message.replace(/^Pipeline\s+/i, "");
  }
  return "This item needs attention before it can be submitted.";
}

function itemCountLabel(count: number) {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

export function Pipelines() {
  const params = useParams<{ pipelineId?: string }>();
  const location = useLocation();
  const pipelineId = params.pipelineId ?? null;
  const addMode = Boolean(pipelineId && location.pathname.endsWith("/add"));

  if (pipelineId && addMode) return <PipelineAddItems pipelineId={pipelineId} />;
  if (pipelineId) return <PipelineBoard pipelineId={pipelineId} />;
  return <PipelinesIndex />;
}

function PipelinesIndex() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipelines" }]), [setBreadcrumbs]);

  const pipelines = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "missing-company"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  if (!selectedCompanyId) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Select a company to view pipelines.</div>;
  }
  if (pipelines.isLoading) return <PageSkeleton />;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Work</p>
        <h1 className="text-2xl font-semibold text-foreground">Pipelines</h1>
      </div>
      <div className="divide-y border-y border-border">
        {(pipelines.data ?? []).map((pipeline) => (
          <Link
            key={pipeline.id}
            to={`/pipelines/${pipeline.id}`}
            className="grid grid-cols-[1fr_auto] items-center gap-4 py-3 text-sm hover:bg-muted/40"
          >
            <span>
              <span className="block font-medium text-foreground">{pipeline.name}</span>
              {pipeline.description ? (
                <span className="block text-xs text-muted-foreground">{pipeline.description}</span>
              ) : null}
            </span>
            <span className="text-xs text-muted-foreground">{pipeline.openCaseCount} open</span>
          </Link>
        ))}
      </div>
      {pipelines.data?.length === 0 ? (
        <p className="py-10 text-sm text-muted-foreground">No pipelines yet.</p>
      ) : null}
    </div>
  );
}

function PipelineBoard({ pipelineId }: { pipelineId: string }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });
  const items = useQuery({
    queryKey: queryKeys.pipelines.cases(pipelineId),
    queryFn: () => pipelinesApi.listCases(pipelineId),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipelines", href: "/pipelines" }, { label: pipeline.data?.name ?? "Pipeline" }]);
  }, [pipeline.data?.name, setBreadcrumbs]);

  if (pipeline.isLoading) return <PageSkeleton />;
  if (!pipeline.data) return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Pipeline not found.</div>;

  const rows = items.data ?? [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Pipeline</p>
          <h1 className="text-2xl font-semibold text-foreground">{pipeline.data.name}</h1>
          <p className="text-sm text-muted-foreground">Items move through the stages below.</p>
        </div>
        <Button asChild>
          <Link to={`/pipelines/${pipelineId}/add`}>
            <Plus className="mr-2 h-4 w-4" />
            Add items
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {pipeline.data.stages.map((stage) => {
          const stageItems = rows.filter((row) => row.case.stageId === stage.id);
          return (
            <section key={stage.id} className="min-h-40 border border-border bg-background p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">{stage.name}</h2>
                <span className="text-xs text-muted-foreground">{itemCountLabel(stageItems.length)}</span>
              </div>
              <div className="space-y-2">
                {stageItems.map((row) => (
                  <Link
                    key={row.case.id}
                    to={`/pipelines/${pipelineId}/items/${row.case.id}`}
                    className="block border border-border bg-muted/20 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/40"
                  >
                    {row.case.title}
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function PipelineItemLegacyRedirect() {
  const params = useParams<{ pipelineId?: string; caseId?: string }>();
  if (!params.pipelineId || !params.caseId) return <NavigateMissingItem />;
  return <NavigateToItem pipelineId={params.pipelineId} caseId={params.caseId} />;
}

function NavigateToItem({ pipelineId, caseId }: { pipelineId: string; caseId: string }) {
  return <LinkRedirect to={`/pipelines/${pipelineId}/items/${caseId}`} />;
}

function NavigateMissingItem() {
  return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Item not found.</div>;
}

function LinkRedirect({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace: true });
  }, [navigate, to]);
  return null;
}

export function PipelineItemDetail() {
  const params = useParams<{ pipelineId?: string; caseId?: string }>();
  if (!params.pipelineId || !params.caseId) return <NavigateMissingItem />;
  return <PipelineItemDetailView pipelineId={params.pipelineId} caseId={params.caseId} />;
}

export function PipelineItemDetailView({ pipelineId, caseId }: { pipelineId: string; caseId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });
  const item = useQuery({
    queryKey: queryKeys.pipelines.caseDetail(caseId),
    queryFn: () => pipelinesApi.getCase(caseId),
  });
  const children = useQuery({
    queryKey: queryKeys.pipelines.caseChildren(pipelineId, caseId),
    queryFn: () => pipelinesApi.getCaseChildren(pipelineId, caseId),
  });
  const events = useQuery({
    queryKey: queryKeys.pipelines.caseEvents(caseId),
    queryFn: () => pipelinesApi.getCaseEvents(caseId, { order: "asc", limit: 100 }),
  });
  const issueLinks = useQuery({
    queryKey: queryKeys.pipelines.caseIssueLinks(caseId),
    queryFn: () => pipelinesApi.getCaseIssueLinks(caseId),
  });

  const detail = item.data;
  const stages = pipeline.data?.stages ?? detail?.allowedNextStages ?? [];
  const stageLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const stage of stages) {
      lookup.set(stage.id, stage.name);
      lookup.set(stage.key, stage.name);
    }
    return lookup;
  }, [stages]);
  const conversationLink = useMemo(() => {
    const links = issueLinks.data ?? [];
    return links.find((link) => link.link.role === "conversation")
      ?? links.find((link) => link.link.role === "work")
      ?? null;
  }, [issueLinks.data]);
  const conversationIssueId = conversationLink?.issue.id ?? null;
  const comments = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.comments(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation"],
    queryFn: () => issuesApi.listComments(conversationIssueId!, { order: "asc", limit: 50 }),
    enabled: Boolean(conversationIssueId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.data?.name ?? detail?.pipeline.name ?? "Pipeline", href: `/pipelines/${pipelineId}` },
      { label: detail?.case.title ?? "Item" },
    ]);
  }, [detail?.case.title, detail?.pipeline.name, pipeline.data?.name, pipelineId, setBreadcrumbs]);

  const invalidateItem = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseIssueLinks(caseId) }),
    ]);
  }, [caseId, pipelineId, queryClient]);

  const startConversation = useMutation({
    mutationFn: async () => {
      await pipelinesApi.createIssueLink(caseId, { role: "conversation" });
    },
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: "Conversation started", tone: "success" });
    },
    onError: () => pushToast({ title: "Could not start the conversation", tone: "error" }),
  });

  const addConversationComment = useCallback(async (body: string) => {
    if (!conversationIssueId) return;
    await issuesApi.addComment(conversationIssueId, body);
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(conversationIssueId) });
  }, [conversationIssueId, queryClient]);

  const resolveSuggestion = useMutation({
    mutationFn: ({ resolution, suggestionId }: { resolution: "accept" | "dismiss"; suggestionId: string }) =>
      pipelinesApi.resolveSuggestion(caseId, {
        suggestionId,
        resolution,
        expectedVersion: detail?.case.version,
      }),
    onSuccess: async (_result, variables) => {
      await invalidateItem();
      pushToast({
        title: variables.resolution === "accept" ? "Move approved" : "Suggestion dismissed",
        tone: "success",
      });
    },
    onError: () => pushToast({ title: "Could not resolve the suggestion", tone: "error" }),
  });

  const acknowledgeChange = useMutation({
    mutationFn: () => pipelinesApi.updateCase(caseId, {
      expectedVersion: detail?.case.version,
      fields: {
        ...(detail?.case.fields ?? {}),
        changeAcknowledgedAt: new Date().toISOString(),
      },
    }),
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: "Change acknowledged", tone: "success" });
    },
    onError: () => pushToast({ title: "Could not acknowledge the change", tone: "error" }),
  });

  const removeStage = useMemo(
    () => stages.find((stage) => stage.kind === "cancelled") ?? stages.find((stage) => stage.key === "cancelled") ?? null,
    [stages],
  );
  const removeItem = useMutation({
    mutationFn: () => {
      if (!removeStage || !detail?.case.version) throw new Error("Missing removal stage");
      return pipelinesApi.transitionCase(caseId, {
        toStageKey: removeStage.key,
        expectedVersion: detail.case.version,
        reason: "Removed from the item detail page.",
      });
    },
    onSuccess: async () => {
      setRemoveDialogOpen(false);
      await invalidateItem();
      pushToast({ title: "Item removed", tone: "success" });
      navigate(`/pipelines/${pipelineId}`);
    },
    onError: () => pushToast({ title: "Could not remove the item", tone: "error" }),
  });

  if (pipeline.isLoading || item.isLoading) return <PageSkeleton />;
  if (!detail || !pipeline.data) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Item not found.</div>;
  }

  const itemFields = displayPipelineItemFields(detail.case.fields);
  const banner = getPendingTransitionBannerState(detail.case, stageLookup);
  const changedNotice = itemHasChangedNotice(detail.case);
  const statusLabel = humanizePipelineItemStatus(detail.case.terminalKind ?? detail.stage.kind);
  const childRows = children.data ?? [];
  const eventRows = events.data?.items ?? [];
  const primaryAction = conversationLink
    ? (
        <Button asChild>
          <Link to={`/issues/${conversationLink.issue.id}`}>
            <MessageSquare className="mr-2 h-4 w-4" />
            Open full issue
          </Link>
        </Button>
      )
    : (
        <Button onClick={() => startConversation.mutate()} disabled={startConversation.isPending}>
          <MessageSquare className="mr-2 h-4 w-4" />
          {startConversation.isPending ? "Starting..." : "Start a conversation"}
        </Button>
      );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link to="/pipelines" className="hover:text-foreground">Pipelines</Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <Link to={`/pipelines/${pipelineId}`} className="hover:text-foreground">{pipeline.data.name}</Link>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 text-2xl font-semibold text-foreground">{detail.case.title}</h1>
            <span className="rounded-sm border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {statusLabel}
            </span>
          </div>
          {detail.case.summary ? <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{detail.case.summary}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {primaryAction}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Item actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                disabled={!removeStage || removeItem.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  setRemoveDialogOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
                Remove item
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {banner.visible ? (
        <section className="mb-5 flex flex-col gap-3 border-y border-border bg-muted/20 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Ready to move to {banner.stageName}?</h2>
            {banner.rationale ? <p className="mt-1 text-sm text-muted-foreground">{banner.rationale}</p> : null}
          </div>
          {banner.suggestionId ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => resolveSuggestion.mutate({ resolution: "accept", suggestionId: banner.suggestionId! })}
                disabled={resolveSuggestion.isPending}
              >
                <Check className="mr-2 h-4 w-4" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolveSuggestion.mutate({ resolution: "dismiss", suggestionId: banner.suggestionId! })}
                disabled={resolveSuggestion.isPending}
              >
                <X className="mr-2 h-4 w-4" />
                Not yet
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {changedNotice ? (
        <section className="mb-5 flex flex-col gap-3 border-y border-amber-300 bg-amber-50 py-4 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100 md:flex-row md:items-center md:justify-between">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">{changedNotice.title}</h2>
              <p className="mt-1 text-sm opacity-85">{changedNotice.body}</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => acknowledgeChange.mutate()}
            disabled={acknowledgeChange.isPending}
          >
            Acknowledge
          </Button>
        </section>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <main className="space-y-8">
          <DetailSection title="Conversation">
            {conversationLink ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">{conversationLink.issue.title}</span>
                  <Link to={`/issues/${conversationLink.issue.id}`} className="text-muted-foreground hover:text-foreground">
                    Open full issue
                  </Link>
                </div>
                <IssueChatThread
                  comments={comments.data ?? []}
                  issueId={conversationLink.issue.id}
                  companyId={conversationLink.issue.companyId}
                  projectId={conversationLink.issue.projectId}
                  issueStatus={conversationLink.issue.status}
                  onAdd={addConversationComment}
                  emptyMessage="No conversation yet."
                  variant="embedded"
                />
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3 py-3 text-sm text-muted-foreground">
                <p>No active conversation yet.</p>
                <Button size="sm" variant="outline" onClick={() => startConversation.mutate()} disabled={startConversation.isPending}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  {startConversation.isPending ? "Starting..." : "Start a conversation"}
                </Button>
              </div>
            )}
          </DetailSection>

          <DetailSection title={`Built from ${detail.childrenSummary.childCount} ${detail.childrenSummary.childCount === 1 ? "item" : "items"}`}>
            <BuiltFromTree pipelineId={pipelineId} rows={childRows} />
          </DetailSection>
        </main>

        <aside className="space-y-8">
          <DetailSection title="Details">
            {itemFields.length > 0 ? (
              <dl className="divide-y divide-border">
                {itemFields.map((field) => (
                  <div key={field.key} className="grid grid-cols-[120px_1fr] gap-3 py-2 text-sm">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="min-w-0 text-foreground">{field.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">No added details.</p>
            )}
          </DetailSection>

          <DetailSection title="Activity">
            {eventRows.length > 0 ? (
              <ol className="divide-y divide-border">
                {eventRows.map((event) => (
                  <li key={event.id} className="py-2 text-sm">
                    <p className="text-foreground">{formatPipelineItemEvent(event, stageLookup)}</p>
                    <time className="text-xs text-muted-foreground">{formatShortDate(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">No activity yet.</p>
            )}
          </DetailSection>
        </aside>
      </div>

      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove item</DialogTitle>
            <DialogDescription>
              This moves the item out of active work. It stays visible in the pipeline history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>Keep item</Button>
            <Button variant="destructive" onClick={() => removeItem.mutate()} disabled={removeItem.isPending || !removeStage}>
              {removeItem.isPending ? "Removing..." : "Remove item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
      <div className="border-y border-border">{children}</div>
    </section>
  );
}

function BuiltFromTree({
  pipelineId,
  rows,
}: {
  pipelineId: string;
  rows: Array<{ case: PipelineCase; stage: PipelineStage }>;
}) {
  if (rows.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">No built-from items.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.case.id}>
          <Link
            to={`/pipelines/${pipelineId}/items/${row.case.id}`}
            className="grid grid-cols-[18px_1fr_auto] items-center gap-3 py-3 text-sm hover:bg-muted/40"
          >
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-foreground">{row.case.title}</span>
              {(row.case.childCount ?? 0) > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  {row.case.childCount} nested {(row.case.childCount ?? 0) === 1 ? "item" : "items"} hidden
                </span>
              ) : null}
            </span>
            <span className="rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {humanizePipelineItemStatus(row.case.terminalKind ?? row.stage.kind)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatShortDate(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function PipelineAddItems({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [rows, setRows] = useState<DraftRow[]>(() => [newDraftRow(true)]);

  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });
  const intake = useQuery({
    queryKey: queryKeys.pipelines.intakeForm(pipelineId),
    queryFn: () => pipelinesApi.getIntakeForm(pipelineId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Pipelines", href: "/pipelines" },
      { label: pipeline.data?.name ?? "Pipeline", href: `/pipelines/${pipelineId}` },
      { label: "Add items" },
    ]);
  }, [pipeline.data?.name, pipelineId, setBreadcrumbs]);

  const fields = intake.data?.fields ?? [];
  const errors = useMemo(() => validateDraftRows(rows, fields), [fields, rows]);
  const invalid = rows.length === 0 || Object.keys(errors).length > 0;

  const submit = useMutation({
    mutationFn: () => pipelinesApi.ingestCasesBatch(pipelineId, { items: buildBatchPayload(rows, fields) }),
    onSuccess: async (results) => {
      const failedByIndex = new Map<number, string>();
      results.forEach((result, index) => {
        if (!result.ok) failedByIndex.set(index, plainBatchError(result));
      });
      if (failedByIndex.size > 0) {
        setRows((current) =>
          current.map((row, index) => ({
            ...row,
            expanded: failedByIndex.has(index) ? true : row.expanded,
            serverError: failedByIndex.get(index) ?? null,
          })),
        );
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      ]);
      pushToast({ title: `${itemCountLabel(rows.length)} submitted`, tone: "success" });
      navigate(`/pipelines/${pipelineId}`);
    },
  });

  if (pipeline.isLoading || intake.isLoading) return <PageSkeleton />;
  if (!pipeline.data || !intake.data) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Pipeline not found.</div>;
  }

  const firstStageName = intake.data.stageName ?? pipeline.data.stages[0]?.name ?? "first stage";

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Add to {pipeline.data.name}
        </p>
        <h1 className="text-2xl font-semibold text-foreground">Build your list, then submit it all at once</h1>
        <p className="text-sm text-muted-foreground">
          Items will be added to the first stage ({firstStageName}).
        </p>
      </div>

      <div className="mb-5 flex items-center gap-2 border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        <span>
          These fields come from <span className="font-medium text-foreground">Pipeline settings -&gt; {firstStageName} stage</span>.
        </span>
      </div>

      <div className="space-y-3">
        {rows.map((row, index) => (
          <DraftItemRow
            key={row.id}
            row={row}
            index={index}
            fields={fields}
            intake={intake.data}
            errors={errors[row.id] ?? {}}
            onToggle={() =>
              setRows((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, expanded: !candidate.expanded } : candidate))
            }
            onRemove={() => setRows((current) => current.filter((candidate) => candidate.id !== row.id))}
            onChange={(fieldKey, value) =>
              setRows((current) =>
                current.map((candidate) =>
                  candidate.id === row.id
                    ? { ...candidate, values: { ...candidate.values, [fieldKey]: value }, serverError: null }
                    : candidate,
                ),
              )
            }
          />
        ))}

        <button
          type="button"
          className="flex h-14 w-full items-center justify-center border border-dashed border-border text-sm font-semibold text-foreground hover:bg-muted/40"
          onClick={() => setRows((current) => [...current, newDraftRow(false)])}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add another item
        </button>
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-border pt-5">
        <Button variant="outline" onClick={() => navigate(`/pipelines/${pipelineId}`)}>
          Cancel
        </Button>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">
            {rows.length === 0 ? "Add at least one item." : "Count updates live."}
          </span>
          <Button disabled={invalid || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Submitting..." : `Submit ${itemCountLabel(rows.length)}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DraftItemRow({
  row,
  index,
  fields,
  intake,
  errors,
  onToggle,
  onRemove,
  onChange,
}: {
  row: DraftRow;
  index: number;
  fields: PipelineIntakeField[];
  intake: PipelineIntakeForm;
  errors: FieldErrors;
  onToggle: () => void;
  onRemove: () => void;
  onChange: (fieldKey: string, value: string) => void;
}) {
  const title = row.values.title?.trim() || `Item ${index + 1}`;
  const preview = fields
    .filter((field) => field.key !== "title")
    .map((field) => row.values[field.key])
    .filter((value): value is string => Boolean(value && value.trim()))
    .slice(0, 2)
    .join(" · ");

  return (
    <section className={cn("border border-border bg-background", row.expanded && "border-primary")}>
      <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3">
        <button type="button" className="min-w-0 text-left" onClick={onToggle}>
          <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Item {index + 1}</span>
          <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
          {!row.expanded && preview ? <span className="block truncate text-xs text-muted-foreground">{preview}</span> : null}
          {!row.expanded && row.serverError ? <span className="block text-xs text-destructive">{row.serverError}</span> : null}
        </button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={onToggle} aria-label={row.expanded ? "Collapse item" : "Expand item"}>
            {row.expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
          <Button variant="outline" size="icon" onClick={onRemove} aria-label="Remove item">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {row.expanded ? (
        <div className="grid gap-5 border-t border-border px-4 py-4 lg:grid-cols-[1fr_280px]">
          <div className="grid gap-4 md:grid-cols-2">
            {fields.map((field) => (
              <GeneratedField
                key={field.key}
                field={field}
                value={row.values[field.key] ?? ""}
                error={errors[field.key]}
                onChange={(value) => onChange(field.key, value)}
              />
            ))}
            {row.serverError ? <p className="md:col-span-2 text-sm text-destructive">{row.serverError}</p> : null}
          </div>
          <aside className="border border-border p-4 text-sm">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Preview</p>
            <p className="font-semibold text-foreground">{title}</p>
            <p className="mt-3 text-xs text-muted-foreground">First stage on submit:</p>
            <p className="font-semibold text-foreground">{intake.stageName ?? "First stage"}</p>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

export function GeneratedField({
  field,
  value,
  error,
  onChange,
}: {
  field: PipelineIntakeField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `pipeline-intake-${field.key}`;
  return (
    <label className={cn("block space-y-1", field.type === "multiline" && "md:col-span-2")}>
      <span className="text-sm font-medium text-foreground">
        {field.label}
        {field.required ? <span className="ml-1 font-normal text-destructive">required</span> : null}
      </span>
      {field.type === "select" ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={inputId} aria-invalid={Boolean(error)} className="w-full">
            <SelectValue placeholder="Choose..." />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>{option}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "multiline" ? (
        <Textarea id={inputId} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input id={inputId} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />
      )}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </label>
  );
}
