import { expect, test } from "bun:test";
import { rankingDisplayName } from "./lottery-service";
import type { Sub2ApiUser } from "./types";

function user(email: string, username: string): Sub2ApiUser {
  return {
    id: 1,
    email,
    username,
    role: "user",
    status: "active",
    balance: 0,
  };
}

test("user ranking exposes the complete email instead of a masked username", () => {
  expect(rankingDisplayName(user("xiaoyang@test.com", "xi*****@test.com"))).toBe("xiaoyang@test.com");
});

test("user ranking falls back to username only when email is absent", () => {
  expect(rankingDisplayName(user("", "lannmao"))).toBe("lannmao");
  expect(rankingDisplayName(user("", ""))).toBe("匿名用户");
});
