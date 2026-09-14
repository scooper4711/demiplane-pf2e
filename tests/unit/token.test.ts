import { describe, it, expect } from "vitest";
import {
  normalizeDemiplaneToken,
  toUserFacingTokenError,
  toUserFacingSyncError,
  TOKEN_HELP_URL,
} from "../../src/token.js";

describe("normalizeDemiplaneToken", () => {
  it("passes a clean token through unchanged", () => {
    expect(normalizeDemiplaneToken("abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("strips a leading Bearer prefix", () => {
    expect(normalizeDemiplaneToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("strips the prefix case-insensitively and trims whitespace", () => {
    expect(normalizeDemiplaneToken("  bearer abc.def.ghi  ")).toBe("abc.def.ghi");
    expect(normalizeDemiplaneToken("BEARER abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("does not strip bearer appearing later in the token", () => {
    expect(normalizeDemiplaneToken("abc bearer def")).toBe("abc bearer def");
  });

  it("is idempotent", () => {
    const once = normalizeDemiplaneToken("Bearer abc.def.ghi");
    expect(normalizeDemiplaneToken(once)).toBe(once);
  });
});

describe("toUserFacingTokenError", () => {
  it("translates the observed expired-JWT failure", () => {
    expect(toUserFacingTokenError(new Error("GraphQL errors: could not verify: Jwt expired"))).toContain(
      "token has expired"
    );
  });

  it("translates Hasura JWT expiry variants", () => {
    expect(toUserFacingTokenError("Could not verify JWT: JWTExpired")).toContain("token has expired");
    expect(toUserFacingTokenError(new Error("GraphQL: JWTExpired"))).toContain("token has expired");
  });

  it("translates rejected-token failures", () => {
    expect(toUserFacingTokenError(new Error("GraphQL errors: invalid JWT"))).toContain("rejected the token");
    expect(toUserFacingTokenError("request failed with status 401 Unauthorized")).toContain("rejected the token");
  });

  it("returns null for unrelated errors", () => {
    expect(toUserFacingTokenError(new Error("Character not found"))).toBeNull();
    expect(toUserFacingTokenError("Rate limit exceeded")).toBeNull();
  });
});

describe("toUserFacingSyncError", () => {
  it("translates token failures and passes anything else through", () => {
    expect(toUserFacingSyncError(new Error("GraphQL errors: could not verify: Jwt expired"))).toContain(
      "token has expired"
    );
    expect(toUserFacingSyncError(new Error("Character not found"))).toBe("Character not found");
    expect(toUserFacingSyncError("plain string failure")).toBe("plain string failure");
  });

  it("points at the help URL's settings location", () => {
    expect(TOKEN_HELP_URL).toContain("getting-the-demiplane-token");
    expect(toUserFacingSyncError(new Error("Jwt expired"))).toContain("Demiplane Authorization Token");
  });
});
