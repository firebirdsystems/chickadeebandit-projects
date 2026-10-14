import { describe, it, expect } from "vitest";
import { failureLine, uploadFailureLine } from "../src/logic.js";

const err = (props, message = "hub text") => Object.assign(new Error(message), props);
const words = { action: "save the note", thing: "note" };

describe("failureLine", () => {
  it("names a duplicate by code, or by the hub's text as a fallback", () => {
    expect(failureLine(err({ status: 400, code: "UNIQUE_CONSTRAINT" }), words)).toBe("That note already exists.");
    expect(failureLine(err({ status: 400 }, "UNIQUE constraint failed: x.id"), words)).toBe("That note already exists.");
  });
  it("names a refusal without asking for a retry", () => {
    expect(failureLine(err({ status: 403 }), words)).toBe("You don’t have permission to save the note.");
    expect(failureLine(err({ status: 507 }), words)).toBe("The household’s storage is full — free up space first.");
  });
  it("asks for a wait on a rate limit", () => {
    expect(failureLine(err({ status: 429 }), words)).toBe("Too many tries — wait a minute and try again.");
  });
  it("splits a write that changed nothing by the caller's re-read", () => {
    expect(failureLine(null, { ...words, found: false })).toBe("This note has been removed.");
    expect(failureLine(null, { ...words, found: true, guarded: true })).toBe("This note was changed by someone else — check it first.");
    expect(failureLine(err({ status: 409 }), { ...words, found: false })).toBe("This note has been removed.");
  });
  it("reads a row still there after a plain WHERE id = ? write as the row policy refusing it", () => {
    expect(failureLine(null, { ...words, found: true })).toBe("You don’t have permission to save the note.");
  });
  it("says neither removed nor changed when the re-read itself failed", () => {
    expect(failureLine(null, { ...words, found: null })).toBe("Couldn’t save the note — try again.");
    expect(failureLine(null, { ...words, found: null, guarded: true })).toBe("Couldn’t save the note — try again.");
  });
  it("reads a 404 as removed and a bare 409 as changed when there is no re-read", () => {
    expect(failureLine(err({ status: 404 }), words)).toBe("This note has been removed.");
    expect(failureLine(err({ status: 409 }), words)).toBe("This note was changed by someone else — check it first.");
  });
  it("asks for a retry only when retrying can work", () => {
    for (const e of [err({}), err({ status: 500 }), err({ status: 503 }), err({ status: 400 }), new TypeError("Failed to fetch"), undefined]) {
      expect(failureLine(e, words)).toBe("Couldn’t save the note — try again.");
    }
  });
  it("keeps a line the app wrote for the user, and never shows hub text", () => {
    expect(failureLine(err({ forUser: true }, "Pick one first."), words)).toBe("Pick one first.");
    expect(failureLine(err({ status: 500 }, "D1_ERROR: boom"), words)).not.toMatch(/D1_ERROR/);
    expect(failureLine(new TypeError("Failed to fetch"), words)).not.toMatch(/Failed to fetch/);
  });
});

describe("uploadFailureLine", () => {
  const up = { action: "add the photo", thing: "photo" };
  it("names the hub's refusals of the file itself", () => {
    expect(uploadFailureLine(err({ status: 413 }), up)).toBe("That file is too large.");
    expect(uploadFailureLine(err({ status: 415 }), up)).toBe("That kind of file can’t be uploaded.");
  });
  it("falls back to failureLine for everything else", () => {
    expect(uploadFailureLine(err({ status: 403 }), up)).toBe("You don’t have permission to add the photo.");
    expect(uploadFailureLine(err({ status: 507 }), up)).toBe("The household’s storage is full — free up space first.");
    expect(uploadFailureLine(err({ status: 503 }, "R2 down"), up)).toBe("Couldn’t add the photo — try again.");
  });
});
