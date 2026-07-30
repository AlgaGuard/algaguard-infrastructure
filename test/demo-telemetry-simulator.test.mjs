import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const compose = fs.readFileSync("compose.application.yaml", "utf8");
const cloud = fs.readFileSync("compose.cloud.yaml", "utf8");
const controller = fs.readFileSync("scripts/set-demo-telemetry-simulator.sh", "utf8");
const workflow = fs.readFileSync(".github/workflows/demo-telemetry-simulator.yml", "utf8");

test("simulator is profile-gated and disabled by default", () => {
  assert.match(compose, /profiles: \[demo-simulator\]/);
  assert.match(compose, /ALGAGUARD_ENABLE_DEMO_TELEMETRY_SIMULATOR:-0/);
});

test("simulator uses the immutable Device Service image", () => {
  assert.match(cloud, /demo-telemetry-simulator:[\s\S]*device-service:\$\{DEVICE_SERVICE_SHA\}/);
});

test("simulator has no public port and uses the private telemetry boundary", () => {
  assert.match(compose, /TELEMETRY_SERVICE_URL: http:\/\/telemetry-service:3000/);
  assert.match(compose, /demo-telemetry-simulator:[\s\S]*ports: \[\]/);
});

test("controller is idempotent and exposes only safe states", () => {
  assert.match(controller, /start\|stop\|status/);
  assert.match(controller, /DEMO_SIMULATOR_RUNNING/);
  assert.doesNotMatch(controller, /deviceUuid|organizationId|access_token/);
});

test("workflow uses protected OIDC and SSM control", () => {
  assert.match(workflow, /environment: development/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /aws ssm send-command/);
  assert.doesNotMatch(workflow, /access-key|secret-access-key|ssh /i);
});
