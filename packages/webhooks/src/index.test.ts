import { describe, expect, it } from "vitest";

import * as webhooks from "@pegma/webhooks";

describe("@pegma/webhooks", () => {
  it("loads the package entry point", () => {
    expect(Object.keys(webhooks)).toEqual([]);
  });
});
