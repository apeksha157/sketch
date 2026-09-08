import { describe, expect, it } from "vitest";
import { cleanEmailBody } from "./body-text";

describe("cleanEmailBody", () => {
  it("falls back to readable HTML text only when bodyText is absent", () => {
    expect(
      cleanEmailBody({
        bodyText: null,
        bodyHtml:
          "<style>.hidden{display:none}</style><div>Hello <strong>Jane</strong></div><p>Pricing &amp; terms</p>",
      }),
    ).toBe("Hello Jane\nPricing & terms");

    expect(
      cleanEmailBody({
        bodyText: "Plain text wins",
        bodyHtml: "<p>HTML fallback</p>",
      }),
    ).toBe("Plain text wins");
  });
});
