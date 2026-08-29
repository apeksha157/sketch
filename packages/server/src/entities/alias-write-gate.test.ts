import { describe, expect, it } from "vitest";
import {
  BARE_GENERIC_ALIAS_DENYLIST,
  filterAliasWritesForEntityName,
  filterJunkAliases,
  isJunkAliasValue,
} from "./alias-write-gate";

describe("alias write gate", () => {
  it("blocks measured generic aliases while preserving real aliases and self-aliases", () => {
    for (const alias of BARE_GENERIC_ALIAS_DENYLIST) {
      expect(isJunkAliasValue(alias)).toBe(true);
    }
    expect(isJunkAliasValue("the dashboard")).toBe(true);
    expect(isJunkAliasValue("Project")).toBe(true);
    expect(isJunkAliasValue("questionnaire")).toBe(true);
    expect(isJunkAliasValue("x")).toBe(true);
    expect(isJunkAliasValue("12345")).toBe(true);
    expect(isJunkAliasValue("!!!")).toBe(true);

    expect(isJunkAliasValue("riya@example.com")).toBe(false);
    expect(isJunkAliasValue("acme.com")).toBe(false);
    expect(isJunkAliasValue("Riya Sharma")).toBe(false);
    expect(filterJunkAliases(["Project", "Riya Sharma"])).toEqual({
      kept: ["Riya Sharma"],
      blocked: ["Project"],
    });
    expect(filterAliasWritesForEntityName(["Project"], "Project")).toEqual(["Project"]);
  });
});
