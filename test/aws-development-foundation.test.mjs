import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const template = readFileSync("aws/development-foundation.yaml", "utf8");
const workflow = readFileSync(
  ".github/workflows/development-deploy.yml",
  "utf8",
);
const deploymentScript = readFileSync("scripts/deploy-development.sh", "utf8");
const recoveryWindowScript = readFileSync(
  "scripts/set-development-recovery-window.sh",
  "utf8",
);
const migrationBackupScript = readFileSync(
  "scripts/backup-development-migration.sh",
  "utf8",
);
const migrationRestoreScript = readFileSync(
  "scripts/restore-development-migration.sh",
  "utf8",
);
const startDevelopmentScript = readFileSync(
  "scripts/start-development.sh",
  "utf8",
);
const compose = readFileSync("compose.yaml", "utf8");
const cloudCompose = readFileSync("compose.cloud.yaml", "utf8");
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

test("development host uses the bounded free-tier compute and storage profile", () => {
  assert.match(
    template,
    /InstanceType: \{Type: String, Default: t3\.micro, AllowedValues: \[t3\.micro\]\}/,
  );
  assert.match(
    template,
    /VolumeType: gp3, VolumeSize: 30, DeleteOnTermination: true/,
  );
  assert.doesNotMatch(template, /t3\.large|VolumeSize: 50/);
});

test("development host creates persistent two GiB swap securely", () => {
  for (const source of [template, deploymentScript]) {
    assert.match(source, /dd if=\/dev\/zero of=\/swapfile bs=1M count=2048/);
    assert.match(source, /chmod 0600 \/swapfile/);
    assert.match(source, /mkswap \/swapfile/);
    assert.match(source, /\/swapfile none swap sw 0 0/);
    assert.match(source, /swapon \/swapfile/);
  }
});

test("volume downsizing uses encrypted migration backup and checked restore", () => {
  assert.match(migrationBackupScript, /systemctl stop docker/);
  assert.match(migrationBackupScript, /var\/lib\/docker\/volumes/);
  assert.match(migrationBackupScript, /opt\/algaguard\/runtime\/pki/);
  assert.match(migrationBackupScript, /etc\/letsencrypt/);
  assert.match(migrationBackupScript, /sha256sum/);
  assert.match(migrationBackupScript, /--sse AES256/);
  assert.match(migrationRestoreScript, /sha256sum --check --status/);
  assert.match(migrationRestoreScript, /rollback_state/);
  assert.match(
    migrationRestoreScript,
    /systemctl start algaguard-development\.service/,
  );
  assert.match(
    deploymentScript,
    /install -m 0755 "\$release_dir\/scripts\/backup-development-migration\.sh"/,
  );
  assert.match(
    deploymentScript,
    /install -m 0755 "\$release_dir\/scripts\/restore-development-migration\.sh"/,
  );
});

test("migration restart waits for application DNS dependencies before NGINX", () => {
  assert.match(startDevelopmentScript, /--wait --wait-timeout 900/);
  assert.match(compose, /keycloak:[\s\S]*start_period: 600s/);
  assert.doesNotMatch(deploymentScript, /--wait-timeout 600/);
  assert.equal(
    [...deploymentScript.matchAll(/--wait-timeout 900/g)].length,
    2,
    "deployment and rollback must both tolerate t3.micro startup latency",
  );
  assert.match(cloudCompose, /api-gateway:\s+condition: service_healthy/);
  assert.match(cloudCompose, /realtime-service:\s+condition: service_healthy/);
  assert.match(cloudCompose, /web-dashboard:\s+condition: service_started/);
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
  const scans =
    template.match(/ImageScanningConfiguration: \{ScanOnPush: true\}/g) ?? [];
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
  assert.match(
    cloudNginx,
    /Access-Control-Allow-Origin \$dashboard_cors_origin always/,
  );
  assert.match(
    cloudNginx,
    /Access-Control-Allow-Headers "Authorization, Content-Type, X-Correlation-ID"/,
  );
  assert.match(cloudNginx, /if \(\$request_method = OPTIONS\)/);
  assert.match(cloudNginx, /proxy_set_header X-Forwarded-Proto https/);
  assert.match(cloudNginx, /proxy_set_header X-Forwarded-Port 443/);
  assert.doesNotMatch(cloudNginx, /Access-Control-Allow-Origin \*/);
});

