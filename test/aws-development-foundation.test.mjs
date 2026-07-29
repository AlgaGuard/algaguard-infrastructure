import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync("aws/development-foundation.yaml", "utf8");
const workflow = readFileSync(
  ".github/workflows/development-deploy.yml",
  "utf8",
);
const deploymentScript = readFileSync(
  "scripts/deploy-development.sh",
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
  assert.match(template, /systemctl disable --now sshd/);
});

test("OIDC trust is repository and protected-environment scoped", () => {
  assert.match(template, /sts:AssumeRoleWithWebIdentity/);
  assert.match(
    template,
    /repo:AlgaGuard@305754636\/algaguard-infrastructure@1309235705:environment:development/,
  );
  assert.doesNotMatch(
    template,
    /repo:AlgaGuard\/algaguard-infrastructure:environment:development/,
  );
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
  assert.match(cloudNginx, /listen 127\.0\.0\.1:8081/);
  assert.match(cloudNginx, /location = \/health \{ return 200; \}/);
  assert.match(cloudNginx, /location = \/auth\/callback/);
  assert.match(cloudNginx, /proxy_pass http:\/\/web-dashboard:80\//);
  assert.match(cloudNginx, /proxy_intercept_errors on/);
  assert.match(cloudNginx, /error_page 404 = @web_spa/);
  assert.match(cloudNginx, /location @web_spa/);
  assert.match(cloudNginx, /rewrite \^ \/ break/);
  assert.match(cloudNginx, /"https:\/\/algaguard\.bosilu\.dev" \$http_origin/);
  assert.match(cloudNginx, /Access-Control-Allow-Origin \$dashboard_cors_origin always/);
  assert.match(cloudNginx, /Access-Control-Allow-Headers "Authorization, Content-Type, X-Correlation-ID"/);
  assert.match(cloudNginx, /if \(\$request_method = OPTIONS\)/);
  assert.doesNotMatch(cloudNginx, /Access-Control-Allow-Origin \*/);
});

test("development realm enables signup only for approved HTTPS origins", () => {
  assert.equal(realm.registrationAllowed, true);
  const web = realm.clients.find((client) => client.clientId === "algaguard-web");
  assert.ok(web.redirectUris.includes("https://algaguard.bosilu.dev/auth/callback"));
  assert.ok(web.webOrigins.includes("https://algaguard.bosilu.dev"));
  assert.equal(
    web.attributes["post.logout.redirect.uris"],
    "https://localhost:8443/dashboard##https://algaguard.bosilu.dev/dashboard",
  );
  const mobile = realm.clients.find(
    (client) => client.clientId === "algaguard-mobile",
  );
  for (const client of [web, mobile]) {
    const audience = client.protocolMappers.find(
      (mapper) => mapper.name === "algaguard-api-audience",
    );
    assert.equal(audience.protocolMapper, "oidc-audience-mapper");
    assert.equal(audience.config["included.client.audience"], "algaguard-api");
    assert.equal(audience.config["access.token.claim"], "true");
    assert.equal(audience.config["id.token.claim"], "false");
  }
});

test("cloud dashboard is built only with trusted public endpoints", () => {
  assert.match(workflow, /cat >\.env\.production/);
  assert.match(workflow, /VITE_API_BASE_URL=https:\/\/api\.algaguard\.bosilu\.dev\/v1/);
  assert.match(workflow, /VITE_KEYCLOAK_URL=https:\/\/auth\.algaguard\.bosilu\.dev/);
  assert.match(workflow, /VITE_WEBSOCKET_URL=wss:\/\/realtime\.algaguard\.bosilu\.dev/);
  assert.doesNotMatch(workflow, /VITE_\w+=http:\/\//);
});

test("deployment preserves private-key modes while granting the runtime owner access", () => {
  assert.match(
    deploymentScript,
    /chown -R 1000:1000 \/opt\/algaguard\/runtime\/pki/,
  );
  assert.match(
    deploymentScript,
    /install -d -m 0755 "\$release_dir\/\.local"/,
  );
  assert.match(workflow, /for _ in \$\(seq 1 120\)/);
  assert.doesNotMatch(workflow, /aws ssm wait command-executed/);
  assert.match(deploymentScript, /kcadm\.sh update "clients\/\$client_id"/);
  assert.match(deploymentScript, /-f "\$updated"/);
  assert.match(deploymentScript, /post\.logout\.redirect\.uris/);
  assert.match(deploymentScript, /for public_client in algaguard-web algaguard-mobile/);
  assert.match(deploymentScript, /clients\/\$client_id\/protocol-mappers\/models/);
  assert.match(deploymentScript, /algaguard-api-audience/);
  assert.doesNotMatch(deploymentScript, /--fields attributes/);
  assert.match(
    deploymentScript,
    /trap 'rm -f "\$config" "\$client" "\$updated" "\$mapper" "\$mappers"' EXIT/,
  );
  assert.match(deploymentScript, /systemctl disable --now sshd/);
  assert.match(deploymentScript, /systemctl is-active sshd/);
});
