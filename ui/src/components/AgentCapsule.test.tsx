// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCapsule } from "./AgentCapsule";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentCapsule", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function render(node: React.ReactElement) {
    const root = createRoot(container);
    act(() => {
      root.render(node);
    });
    return container.querySelector('[role="img"]') as HTMLElement;
  }

  it("renders a dashed pulsing outline with no liquid in the slot state", () => {
    const cap = render(<AgentCapsule state="slot" />);
    expect(cap.dataset.state).toBe("slot");
    expect(cap.className).toContain("agent-cap-slot");
    expect(cap.className).toContain("border-dashed");
    expect(cap.querySelector(".agent-cap-liquid")).toBeNull();
    expect(cap.getAttribute("aria-label")).toBe("empty agent slot");
  });

  it("renders a solid stroke with no liquid in the configured state", () => {
    const cap = render(<AgentCapsule state="configured" />);
    expect(cap.dataset.state).toBe("configured");
    expect(cap.className).toContain("border-solid");
    expect(cap.querySelector(".agent-cap-liquid")).toBeNull();
  });

  it("renders the rising gradient liquid + online pulse in the online state", () => {
    const cap = render(<AgentCapsule state="online" gradient={5} />);
    expect(cap.className).toContain("agent-cap-online");
    const liquid = cap.querySelector(".agent-cap-liquid") as HTMLElement;
    expect(liquid).not.toBeNull();
    expect(liquid.style.background).toContain("--agent-5a");
    expect(liquid.style.background).toContain("--agent-5b");
    expect(cap.dataset.gradient).toBe("5");
  });

  it("maps preset sizes to pixel dimensions (proportion 1:>=2)", () => {
    const cap = render(<AgentCapsule state="configured" size="md" />);
    expect(cap.style.width).toBe("34px");
    expect(cap.style.height).toBe("84px");
  });

  it("accepts an explicit pixel size", () => {
    const cap = render(<AgentCapsule state="slot" size={{ width: 28, height: 96 }} />);
    expect(cap.style.width).toBe("28px");
    expect(cap.style.height).toBe("96px");
  });

  it("wraps out-of-range gradient indices into 1..10", () => {
    expect(render(<AgentCapsule state="online" gradient={11} />).dataset.gradient).toBe("1");
    expect(render(<AgentCapsule state="online" gradient={0} />).dataset.gradient).toBe("10");
    expect(render(<AgentCapsule state="online" gradient={-1} />).dataset.gradient).toBe("9");
  });
});