test("physical session handoff remains default-off and exposes only bounded development routes", () => {
  assert.match(
    cloudCompose,
    /ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF: \$\{ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF:-0\}/,
  );
  assert.match(
    cloudCompose,
    /^\s{6}PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY:\s*$/m,
  );
  assert.doesNotMatch(
    cloudCompose,
    /PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY:\s*\$\{/,
  );
  assert.match(cloudNginx, /zone=physical_session_handoff:1m rate=15r\/m/);
  for (const operation of ["start", "redeem"]) {
    assert.match(
      cloudNginx,
      new RegExp(
        `location = /v1/development/physical-session-handoffs/${operation}`,
      ),
    );
  }
  assert.match(cloudNginx, /limit_except POST \{ deny all; \}/);
  assert.match(cloudNginx, /proxy_set_header Authorization "";/);
  assert.doesNotMatch(cloudNginx, /physical-session-handoffs\/approve/);
});

test("physical handoff key is omitted while disabled and injected only from the runtime env file", () => {
  const directory = mkdtempSync(join(tmpdir(), "algaguard-compose-"));
  const envFile = join(directory, "runtime.env");
  const syntheticKey = Buffer.alloc(32, 7).toString("base64url");
  const composeEnvironment = {
    ...process.env,
    ECR_REGISTRY: "example.invalid",
    ACCESS_SERVICE_SHA: "synthetic",
    DEVICE_SERVICE_SHA: "synthetic",
    PROFILE_SERVICE_SHA: "synthetic",
    TELEMETRY_SERVICE_SHA: "synthetic",
    MQTT_INGESTION_SERVICE_SHA: "synthetic",
    COMMAND_SERVICE_SHA: "synthetic",
    OTA_SERVICE_SHA: "synthetic",
    REALTIME_SERVICE_SHA: "synthetic",
    API_GATEWAY_SHA: "synthetic",
    WEB_DASHBOARD_SHA: "synthetic",
  };
  delete composeEnvironment.PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY;
  delete composeEnvironment.ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF;

  const render = (path) => {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        path,
        "-f",
        "compose.yaml",
        "-f",
        "compose.application.yaml",
        "-f",
        "compose.cloud.yaml",
        "config",
        "--format",
        "json",
      ],
      { cwd: process.cwd(), env: composeEnvironment, encoding: "utf8" },
    );
    assert.equal(result.status, 0, "Compose configuration must render");
    return JSON.parse(result.stdout).services["device-service"].environment;
  };

  try {
    writeFileSync(
      envFile,
      `${readFileSync(".env.example", "utf8")}\nALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF=0\n`,
      { mode: 0o600 },
    );
    const disabled = render(envFile);
    assert.equal(disabled.ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF, "0");
    assert.equal(disabled.PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY, null);

    writeFileSync(
      envFile,
      `${readFileSync(".env.example", "utf8")}\nALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF=1\nPHYSICAL_SESSION_HANDOFF_WRAPPING_KEY=${syntheticKey}\n`,
      { mode: 0o600 },
    );
    const enabled = render(envFile);
    assert.equal(enabled.ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF, "1");
    assert.equal(enabled.PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY, syntheticKey);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owned-device bootstrap reissue remains development-only and default-off", () => {
  assert.match(
    cloudCompose,
    /ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE: \$\{ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE:-0\}/,
  );
  assert.doesNotMatch(
    cloudCompose,
    /ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE:\s*1/,
  );
});

test("development recovery window is bounded, exclusive, and removes its wrapping key", () => {
  assert.match(
    recoveryWindowScript,
    /enable-reissue\|enable-handoff\|disable-all\|status/,
  );
  assert.match(recoveryWindowScript, /flock -x/);
  assert.match(recoveryWindowScript, /chmod 0600 "\$env_file"/);
  assert.match(recoveryWindowScript, /openssl rand -base64 32/);
  assert.match(
    recoveryWindowScript,
    /ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE=1/,
  );
  assert.match(
    recoveryWindowScript,
    /ALGAGUARD_ENABLE_PHYSICAL_SESSION_HANDOFF=1/,
  );
  assert.match(recoveryWindowScript, /PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY/);
  assert.match(
    recoveryWindowScript,
    /ALGAGUARD_DEVELOPMENT_ONBOARDING_WINDOW_SECONDS=900/,
  );
  assert.match(
    cloudCompose,
    /ALGAGUARD_DEVELOPMENT_ONBOARDING_WINDOW_SECONDS:/,
  );
  assert.match(
    recoveryWindowScript,
    /development_onboarding_window_configured=(true|false)/,
  );
  assert.match(recoveryWindowScript, /--force-recreate --wait/);
  assert.doesNotMatch(recoveryWindowScript, /echo.*wrapping_key/);
  assert.match(
    workflow,
    /options:\s*\[full-deploy, enable-reissue, enable-handoff, disable-all, status\]/,
  );
  assert.match(workflow, /if: inputs\.recovery_action != 'full-deploy'/);
  assert.match(workflow, /set-development-recovery-window\.sh \$ACTION/);
  assert.match(workflow, /environment: development/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /AWS-RunShellScript/);
});

test("development onboarding timing is default-off and shared by both recovery modes", () => {
  assert.doesNotMatch(
    cloudCompose,
    /ALGAGUARD_DEVELOPMENT_ONBOARDING_WINDOW_SECONDS:\s*900/,
  );
  assert.equal(
    recoveryWindowScript.match(
      /ALGAGUARD_DEVELOPMENT_ONBOARDING_WINDOW_SECONDS=900/g,
    )?.length,
    2,
  );
});

