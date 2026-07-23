import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/pki.mjs");

function run(directory, ...args) {
  return execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, PKI_DIR: directory },
    encoding: "utf8",
    windowsHide: true,
  });
}

test("development PKI is explicit, non-overwriting, inspectable, and cleanable", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "algaguard-pki-test-"));
  const directory = path.join(parent, "pki");
  try {
    assert.match(run(directory, "init"), /development-only PKI/);
    assert.throws(() => run(directory, "init"));
    run(directory, "server-cert");
    run(directory, "service-cert", "algaguard-mqtt-ingestion-service");
    run(directory, "ota-signing-key");
    run(
      directory,
      "device-cert",
      "AG-000001",
      "10000000-0000-4000-8000-000000000001",
    );
    const inspect = run(directory, "inspect");
    assert.match(inspect, /AlgaGuard Development Device CA/);
    assert.doesNotMatch(inspect, /PRIVATE KEY/);
    assert.doesNotMatch(
      readFileSync(path.join(directory, "emqx", "tls.crt"), "utf8"),
      /PRIVATE KEY/,
    );
    assert.match(
      readFileSync(
        path.join(directory, "ota-signing", "signing-public.pem"),
        "utf8",
      ),
      /PUBLIC KEY/,
    );
    assert.match(
      readFileSync(path.join(directory, "ota-signing", "signing.key"), "utf8"),
      /PRIVATE KEY/,
    );
    execFileSync("openssl", [
      "verify",
      "-CAfile",
      path.join(directory, "device-ca", "ca.crt"),
      path.join(directory, "emqx", "tls.crt"),
    ]);
    if (process.platform !== "win32")
      assert.equal(
        statSync(path.join(directory, "device-ca", "ca.key")).mode & 0o777,
        0o600,
      );
    assert.throws(() => run(directory, "clean-dev"));
    run(directory, "clean-dev", "--confirm");
    assert.equal(existsSync(directory), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
