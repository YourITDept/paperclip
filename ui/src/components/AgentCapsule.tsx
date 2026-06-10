import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * AgentCapsule — the brand "capsule is the agent" motif (PAP-118).
 *
 * A single agent is drawn as a tall pill (proportion 1:≥2, radius 9999px)
 * that moves through three states as the agent comes to life:
 *
 *  - `slot`       — dashed outline, gently pulsing. An empty agent slot.
 *  - `configured` — solid stroke. Agent named / model picked, not yet live.
 *  - `online`     — brand agent-gradient liquid rises to fill the capsule,
 *                   which then breathes with a green online-pulse ring.
 *
 * The fill gradient comes from the live brand agent tokens
 * `--agent-Na` (top) → `--agent-Nb` (bottom); pick which one with `gradient`
 * (1–10). Size is a preset (`sm` | `md` | `lg`) or an explicit pixel pair so
 * the component is reusable app-wide. `prefers-reduced-motion` is honored in
 * CSS — the liquid rise and both pulses are skipped and the final state is
 * rendered statically.
 */

export type AgentCapsuleState = "slot" | "configured" | "online";

export type AgentCapsuleSizePreset = "sm" | "md" | "lg";

/** Number of brand agent-gradient token pairs defined in index.css. */
export const AGENT_GRADIENT_COUNT = 10;

const SIZE_PRESETS: Record<AgentCapsuleSizePreset, { width: number; height: number }> = {
  sm: { width: 24, height: 60 },
  md: { width: 34, height: 84 },
  lg: { width: 46, height: 116 },
};

const STATE_ARIA: Record<AgentCapsuleState, string> = {
  slot: "empty agent slot",
  configured: "agent configured, offline",
  online: "agent online",
};

const capsuleVariants = cva(
  "relative isolate mx-auto overflow-hidden rounded-full transition-colors",
  {
    variants: {
      state: {
        slot: "agent-cap-slot border-2 border-dashed border-muted-foreground/60 bg-transparent",
        configured: "border-2 border-solid border-foreground/70 bg-transparent",
        online: "agent-cap-online border-0",
      },
    },
    defaultVariants: {
      state: "slot",
    },
  },
);

export interface AgentCapsuleProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "color">,
    VariantProps<typeof capsuleVariants> {
  /** Lifecycle state of the agent the capsule represents. */
  state: AgentCapsuleState;
  /** Brand agent-gradient index (1–{@link AGENT_GRADIENT_COUNT}). Wraps if out of range. */
  gradient?: number;
  /** Size preset, or an explicit `{ width, height }` in pixels (keep height ≥ 2× width). */
  size?: AgentCapsuleSizePreset | { width: number; height: number };
  /** Accessible label; defaults to a description of the state. */
  "aria-label"?: string;
}

/** Normalize a (possibly out-of-range) gradient index to 1…AGENT_GRADIENT_COUNT. */
function normalizeGradient(gradient: number): number {
  const n = Math.trunc(gradient);
  return ((((n - 1) % AGENT_GRADIENT_COUNT) + AGENT_GRADIENT_COUNT) % AGENT_GRADIENT_COUNT) + 1;
}

export function AgentCapsule({
  state,
  gradient = 1,
  size = "md",
  className,
  style,
  "aria-label": ariaLabel,
  ...rest
}: AgentCapsuleProps) {
  const dims = typeof size === "string" ? SIZE_PRESETS[size] : size;
  const idx = normalizeGradient(gradient);
  const fill = `linear-gradient(to bottom, var(--agent-${idx}a), var(--agent-${idx}b))`;

  return (
    <div
      role="img"
      aria-label={ariaLabel ?? STATE_ARIA[state]}
      data-state={state}
      data-gradient={idx}
      className={cn(capsuleVariants({ state }), className)}
      style={{ width: dims.width, height: dims.height, ...style }}
      {...rest}
    >
      {state === "online" ? (
        <span
          aria-hidden="true"
          className="agent-cap-liquid absolute inset-x-0 bottom-0 block h-full"
          style={{ background: fill }}
        />
      ) : null}
    </div>
  );
}

export default AgentCapsule;
