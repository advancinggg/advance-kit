import { afterEach, describe, expect, test } from "bun:test";
import {
  detectDeploymentMode,
  getDeploymentMode,
  resetDeploymentModeCacheForTest,
} from "../../src/daemon/deployment-mode";

afterEach(() => resetDeploymentModeCacheForTest());

describe("MODULE-001-AC-07/AC-08: DeploymentMode detection", () => {
  test("MODULE-001-T09 — XPC_SERVICE_NAME set → 'launchd'", () => {
    expect(detectDeploymentMode({ XPC_SERVICE_NAME: "com.advance.tgcp" }, 12345)).toBe("launchd");
  });

  test("MODULE-001-T09b — LAUNCHD_SOCKET set → 'launchd'", () => {
    expect(detectDeploymentMode({ LAUNCHD_SOCKET: "/some/sock" }, 12345)).toBe("launchd");
  });

  test("MODULE-001-T09c — ppid === 1 → 'launchd' even without XPC env", () => {
    expect(detectDeploymentMode({}, 1)).toBe("launchd");
  });

  test("MODULE-001-T10 — no XPC env + ppid != 1 → 'lazy-spawn'", () => {
    expect(detectDeploymentMode({}, 12345)).toBe("lazy-spawn");
  });

  test("getDeploymentMode caches its first result", () => {
    resetDeploymentModeCacheForTest();
    const a = getDeploymentMode({ XPC_SERVICE_NAME: "foo" }, 99);
    const b = getDeploymentMode({}, 1); // would otherwise return launchd; cached result is what matters
    expect(a).toBe("launchd");
    expect(b).toBe(a); // cache hit
  });
});
