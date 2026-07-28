import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync("aws/development-foundation.yaml", "utf8");
const workflow = readFileSync(
  ".github/workflows/development-deploy.yml",
  "utf8",
);
const cloudNginx = readFileSync("nginx/nginx.cloud.conf", "utf8");
const realm = JSON.parse(
  readFileSync("keycloak/algaguard-development-realm.json", "utf8"),
);

test("development host exposes HTTPS and ACME only without SSH", () => {
  assert.match(template, /FromPort: 80, ToPort: 80/);
  assert.match(template, /FromPort: 443, ToPort: 443/);
  assert.doesNotMatch(template, /FromPort: 22|ToPort: 22/);
  assert.match(template, /Encrypted: true/);
});

test("OIDC trust is repository and protected-environment scoped", () => {
  assert.match(template, /sts:AssumeRoleWithWebIdentity/);
  assert.match(template, /repo:AlgaGuard\/algaguard-infrastructure:environment:development/);
  assert.doesNotMatch(template, /repo:AlgaGuard\/\*:|environment:\*/);
  assert.match(workflow, /environment: development/);
});

test("all application ECR repositories scan and retain bounded images", () => {
  const repositories = template.match(/RepositoryName: algaguard\//g) ?? [];
  const scans = template.match(/ImageScanningConfiguration: \{ScanOnPush: true\}/g) ?? [];
  const lifecycles = template.match(/retain 10/g) ?? [];
  assert.equal(repositories.length, 10);
  assert.equal(scans.length, 10);
  assert.equal(lifecycles.length, 10);
});

test("cloud routes use trusted hostnames and reserve MQTT", () => {
  for (const host of [
    "algaguard.bosilu.dev",
    "api.algaguard.bosilu.dev",
    "auth.algaguard.bosilu.dev",
    "realtime.algaguard.bosilu.dev",
  ]) {
    assert.match(cloudNginx, new RegExp(host.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(cloudNginx, /listen 8883/);
  assert.match(cloudNginx, /TLSv1\.2 TLSv1\.3/);
});

test("development realm enables signup only for approved HTTPS origins", () => {
  assert.equal(realm.registrationAllowed, true);
  const web = realm.clients.find((client) => client.clientId === "algaguard-web");
  assert.ok(web.redirectUris.includes("https://algaguard.bosilu.dev/auth/callback"));
  assert.ok(web.webOrigins.includes("https://algaguard.bosilu.dev"));
});
