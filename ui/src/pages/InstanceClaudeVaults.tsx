import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  claudeVaultsApi,
  type ClaudeVaultLoginSession,
  type ClaudeVaultSummary,
} from "@/api/claudeVaults";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreateAgentFromLoginButton } from "@/components/CreateAgentFromLoginButton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

// The Claude credential vault settings page.
//
// Each entry is one named directory holding one Claude account's credential. An
// instance admin provisions one here by running a device login; an agent then
// uses it by setting `env.CLAUDE_CONFIG_DIR` to the directory's full path. Provisioning
// several is how one instance runs several agents against several Claude
// accounts.
//
// The one-time code is shown only to the admin who started the login and is
// dropped as soon as the login completes.

/** Mirrors the server-side name rule, so the field can validate before submit. */
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
/** What an agent has to be to use one of these logins: this runtime, this variable. */
const CLAUDE_ADAPTER_TYPE = "claude_local";
const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
/** Shown as shadow text in the name field to suggest the expected shape. */
const VAULT_NAME_PLACEHOLDER = "claude_device";
const NAME_HINT =
  "2-40 characters: lowercase letters, digits, underscore, or hyphen, starting with a letter or digit.";

/** Renders the credential expiry as a plain date. A setup-token lasts a year. */
function formatExpiry(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => setCopied(false),
        );
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** The live setup-token login panel for one vault. */
function LoginPanel({
  session,
  vaultDir,
  code,
  setCode,
  submitting,
  onSubmitCode,
  onCancel,
  onDone,
}: {
  session: ClaudeVaultLoginSession;
  /** The signed-in directory, once the list carries it. Null until then. */
  vaultDir: string | null;
  code: string;
  setCode: (value: string) => void;
  submitting: boolean;
  onSubmitCode: (code: string) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  if (session.state === "starting") {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Starting Claude and requesting a sign-in link…
      </div>
    );
  }

  if (session.state === "failed") {
    return (
      <div className="space-y-2 py-2">
        <div className="flex items-start gap-2 text-sm text-red-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{session.error ?? "The login failed."}</span>
        </div>
        <Button variant="outline" size="sm" onClick={onDone}>
          Dismiss
        </Button>
      </div>
    );
  }

  if (session.state === "success") {
    return (
      <div className="space-y-2 py-2">
        <div className="flex items-center gap-2 text-sm text-green-400">
          <Check className="size-4" />
          Signed in. Create an agent on this login, or copy the directory&rsquo;s path into an
          existing agent&rsquo;s CLAUDE_CONFIG_DIR.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The vault row carries the directory; the session does not. It is
              absent only in the moment between the login landing and the list
              refetch, and the row button below stays available either way. */}
          {vaultDir ? (
            <CreateAgentFromLoginButton
              adapterType={CLAUDE_ADAPTER_TYPE}
              envName={CLAUDE_CONFIG_DIR_ENV}
              envValue={vaultDir}
              vaultName={session.vaultName}
              label="Create an agent with this login"
            />
          ) : null}
          <Button variant="outline" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      <div className="space-y-1.5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Step 1 — open the sign-in page
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={session.url ?? "#"} target="_blank" rel="noreferrer noopener">
              {(session.url ?? "").replace("https://", "").slice(0, 60)}
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
          {session.url ? <CopyButton value={session.url} label="Copy link" /> : null}
        </div>
      </div>

      {/* The Claude-specific half. A Codex device login completes on its own once
          approved; Claude hands the operator a code in the browser that has to
          come back here and be written to the waiting process. */}
      <div className="space-y-1.5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Step 2 — paste the code from that page
        </div>
        {session.codeSubmitted ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Code submitted. Finishing the sign-in…
          </div>
        ) : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = code.trim();
              if (value.length > 0) onSubmitCode(value);
            }}
          >
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Paste the code"
              autoComplete="off"
              spellCheck={false}
              aria-label="Claude login code"
              className="w-72 font-mono"
            />
            <Button type="submit" size="sm" disabled={code.trim().length === 0 || submitting}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Submit code
            </Button>
          </form>
        )}
      </div>

      <p className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
        Login codes are a common phishing target. Only paste a code you just obtained from the
        page linked above, and never one someone sent you.
      </p>

      <Button variant="outline" size="sm" onClick={onCancel}>
        <X className="size-3.5" />
        Cancel
      </Button>
    </div>
  );
}

