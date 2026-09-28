// Unit tests for the AT-SPI busctl client and the marks overlay: pure logic,
// no display or D-Bus needed.

import { describe, expect, it } from "vitest";
import {
  A11yClient,
  A11yError,
  axRefPattern,
  decodeStates,
  isActionable,
  MACOS_A11Y_NOTICE,
  parseActions,
  replyPayload,
} from "../src/atspi.js";
import { dedupeCandidates, drawMarks, estimateMarksCost } from "../src/marks.js";
import type { A11yNode } from "../src/atspi.js";

describe("busctl reply decoding", () => {
  it("unwraps the out tuple of GetExtents", () => {
    expect(replyPayload({ type: "(iiii)", data: [[12, 112, 68, 34]] })).toEqual([12, 112, 68, 34]);
  });

  it("unwraps GetChildren a(so) rows", () => {
    expect(
      replyPayload({ type: "a(so)", data: [[ [":1.2", "/org/a11y/atspi/accessible/root"] ]] }),
    ).toEqual([ [":1.2", "/org/a11y/atspi/accessible/root"] ]);
  });

  it("unwraps D-Bus property variants (real busctl shape)", () => {
    expect(replyPayload({ type: "v", data: [{ type: "s", data: "Save button" }] })).toBe("Save button");
    expect(replyPayload({ type: "v", data: { type: "s", data: ["Save button"] } })).toBe("Save button");
  });

  it("unwraps booleans and strings", () => {
    expect(replyPayload({ type: "b", data: [true] })).toBe(true);
    expect(replyPayload({ type: "s", data: ["unix:path=/tmp/bus"] })).toBe("unix:path=/tmp/bus");
  });

  it("parses modern and legacy action tuples", () => {
    expect(parseActions([["Click", "Clicks the button", ""]])).toEqual(["Click"]);
    expect(parseActions([[0, "press", ""]])).toEqual(["press"]);
    expect(parseActions([])).toEqual([]);
  });
});

describe("state decoding", () => {
  it("decodes a measured enabled GTK3 button word", () => {
    // Measured on the gtk_bench fixture: Save button GetState = [1124075776, 0].
    expect(decodeStates([1124075776, 0])).toEqual(["enabled", "focusable", "sensitive", "showing", "visible"]);
  });

  it("reads high-word states past bit 31", () => {
    expect(decodeStates([0, 1 << (33 - 32)])).toEqual(["required"]);
  });
});

describe("ax refs and actionability", () => {
  const node = (over: Partial<A11yNode>): A11yNode => ({
    ref: "@a1.1", bus: ":1.2", path: "/org/a11y/atspi/accessible/6", role: "button", name: "Save button",
    x: 12, y: 112, w: 68, h: 34, states: ["enabled", "showing"], interfaces: ["Action", "Component"],
    ...over,
  });

  it("matches only generation-tagged a11y refs", () => {
    expect(axRefPattern.test("@a3.6")).toBe(true);
    expect(axRefPattern.test("@128.4")).toBe(false);
    expect(axRefPattern.test("@r1")).toBe(false);
    expect("@a3.6".match(axRefPattern)?.slice(1)).toEqual(["3", "6"]);
  });

  it("requires Action interface plus enabled and showing states", () => {
    expect(isActionable(node({}))).toBe(true);
    expect(isActionable(node({ interfaces: ["Component"] }))).toBe(false);
    expect(isActionable(node({ states: ["enabled"] }))).toBe(false);
    expect(isActionable(node({ states: ["showing"] }))).toBe(false);
  });
});

describe("marks overlay", () => {
  const buffer = (width: number, height: number) => Buffer.alloc(width * height * 4, 0);

  it("draws a border and numbered chip inside the buffer bounds", () => {
    const data = buffer(40, 50);
    drawMarks(data, 40, 50, [{ mark: 1, x: 5, y: 25, w: 10, h: 6 }]);
    const at = (x: number, y: number) => {
      const o = (y * 40 + x) * 4;
      return [data[o]!, data[o + 1]!, data[o + 2]!];
    };
    expect(at(5, 28)).toEqual([48, 59, 255]); // left border, BGR order
    expect(at(10, 25)).toEqual([48, 59, 255]); // top border
    expect(at(20, 45)).toEqual([0, 0, 0]); // untouched
    // chip pixels above the box are yellow (BGR 10,214,255), not black
    expect(at(6, 6)).toEqual([10, 214, 255]);
  });

  it("clips marks that fall outside the crop", () => {
    const data = buffer(20, 20);
    expect(() => drawMarks(data, 20, 20, [{ mark: 9, x: 15, y: 15, w: 10, h: 10 }])).not.toThrow();
  });

  it("estimates image cost with the width*height/750 heuristic", () => {
    expect(estimateMarksCost(1280, 720)).toBe(1229);
  });

  it("drops OCR candidates covered by an AX box and keeps the rest", () => {
    const kept = dedupeCandidates([{ x: 0, y: 0, w: 50, h: 20 }], [
      { x: 10, y: 5, w: 20, h: 8 },
      { x: 60, y: 30, w: 20, h: 8 },
    ]);
    expect(kept).toEqual([{ x: 60, y: 30, w: 20, h: 8 }]);
  });
});

describe("capability probe", () => {
  it("labels the macOS AX route as unimplemented", async () => {
    expect(MACOS_A11Y_NOTICE).toContain("not implemented");
    if (process.platform === "darwin") {
      const client = new A11yClient(process.env);
      await expect(client.snapshot()).rejects.toMatchObject({ code: "a11y-unavailable" });
    }
  });

  it("raises a11y-unavailable when no bus is reachable", async () => {
    if (process.platform !== "linux") return;
    const client = new A11yClient({ AT_SPI_BUS_ADDRESS: "unix:path=/nonexistent/a11y-bus" });
    const error = await client.snapshot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(A11yError);
    expect((error as A11yError).code).toBe("a11y-unavailable");
  });
});
