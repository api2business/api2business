import { expect, test } from "bun:test";
import { postgresBigintArrayLiteral } from "./operations-store";

test("encodes account IDs as a PostgreSQL bigint array literal", () => {
  expect(postgresBigintArrayLiteral([49, 330, 307])).toBe("{49,330,307}");
  expect(() => postgresBigintArrayLiteral([0])).toThrow("positive integers");
});