test("disable cleanup removes timing and secret material from the runtime environment", () => {
  const filter = recoveryWindowScript.slice(
    recoveryWindowScript.indexOf("awk -F="),
    recoveryWindowScript.lastIndexOf('case "$action" in'),
  );
  assert.match(filter, /ALGAGUARD_DEVELOPMENT_ONBOARDING_WINDOW_SECONDS/);
  assert.match(filter, /PHYSICAL_SESSION_HANDOFF_WRAPPING_KEY/);
});

test("failed recovery transitions restore the previous mode-0600 environment", () => {
  assert.match(recoveryWindowScript, /rollback_on_failure/);
  assert.match(recoveryWindowScript, /cp -- "\$original" "\$env_file"/);
  assert.match(recoveryWindowScript, /chmod 0600 "\$env_file"/);
  assert.match(recoveryWindowScript, /trap rollback_on_failure EXIT/);
});

test("recovery controls expose only safe booleans and never print the wrapping key", () => {
  assert.match(
    recoveryWindowScript,
    /development_onboarding_window_configured=true/,
  );
  assert.doesNotMatch(recoveryWindowScript, /printf '%s\\n' "\$wrapping_key"/);
  assert.doesNotMatch(recoveryWindowScript, /echo.*wrapping_key/);
});

test("public OIDC metadata remains HTTPS behind the trusted proxy", () => {
  assert.match(compose, /KC_PROXY_HEADERS: xforwarded/);
  for (const endpoint of [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "userinfo_endpoint",
    "end_session_endpoint",
    "jwks_uri",
  ]) {
    assert.match(deploymentScript, new RegExp(`\\.${endpoint}`));
  }
  assert.match(deploymentScript, /startswith\("https:\/\/"\)/);
});

test("development realm enables signup only for approved HTTPS origins", () => {
  assert.equal(realm.registrationAllowed, true);
  const web = realm.clients.find(
    (client) => client.clientId === "algaguard-web",
  );
  assert.deepEqual(web.redirectUris, [
    "https://localhost:8443/*",
    "https://algaguard.bosilu.dev/*",
  ]);
  assert.ok(web.webOrigins.includes("https://algaguard.bosilu.dev"));
  assert.equal(
    web.attributes["post.logout.redirect.uris"],
    "https://localhost:8443/dashboard##https://algaguard.bosilu.dev/dashboard",
  );
  const mobile = realm.clients.find(
    (client) => client.clientId === "algaguard-mobile",
  );
  assert.deepEqual(mobile.redirectUris, [
    "com.algaguard.mobile:/oauthredirect",
  ]);
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
  assert.match(
    workflow,
    /VITE_API_BASE_URL=https:\/\/api\.algaguard\.bosilu\.dev\/v1/,
  );
  assert.match(
    workflow,
    /VITE_KEYCLOAK_URL=https:\/\/auth\.algaguard\.bosilu\.dev/,
  );
  assert.match(
    workflow,
    /VITE_WEBSOCKET_URL=wss:\/\/realtime\.algaguard\.bosilu\.dev\/realtime/,
  );
  assert.match(
    workflow,
    /PUBLIC_WSS_URL=wss:\/\/realtime\.algaguard\.bosilu\.dev\/realtime/,
  );
  assert.doesNotMatch(workflow, /VITE_\w+=http:\/\//);
});

test("deployment preserves private-key modes while granting the runtime owner access", () => {
  assert.match(
    deploymentScript,
    /chown -R 1000:1000 \/opt\/algaguard\/runtime\/pki/,
  );
  assert.match(deploymentScript, /install -d -m 0755 "\$release_dir\/\.local"/);
  assert.match(workflow, /for _ in \$\(seq 1 120\)/);
  assert.doesNotMatch(workflow, /aws ssm wait command-executed/);
  assert.match(deploymentScript, /kcadm\.sh update "clients\/\$client_id"/);
  assert.match(deploymentScript, /-f "\$updated"/);
  assert.match(deploymentScript, /post\.logout\.redirect\.uris/);
  assert.match(
    deploymentScript,
    /redirectUris=\["https:\/\/localhost:8443\/\*","https:\/\/algaguard\.bosilu\.dev\/\*"\]/,
  );
  assert.match(deploymentScript, /clientId=algaguard-mobile/);
  assert.match(
    deploymentScript,
    /redirectUris=\["com\.algaguard\.mobile:\/oauthredirect"\]/,
  );
  assert.match(
    deploymentScript,
    /for public_client in algaguard-web algaguard-mobile/,
  );
  assert.match(
    deploymentScript,
    /clients\/\$client_id\/protocol-mappers\/models/,
  );
  assert.match(deploymentScript, /algaguard-api-audience/);
  assert.doesNotMatch(deploymentScript, /--fields attributes/);
  assert.match(
    deploymentScript,
    /trap 'rm -f "\$config" "\$client" "\$updated" "\$mapper" "\$mappers"' EXIT/,
  );
  assert.match(deploymentScript, /systemctl disable --now sshd/);
  assert.match(deploymentScript, /systemctl is-active sshd/);
});
