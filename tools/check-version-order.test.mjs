import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareSemver, versionOrderError } from "./check-version-order.mjs";

const CLI = fileURLToPath(new URL("./check-version-order.mjs", import.meta.url));

test("a lower version than latest is refused (the #194-after-#199 case)", () => {
  assert.match(versionOrderError("@sprigr/apps-app-sdk", "0.36.0", "0.38.0"), /not newer than npm latest 0\.38\.0/);
});

test("a higher version, or a package with no latest yet, publishes", () => {
  assert.equal(versionOrderError("@sprigr/apps-app-sdk", "0.38.0", "0.36.0"), null);
  assert.equal(versionOrderError("@sprigr/apps-new", "0.1.0", ""), null);
});

test("versions compare numerically, not as strings", () => {
  assert.equal(compareSemver("0.10.0", "0.9.9"), 1);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("0.35.1", "0.40.0"), -1);
});

test("a prerelease ranks below its release and above the previous one", () => {
  assert.equal(compareSemver("0.40.0-rc.1", "0.40.0"), -1);
  assert.equal(compareSemver("0.40.0-rc.1", "0.39.9"), 1);
  assert.equal(compareSemver("0.40.0-rc.10", "0.40.0-rc.2"), 1);
});

test("the CLI exits 1 on a lower version and 0 on a higher one", () => {
  assert.throws(() => execFileSync("node", [CLI, "@sprigr/x", "0.36.0", "0.38.0"], { stdio: "pipe" }), (e) => e.status === 1);
  execFileSync("node", [CLI, "@sprigr/x", "0.39.0", "0.38.0"], { stdio: "pipe" });
});
