import { expect, test } from "bun:test";
import { errorMessage } from "../src/ui/errors";

test("extracts messages from structured RPC errors", () => {
  expect(errorMessage({ error: { message: "Snapshot unavailable" } })).toBe("Snapshot unavailable");
  expect(errorMessage({ message: "Bad request" })).toBe("Bad request");
  expect(errorMessage("Network failure")).toBe("Network failure");
});
