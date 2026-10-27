import { expect, test } from "bun:test";
import { parseWebProbeOutput, retainScreenshotCopies } from "./web-screenshot";

test("web-probe output keeps the terminal JSON after progress lines", () => {
  expect(parseWebProbeOutput([
    "[web-probe] waiting for business selector",
    "{",
    '  "ok": true,',
    '  "action": "screenshot",',
    '  "valuesPrinted": false',
    "}",
  ].join("\n"))).toEqual({ ok: true, action: "screenshot", valuesPrinted: false });
  expect(parseWebProbeOutput("[web-probe] no terminal result")).toBeNull();
});

test("screenshot copies are kept per scope and ignore deleted probe directories", () => {
  const copied: string[] = [];
  const probe = {
    reviewScreenshot: { localPath: "/tmp/web-probe-api2business.hwpod.com-upstream-scheduling-v2-1920x1080.png" },
    screenshot: { localPath: "/tmp/web-probe-api2business.hwpod.com-upstream-scheduling-v2-1920x1080.png" },
    mobile: { localPath: "/tmp/web-probe-screenshot-nc01-v03-1/web-probe-api2business.hwpod.com-upstream-scheduling-v2-390x844.png" },
    manifest: { localPath: "/tmp/web-probe-screenshot-summary.json" },
    outside: { localPath: "/root/secret.png" },
  };
  const retained = retainScreenshotCopies(probe, {
    profile: "upstream-scheduling-v2",
    scope: "claude",
    directory: "/tmp/api2business-web-screenshots",
    copyFile: (from, to) => copied.push(`${from} -> ${to}`),
  });
  expect(copied).toEqual([
    "/tmp/web-probe-api2business.hwpod.com-upstream-scheduling-v2-1920x1080.png -> /tmp/api2business-web-screenshots/upstream-scheduling-v2-claude-1920x1080.png",
    "/tmp/web-probe-screenshot-nc01-v03-1/web-probe-api2business.hwpod.com-upstream-scheduling-v2-390x844.png -> /tmp/api2business-web-screenshots/upstream-scheduling-v2-claude-390x844.png",
  ]);
  expect(retained.retainedScreenshots).toEqual([
    "/tmp/api2business-web-screenshots/upstream-scheduling-v2-claude-1920x1080.png",
    "/tmp/api2business-web-screenshots/upstream-scheduling-v2-claude-390x844.png",
  ]);
  expect(retained.probe.reviewScreenshot).toMatchObject({
    localPath: "/tmp/api2business-web-screenshots/upstream-scheduling-v2-claude-1920x1080.png",
  });
  expect(retained.probe.manifest).toMatchObject({ localPath: "/tmp/web-probe-screenshot-summary.json" });
  expect(retained.probe.outside).toMatchObject({ localPath: "/root/secret.png" });
});