export function InstanceClaudeVaults() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The vault awaiting confirmation, and which destructive action was asked for.
  // One piece of state rather than two booleans: the two actions are mutually
  // exclusive and the dialog needs to know which one it is confirming.
  const [pendingAction, setPendingAction] = useState<
    { kind: "signOut" | "delete"; vault: ClaudeVaultSummary } | null
  >(null);
  // The browser code the operator pastes back. Held here rather than in the
  // panel so it survives the poll re-renders while the login is waiting.
  const [loginCode, setLoginCode] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "Claude logins" }]);
  }, [setBreadcrumbs]);

  const vaultsQuery = useQuery({
    queryKey: queryKeys.instance.claudeVaults,
    queryFn: () => claudeVaultsApi.list(),
  });

  // Poll only while a login is in flight; stop the moment it is terminal.
  const sessionQuery = useQuery({
    queryKey: queryKeys.instance.claudeVaultSession(sessionId ?? ""),
    queryFn: () => claudeVaultsApi.readSession(sessionId as string),
    enabled: sessionId !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "success" || state === "failed" ? false : 1500;
    },
  });

  const session = sessionQuery.data ?? null;

  useEffect(() => {
    if (session?.state === "success") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance.claudeVaults });
    }
  }, [session?.state, queryClient]);

  const startLogin = useMutation({
    mutationFn: (name: string) => claudeVaultsApi.startLogin(name),
    onSuccess: (started) => {
      setActionError(null);
      setLoginCode("");
      setSessionId(started.sessionId);
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const createVault = useMutation({
    mutationFn: (name: string) => claudeVaultsApi.create(name),
    onSuccess: async (created) => {
      setActionError(null);
      setNewName("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.claudeVaults });
      startLogin.mutate(created.name);
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const cancelSession = useMutation({
    mutationFn: (id: string) => claudeVaultsApi.cancelSession(id),
  });

  const submitCode = useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) =>
      claudeVaultsApi.submitCode(id, code),
    onSuccess: () => {
      setActionError(null);
      setLoginCode("");
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const signOutVault = useMutation({
    mutationFn: (name: string) => claudeVaultsApi.signOut(name),
    onSuccess: async () => {
      setActionError(null);
      setPendingAction(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.claudeVaults });
    },
    // The dialog stays open on failure so the message is attached to the action
    // that produced it rather than appearing over the list with no context.
    onError: (error: Error) => setActionError(error.message),
  });

  const removeVault = useMutation({
    mutationFn: (name: string) => claudeVaultsApi.remove(name),
    onSuccess: async () => {
      setActionError(null);
      setPendingAction(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.claudeVaults });
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const destructivePending = signOutVault.isPending || removeVault.isPending;

  const nameIsValid = useMemo(() => VAULT_NAME_RE.test(newName), [newName]);
  const busy = session !== null && session.state !== "success" && session.state !== "failed";
  const vaults = vaultsQuery.data?.vaults ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-bold">Claude logins</h1>
        <p className="text-sm text-muted-foreground">
          Each login is stored in its own directory and holds one Claude account. Point an agent at
          one by setting <code className="font-mono text-xs">CLAUDE_CONFIG_DIR</code> to that
          directory&rsquo;s full path in its adapter configuration. Several agents can share a
          login — they read the same credential file, so a token refresh by one never signs the
          others out.
        </p>
        {vaultsQuery.data?.root ? (
          <p className="font-mono text-xs text-muted-foreground">{vaultsQuery.data.root}</p>
        ) : null}
      </div>

      {actionError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{actionError}</span>
        </div>
      ) : null}

      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="text-sm font-semibold">Add a Claude login</div>
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-56 flex-1 space-y-1">
            <Input
              value={newName}
              placeholder={VAULT_NAME_PLACEHOLDER}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && nameIsValid && !busy) createVault.mutate(newName);
              }}
            />
            <p
              className={cn(
                "text-xs",
                newName.length > 0 && !nameIsValid ? "text-red-400" : "text-muted-foreground",
              )}
            >
              {NAME_HINT}
            </p>
          </div>
          <Button
            disabled={!nameIsValid || busy || createVault.isPending}
            onClick={() => createVault.mutate(newName)}
          >
            {createVault.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Create and sign in
          </Button>
        </div>
      </div>

      {session ? (
        <div className="space-y-2 rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4" />
            {session.vaultName}
          </div>
          <LoginPanel
            session={session}
            vaultDir={vaults.find((vault) => vault.name === session.vaultName)?.dir ?? null}
            code={loginCode}
            setCode={setLoginCode}
            submitting={submitCode.isPending}
            onSubmitCode={(value) => submitCode.mutate({ id: session.sessionId, code: value })}
            onCancel={() => {
              cancelSession.mutate(session.sessionId);
            }}
            onDone={() => {
              setLoginCode("");
              setSessionId(null);
            }}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Existing logins
        </div>
        {vaultsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : vaults.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No Claude logins yet. Create one above to let an agent run as that account.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {vaults.map((vault: ClaudeVaultSummary) => (
              <div
                key={vault.name}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{vault.name}</span>
                    {vault.hasCredential ? (
                      <Badge variant="outline" className="text-green-400">
                        {vault.authMode === "setup_token" ? "Signed in" : "OAuth login"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        No credential
                      </Badge>
                    )}
                    {vault.boundAgentCount > 0 ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        {vault.boundAgentCount === 1
                          ? "1 agent"
                          : `${vault.boundAgentCount} agents`}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {vault.dir}
                    </span>
                    <CopyButton value={vault.dir} label="Copy path" />
                  </div>
                  {vault.tokenSuffix ? (
                    <div className="text-xs text-muted-foreground">
                      Token …{vault.tokenSuffix}
                      {vault.subscriptionType && vault.subscriptionType !== "unknown"
                        ? ` · ${vault.subscriptionType}`
                        : ""}
                      {formatExpiry(vault.expiresAt) ? ` · expires ${formatExpiry(vault.expiresAt)}` : ""}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || startLogin.isPending || destructivePending}
                    onClick={() => startLogin.mutate(vault.name)}
                  >
                    <KeyRound className="size-3.5" />
                    {vault.hasCredential ? "Sign in again" : "Sign in"}
                  </Button>
                  {/* Offered whether or not the credential is in place: wiring an
                      agent to a directory that is about to be signed in is a
                      normal order of work, and the agent only needs the path. */}
                  <CreateAgentFromLoginButton
                    adapterType={CLAUDE_ADAPTER_TYPE}
                    envName={CLAUDE_CONFIG_DIR_ENV}
                    envValue={vault.dir}
                    vaultName={vault.name}
                    disabled={destructivePending}
                  />
                  {/* Sign out is offered only when there is a credential to
                      remove, so the row never presents a no-op action. */}
                  {vault.hasCredential ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Sign out ${vault.name}`}
                      title="Remove the credential and keep this login"
                      disabled={busy || destructivePending}
                      onClick={() => {
                        setActionError(null);
                        setPendingAction({ kind: "signOut", vault });
                      }}
                    >
                      <LogOut className="size-3.5" />
                      Sign out
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Delete ${vault.name}`}
                    title="Delete this login and its directory"
                    className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
                    disabled={busy || destructivePending}
                    onClick={() => {
                      setActionError(null);
                      setPendingAction({ kind: "delete", vault });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          // Never let the dialog close out from under an in-flight request; the
          // result still has to land somewhere the operator can see it.
          if (!open && destructivePending) return;
          if (!open) setPendingAction(null);
        }}
      >
        <AlertDialogContent data-testid="claude-vault-destructive-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.kind === "delete"
                ? `Delete ${pendingAction.vault.name}?`
                : `Sign out ${pendingAction?.vault.name ?? ""}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "delete"
                ? "The directory and everything in it — the credential, settings.json, and Claude project state — is permanently removed. This cannot be undone."
                : "The credential is removed and the login is kept. The directory, its config.toml, and its path all survive, so agents pointed at it keep resolving and signing in again restores it."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pendingAction ? (
            <div className="space-y-2 text-sm">
              <p className="font-mono text-xs text-muted-foreground">
                {pendingAction.vault.dir}
              </p>
              {/* The blast radius, stated before the operator commits. The count
                  is advisory — it reads 0 when the agents table cannot be read —
                  so it warns when it can and never blocks. */}
              {pendingAction.vault.boundAgentCount > 0 ? (
                <p
                  className="flex items-start gap-2 rounded-md border border-border p-2 text-xs text-muted-foreground"
                  data-testid="claude-vault-bound-agents"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-yellow-500" />
                  <span>
                    {pendingAction.vault.boundAgentCount === 1
                      ? "1 agent names this directory"
                      : `${pendingAction.vault.boundAgentCount} agents name this directory`}{" "}
                    as its <code className="font-mono">CLAUDE_CONFIG_DIR</code>.{" "}
                    {pendingAction.kind === "delete"
                      ? "Their runs will fail until they are pointed somewhere else."
                      : "Their runs will fail to authenticate until this login is signed in again."}
                  </span>
                </p>
              ) : null}
              {actionError ? (
                <p className="text-xs text-destructive">{actionError}</p>
              ) : null}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructivePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              data-testid="claude-vault-destructive-confirm"
              disabled={destructivePending}
              onClick={(event) => {
                // The dialog closes itself on action; keep it open so the
                // pending state and any error stay visible until the call lands.
                event.preventDefault();
                if (!pendingAction) return;
                if (pendingAction.kind === "delete") {
                  removeVault.mutate(pendingAction.vault.name);
                } else {
                  signOutVault.mutate(pendingAction.vault.name);
                }
              }}
            >
              {destructivePending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {pendingAction?.kind === "delete" ? "Delete" : "Sign out"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default InstanceClaudeVaults;
