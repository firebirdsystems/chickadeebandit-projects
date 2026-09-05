import { test, expect } from "vitest";

/**
 * Contract test for a client-side "privileged group" gate.
 *
 * Any client predicate that decides whether the current member may perform a
 * board/committee-only write (front of an `insert_privileged_only` or
 * `write_privileged_only` row policy with `privileged_groups`) MUST mirror
 * the hub's server-side resolution exactly. The hub
 * (`memberInAppGroupSetting` in the chickadeebandit repo) treats a member as
 * privileged IFF:
 *
 *   1. a group id is configured in the app's settings, AND
 *   2. that group still exists, AND
 *   3. the member belongs to it.
 *
 * There is deliberately NO "all adults" fallback when the group is unset or
 * points at a deleted group. In that state `insert_privileged_only` rejects
 * every INSERT with 403. A client gate that returns `true` for adults when no
 * group is configured therefore shows write UI the hub silently blocks — the
 * exact mismatch that shipped in document-library / amenity-reservations /
 * architectural-review and was fixed 2026-06-28.
 *
 * Call this from `logic.test.mjs` for every gate fronting a privileged table:
 *
 *   import { testPrivilegedGateContract } from "./helpers/privileged-gate.mjs";
 *   testPrivilegedGateContract("isBoard", isBoard, {
 *     member:   { id: "a1", role: "adult" },          // adult IN the group
 *     outsider: { id: "a9", role: "adult" },          // adult NOT in the group
 *     groups:   [{ id: "g1", memberIds: ["a1"] }],
 *     groupId:  "g1",
 *   });
 *
 * @param {string} label  human name of the gate, e.g. "isBoard"
 * @param {(member: object|null, groups: Array, groupId: string|null) => boolean} gate
 * @param {{ member: object, outsider: object, groups: Array, groupId: string }} fx
 *   `member` must be an adult who is a member of `groupId`; `outsider` an adult
 *   who is not. (Adult so the assertions hold even for gates that additionally
 *   require adulthood, e.g. amenity-reservations.)
 */
export function testPrivilegedGateContract(label, gate, fx) {
  const { member, outsider, groups, groupId } = fx;

  test(`${label} — privileged for a member of the configured group`, () => {
    expect(gate(member, groups, groupId)).toBe(true);
  });

  test(`${label} — NOT privileged for a non-member`, () => {
    expect(gate(outsider, groups, groupId)).toBe(false);
  });

  test(`${label} — NOT privileged for a null member`, () => {
    expect(gate(null, groups, groupId)).toBe(false);
  });

  // The whole reason this helper exists: no adult fallback when the privileged
  // group is unconfigured. The hub grants no bypass here, so the gate must not
  // either.
  test(`${label} — NOT privileged when no group is configured`, () => {
    expect(gate(member, groups, "")).toBe(false);
    expect(gate(member, groups, null)).toBe(false);
    expect(gate(outsider, groups, "")).toBe(false);
  });

  test(`${label} — NOT privileged when the configured group no longer exists`, () => {
    expect(gate(member, groups, "missing-group-id")).toBe(false);
  });
}
