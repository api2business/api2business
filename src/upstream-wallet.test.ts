import { expect, test } from "bun:test";
import { projectSharedWalletUsageRows } from "./upstream-wallet";

const refs = [
  { baseUrl: "https://www.sheapi.cc", walletKey: "https://www.sheapi.cc" },
  { baseUrl: "https://cf.sheapi.cc", walletKey: "https://www.sheapi.cc" },
] as never;

test("shared wallet projection makes aliases display one latest finite balance", () => {
  const projected = projectSharedWalletUsageRows([
    {
      account_id: 524,
      queried_at: "2026-10-04T10:00:00.000Z",
      last_success_at: "2026-10-04T10:00:00.000Z",
      last_success_result: {
        ok: true,
        accountId: 524,
        baseUrl: "https://www.sheapi.cc",
        quota: { unit: "USD", remaining: 29.2, limit: 939, used: 910.8 },
      },
    },
    {
      account_id: 1488,
      queried_at: "2026-10-04T10:01:00.000Z",
      last_success_at: "2026-10-04T10:01:00.000Z",
      last_success_result: {
        ok: true,
        accountId: 1488,
        baseUrl: "https://cf.sheapi.cc/v1",
        quota: { unit: "USD", remaining: 29.1, limit: 939, used: 910.9 },
      },
    },
  ], refs);

  expect(projected.results[0]).toMatchObject({ accountId: 524, walletKey: "https://www.sheapi.cc", quota: { remaining: 29.1 } });
  expect(projected.results[1]).toMatchObject({ accountId: 1488, walletKey: "https://www.sheapi.cc", quota: { remaining: 29.1 } });
});

test("shared wallet projection keeps positive cached balance when a later account reports zero", () => {
  const projected = projectSharedWalletUsageRows([
    {
      account_id: 1522,
      last_success_at: "2026-10-05T10:00:00.000Z",
      last_success_result: {
        ok: true,
        accountId: 1522,
        baseUrl: "https://rapidapi.cc/v1",
        quota: { unit: "USD", remaining: 20.5 },
      },
    },
    {
      account_id: 1523,
      last_success_at: "2026-10-05T10:01:00.000Z",
      last_success_result: {
        ok: true,
        accountId: 1523,
        baseUrl: "https://rapidapi.cc",
        quota: { unit: "USD", remaining: 0 },
      },
    },
  ]);

  expect(projected.results.map((row) => (row.quota as { remaining: number }).remaining)).toEqual([20.5, 20.5]);
});
