import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/render-emqx-config.mjs");

function run(filePath, token) {
  return execFileSync(process.execPath, [script, filePath], {
    env: { ...process.env, BROKER_DEVICE_AUTH_TOKEN: token },
    encoding: "utf8",
    windowsHide: true,
  });
}

test("the broker token placeholder is substituted everywhere it appears, literally", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "algaguard-render-test-"));
  try {
    const filePath = path.join(directory, "base.hocon");
    writeFileSync(
      filePath,
      'authorization = "Bearer __BROKER_DEVICE_AUTH_TOKEN__"\n' +
        'other = "Bearer __BROKER_DEVICE_AUTH_TOKEN__"\n',
    );
    run(filePath, "s3cr3t-token");
    const rendered = readFileSync(filePath, "utf8");
    assert.equal(
      rendered,
      'authorization = "Bearer s3cr3t-token"\n' +
        'other = "Bearer s3cr3t-token"\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a token containing regex/replacement metacharacters is substituted literally, not interpreted", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "algaguard-render-test-"));
  try {
    const filePath = path.join(directory, "base.hocon");
    writeFileSync(filePath, "value = __BROKER_DEVICE_AUTH_TOKEN__\n");
    run(filePath, "has$&special\\chars/and.dots+plus");
    assert.equal(
      readFileSync(filePath, "utf8"),
      "value = has$&special\\chars/and.dots+plus\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing placeholder fails loudly instead of silently doing nothing", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "algaguard-render-test-"));
  try {
    const filePath = path.join(directory, "base.hocon");
    writeFileSync(filePath, "value = already-rendered\n");
    assert.throws(() => run(filePath, "token"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing token fails loudly instead of rendering the literal word 'undefined'", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "algaguard-render-test-"));
  try {
    const filePath = path.join(directory, "base.hocon");
    writeFileSync(filePath, "value = __BROKER_DEVICE_AUTH_TOKEN__\n");
    assert.throws(() =>
      execFileSync(process.execPath, [script, filePath], {
        env: { ...process.env, BROKER_DEVICE_AUTH_TOKEN: "" },
        encoding: "utf8",
        windowsHide: true,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
