import { describe, expect, it } from "vitest";

import * as webhooks from "./index.js";

describe("@pegma/webhooks", () => {
  it("loads the package entry point", () => {
    expect(Object.keys(webhooks)).toEqual([]);
  });
});
