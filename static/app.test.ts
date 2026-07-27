import { expect, test } from "bun:test";

test("automation submit preserves the user's current form values", async () => {
  const source = await Bun.file(new URL("./app.js", import.meta.url)).text();
  const start = source.indexOf("$('#automation-form').addEventListener");
  const end = source.indexOf("$('#generate-plan').addEventListener", start);
  const handler = source.slice(start, end);

  expect(handler).toContain("const input = {");
  expect(handler).toContain("intervalSeconds: Number($('#automation-interval').value)");
  expect(handler).toContain("body: JSON.stringify(input)");
  expect(handler).not.toContain("await loadPriorityAutomation()");
});
