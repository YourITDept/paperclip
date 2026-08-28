import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildNewAgentPresetPath } from "@/lib/new-agent-preset";
import { useNavigate } from "@/lib/router";

// "Create agent" for a credential vault row.
//
// The login settings pages know everything the New Agent form would otherwise
// ask the operator to retype: which runtime this credential belongs to, which
// environment variable that runtime reads, and the directory it should point at.
// This hands all three to the form as a preset, so the operator lands on a page
// that only still needs a name.
//
// It navigates rather than creating anything. The agent is created by the New
// Agent page in the usual way, with the usual review — nothing here writes.

export function CreateAgentFromLoginButton({
  adapterType,
  envName,
  envValue,
  vaultName,
  label = "Create agent",
  disabled,
}: {
  /** Adapter type to preselect, e.g. `claude_local`. */
  adapterType: string;
  /** The variable this runtime reads, e.g. `CLAUDE_CONFIG_DIR`. */
  envName: string;
  /** The vault directory's full path. */
  envValue: string;
  /** Named in the accessible label so the row's button is unambiguous. */
  vaultName: string;
  label?: string;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={`Create an agent that uses ${vaultName}`}
      title={`Open New Agent with ${envName} already set to this directory`}
      onClick={() =>
        navigate(buildNewAgentPresetPath({ adapterType, env: { [envName]: envValue } }))
      }
    >
      <UserPlus className="size-3.5" />
      {label}
    </Button>
  );
}

export default CreateAgentFromLoginButton;
