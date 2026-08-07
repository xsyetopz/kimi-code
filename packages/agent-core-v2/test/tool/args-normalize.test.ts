import { describe, expect, it } from "vitest";

import { normalizeToolArgsForValidation } from "#/tool/args-normalize";

describe("normalizeToolArgsForValidation", () => {
  it("coerces string line_offset for Read", () => {
    expect(
      normalizeToolArgsForValidation("Read", {
        path: "src/example.ts",
        line_offset: "12",
      }),
    ).toEqual({
      path: "src/example.ts",
      line_offset: 12,
    });
  });

  it("maps Claude-style todo statuses and strips extra fields", () => {
    expect(
      normalizeToolArgsForValidation("TodoList", {
        todos: [
          {
            title: "One",
            status: "completed",
            description: "ignored",
            note: "ignored",
          },
          { title: "Two", status: "wip", id: "x", description: "also ignored" },
        ],
      }),
    ).toEqual({
      todos: [
        { title: "One", status: "done" },
        { title: "Two", status: "in_progress" },
      ],
    });
  });
});
