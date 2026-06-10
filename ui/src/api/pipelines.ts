import type { Issue } from "@paperclipai/shared";
import { api } from "./client";

export interface PipelineListItem {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  projectId: string | null;
  enforceTransitions: boolean;
  archivedAt: Date | string | null;
  stageCount: number;
  openCaseCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineStage {
  id: string;
  pipelineId: string;
  key: string;
  name: string;
  kind: string;
  position: number;
  config?: Record<string, unknown> | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PipelineDetail extends PipelineListItem {
  stages: PipelineStage[];
  transitions: Array<{ fromStageId: string; toStageId: string; label?: string | null }>;
}

export type PipelineIntakeFieldType = "select" | "text" | "multiline";

export interface PipelineIntakeField {
  key: string;
  label: string;
  type: PipelineIntakeFieldType;
  options?: string[];
  required?: boolean;
}

export interface PipelineIntakeForm {
  pipelineId: string;
  stageId: string | null;
  stageName?: string | null;
  fields: PipelineIntakeField[];
}

export interface PipelineCase {
  id: string;
  companyId?: string;
  pipelineId: string;
  stageId: string | null;
  caseKey?: string | null;
  title: string;
  summary?: string | null;
  fields?: Record<string, unknown> | null;
  workspaceRef?: Record<string, unknown> | null;
  parentCaseId?: string | null;
  version?: number;
  pendingSuggestion?: PipelineCasePendingSuggestion | null;
  terminalKind?: string | null;
  terminalAt?: Date | string | null;
  childCount?: number;
  terminalChildCount?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PipelineCasePendingSuggestion {
  id: string;
  toStageKey: string;
  rationale: string;
  confidence?: number;
  suggestedByAgentId?: string;
  runId?: string;
  createdAt: Date | string;
}

export interface PipelineCaseDetail {
  case: PipelineCase;
  stage: PipelineStage;
  pipeline: PipelineDetail;
  allowedNextStages: PipelineStage[];
  links: PipelineCaseIssueLink[];
  blockers: PipelineCaseBlocker[];
  blocks: PipelineCaseBlocker[];
  childrenSummary: {
    childCount: number;
    terminalChildCount: number;
    loadedChildren: number;
  };
  pendingSuggestion?: PipelineCasePendingSuggestion | null;
}

export interface PipelineCaseIssueLink {
  id: string;
  companyId: string;
  caseId: string;
  issueId: string;
  role: "origin" | "conversation" | "work" | "automation";
  createdByRunId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineCaseIssueLinkWithIssue {
  link: PipelineCaseIssueLink;
  issue: Issue;
}

export interface PipelineCaseBlocker {
  id: string;
  companyId: string;
  caseId: string;
  blockedByCaseId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineCaseEvent {
  id: string;
  companyId: string;
  caseId: string;
  type: string;
  actorType: "user" | "agent" | "system";
  actorUserId?: string | null;
  actorAgentId?: string | null;
  runId?: string | null;
  fromStageId?: string | null;
  toStageId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineCaseEventsPage {
  items: PipelineCaseEvent[];
  pagination: {
    limit: number;
    offset: number;
    nextOffset: number | null;
    hasMore: boolean;
    order: "asc" | "desc";
  };
}

export type PipelineBatchIngestResult =
  | { ok: true; case: PipelineCase; created: boolean }
  | {
      ok: false;
      caseKey: string | null;
      error?: {
        status?: number;
        message?: string;
        details?: Record<string, unknown>;
      };
    };

export const pipelinesApi = {
  list: (companyId: string) => api.get<PipelineListItem[]>(`/companies/${companyId}/pipelines`),
  get: (pipelineId: string) => api.get<PipelineDetail>(`/pipelines/${pipelineId}`),
  getIntakeForm: (pipelineId: string) => api.get<PipelineIntakeForm>(`/pipelines/${pipelineId}/intake-form`),
  listCases: (pipelineId: string, filters?: { parentCaseId?: string; terminal?: boolean }) => {
    const params = new URLSearchParams();
    if (filters?.parentCaseId) params.set("parentCaseId", filters.parentCaseId);
    if (filters?.terminal !== undefined) params.set("terminal", filters.terminal ? "true" : "false");
    const qs = params.toString();
    return api.get<Array<{ case: PipelineCase; stage: PipelineStage }>>(`/pipelines/${pipelineId}/cases${qs ? `?${qs}` : ""}`);
  },
  getCase: (caseId: string) => api.get<PipelineCaseDetail>(`/cases/${caseId}`),
  getCaseChildren: (pipelineId: string, caseId: string) => pipelinesApi.listCases(pipelineId, { parentCaseId: caseId }),
  getCaseEvents: (caseId: string, filters?: { limit?: number; offset?: number; order?: "asc" | "desc" }) => {
    const params = new URLSearchParams();
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    if (filters?.order) params.set("order", filters.order);
    const qs = params.toString();
    return api.get<PipelineCaseEventsPage>(`/cases/${caseId}/events${qs ? `?${qs}` : ""}`);
  },
  getCaseIssueLinks: (caseId: string) =>
    api.get<PipelineCaseIssueLinkWithIssue[]>(`/cases/${caseId}/issue-links`),
  createIssueLink: (
    caseId: string,
    data:
      | { issueId: string; role: PipelineCaseIssueLink["role"] }
      | { role: "conversation"; issueId?: undefined },
  ) => data.issueId
    ? api.post<PipelineCaseIssueLink>(`/cases/${caseId}/issue-links`, data)
    : api.post<{ issue: Issue; created: boolean }>(`/cases/${caseId}/open-conversation`, {}),
  updateCase: (
    caseId: string,
    data: {
      title?: string;
      summary?: string | null;
      fields?: Record<string, unknown>;
      parentCaseId?: string | null;
      expectedVersion?: number;
      leaseToken?: string | null;
    },
  ) => api.patch<{ case: PipelineCase; event?: PipelineCaseEvent | null } | PipelineCase>(`/cases/${caseId}`, data),
  resolveSuggestion: (
    caseId: string,
    data: {
      suggestionId: string;
      resolution: "accept" | "dismiss";
      expectedVersion?: number;
      reason?: string | null;
      leaseToken?: string | null;
    },
  ) => api.post<unknown>(`/cases/${caseId}/resolve-suggestion`, data),
  transitionCase: (
    caseId: string,
    data: {
      toStageKey: string;
      expectedVersion: number;
      reason?: string | null;
      leaseToken?: string | null;
      acceptSuggestionId?: string;
    },
  ) => api.post<unknown>(`/cases/${caseId}/transition`, data),
  ingestCasesBatch: (pipelineId: string, data: { items: Array<{ title: string; fields?: Record<string, unknown> }> }) =>
    api.post<PipelineBatchIngestResult[]>(`/pipelines/${pipelineId}/cases/batch`, data),
};
