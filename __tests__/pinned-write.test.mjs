import { describe, it, expect } from "vitest";
import { outcomeUnknown, storedDiffers, SAVED_AS_FIRST } from "../src/logic.js";

const err = (props, message = "hub text") => Object.assign(new Error(message), props);

describe("outcomeUnknown", () => {
  it("is unknown with no status, a 400, or a 5xx other than 507", () => {
    for (const e of [new TypeError("Failed to fetch"), err({ status: 0 }), err({ status: 200 }), err({ status: 400 }), err({ status: 500 }), err({ status: 503 })]) {
      expect(outcomeUnknown(e)).toBe(true);
    }
  });
  it("is unknown for a UNIQUE_CONSTRAINT answer, which a retry of a landed create gets", () => {
    expect(outcomeUnknown(err({ status: 400, code: "UNIQUE_CONSTRAINT" }))).toBe(true);
    expect(outcomeUnknown(err({}, "UNIQUE constraint failed: t.id"))).toBe(true);
  });
  it("is a known refusal for any other 4xx and for 507", () => {
    for (const status of [403, 404, 409, 413, 415, 429, 507]) expect(outcomeUnknown(err({ status }))).toBe(false);
  });
  it("is a known refusal for a line the app worded after a definite changed: 0", () => {
    expect(outcomeUnknown(err({ forUser: true }, "This photo could not be attached."))).toBe(false);
  });
});

describe("storedDiffers", () => {
  const fields = { label: "Tiles", estimated_cents: 1200, actual_cents: null, purchased: 0 };
  it("treats a stored row matching the form as the same, as text", () => {
    expect(storedDiffers({ id: "x", label: "Tiles", estimated_cents: "1200", actual_cents: null, purchased: 0 }, fields)).toBe(false);
  });
  it("sees an edit made since the first try", () => {
    expect(storedDiffers({ label: "Tiles", estimated_cents: 1000, actual_cents: null, purchased: 0 }, fields)).toBe(true);
  });
});

describe("SAVED_AS_FIRST", () => {
  it("is the guide's line", () => {
    expect(SAVED_AS_FIRST).toBe("Saved as first entered — check it and update what changed.");
  });
});
