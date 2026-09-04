import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { apiErrorMessage } from "./validation-error-message";

describe("apiErrorMessage", () => {
  it("names the field a Zod rejection actually failed on", () => {
    // The exact shape the server sends: validate() lets the ZodError reach the
    // error handler, which answers 400 with { error, details }.
    const error = new ApiError("Validation error", 400, {
      error: "Validation error",
      details: [
        {
          code: "custom",
          path: ["runtimeConfig", "modelProfiles"],
          message: "runtimeConfig.modelProfiles is no longer supported",
        },
      ],
    });

    expect(apiErrorMessage(error)).toBe(
      "Validation error: runtimeConfig.modelProfiles — runtimeConfig.modelProfiles is no longer supported",
    );
  });

  it("summarises additional issues rather than listing them in a toast", () => {
    const error = new ApiError("Validation error", 400, {
      error: "Validation error",
      details: [
        { path: ["icon"], message: "Invalid enum value" },
        { path: ["role"], message: "Invalid enum value" },
        { path: ["name"], message: "Too small" },
      ],
    });

    expect(apiErrorMessage(error)).toBe(
      "Validation error: icon — Invalid enum value (and 2 more)",
    );
  });

  it("falls back to the bare message when the body carries no issues", () => {
    const error = new ApiError("Agent not found", 404, { error: "Agent not found" });

    expect(apiErrorMessage(error)).toBe("Agent not found");
  });

  it("handles a plain Error and a non-error alike", () => {
    expect(apiErrorMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(apiErrorMessage(null, "fallback")).toBe("fallback");
    expect(apiErrorMessage(new Error(""), "fallback")).toBe("fallback");
  });

  it("survives a details array that is not shaped as issues", () => {
    // Defensive: `details` is used by non-Zod errors too, so this must never
    // turn a bad error into a worse one.
    const error = new ApiError("Validation error", 400, {
      error: "Validation error",
      details: ["not an object", 42, null, {}],
    });

    expect(apiErrorMessage(error)).toBe("Validation error");
  });
});
