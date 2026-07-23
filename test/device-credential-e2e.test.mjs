import assert from "node:assert/strict";
import {
  createHash,
  randomUUID,
  sign as signBytes,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import mqtt from "mqtt";
import { Client as MinioClient } from "minio";

const urls = {
  access: "http://127.0.0.1:3001/v1",
  device: "http://127.0.0.1:3002/v1",
  profile: "http://127.0.0.1:3003/v1",
  command: "http://127.0.0.1:3006/v1",
  ota: "http://127.0.0.1:3007/v1",
  realtime: "http://127.0.0.1:3008/v1",
  keycloak: "http://127.0.0.1:8081",
};
const composePrefix = [
  "compose",
  "--env-file",
  ".env.example",
  "-f",
  "compose.yaml",
  "-f",
  "compose.application.yaml",
];
const localRoot = path.resolve(".local");
const pkiRoot = path.join(localRoot, "pki");
const testRoot = path.join(localRoot, "credential-e2e");
const evidenceRoot = path.join(localRoot, "evidence");
const deviceCa = readFileSync(path.join(pkiRoot, "device-ca", "ca.crt"));

function openssl(args) {
  execFileSync(process.env.OPENSSL ?? "openssl", args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

function compose(args, capture = false) {
  return execFileSync("docker", [...composePrefix, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  });
}

function sql(statement) {
  return compose(
    [
      "exec",
      "-T",
      "timescaledb",
      "psql",
      "-U",
      "algaguard",
      "-d",
      "algaguard",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-c",
      statement,
    ],
    true,
  ).trim();
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function json(url, options = {}, expected = 200) {
  const { token, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...requestOptions.headers,
    },
  });
  const body = await responseBody(response);
  assert.equal(response.status, expected, `${url}: ${JSON.stringify(body)}`);
  return body;
}

async function form(url, values, expected = 200) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
  const body = await responseBody(response);
  assert.equal(response.status, expected, `${url}: ${JSON.stringify(body)}`);
  return body;
}

function tokenSubject(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;
}

async function createUser(adminToken, suffix) {
  const username = `credential-${suffix}`;
  await json(
    `${urls.keycloak}/admin/realms/algaguard/users`,
    {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({
        username,
        email: `${username}@example.invalid`,
        emailVerified: true,
        firstName: "Credential",
        lastName: "E2E",
        enabled: true,
        credentials: [
          {
            type: "password",
            value: "development-e2e-only",
            temporary: false,
          },
        ],
      }),
    },
    201,
  );
  const login = await form(
    `${urls.keycloak}/realms/algaguard/protocol/openid-connect/token`,
    {
      grant_type: "password",
      client_id: "algaguard-e2e",
      username,
      password: "development-e2e-only",
    },
  );
  return {
    token: login.access_token,
    subjectId: tokenSubject(login.access_token),
  };
}

async function clientToken(clientId, clientSecret) {
  const value = await form(
    `${urls.keycloak}/realms/algaguard/protocol/openid-connect/token`,
    {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    },
  );
  return value.access_token;
}

function generateCsr(directory, deviceId, deviceUuid) {
  mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, "device.key");
  const csrPath = path.join(directory, "device.csr");
  openssl([
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    keyPath,
  ]);
  openssl([
    "req",
    "-new",
    "-key",
    keyPath,
    "-subj",
    `/CN=${deviceId}`,
    "-addext",
    `subjectAltName=URI:urn:algaguard:device:${deviceUuid}`,
    "-out",
    csrPath,
  ]);
  return { keyPath, csrPem: readFileSync(csrPath, "utf8") };
}

function signUnknownCertificate(directory, deviceId, deviceUuid, days = "397") {
  const { keyPath, csrPem } = generateCsr(directory, deviceId, deviceUuid);
  const csrPath = path.join(directory, "device.csr");
  const certificatePath = path.join(directory, "device.crt");
  const extensionsPath = path.join(directory, "device.ext");
  writeFileSync(
    extensionsPath,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyAgreement",
      "extendedKeyUsage=clientAuth",
      `subjectAltName=URI:urn:algaguard:device:${deviceUuid}`,
      "",
    ].join("\n"),
  );
  openssl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    path.join(pkiRoot, "device-ca", "ca.crt"),
    "-CAkey",
    path.join(pkiRoot, "device-ca", "ca.key"),
    "-CAserial",
    path.join(pkiRoot, "device-ca", "ca.srl"),
    "-days",
    days,
    "-sha256",
    "-extfile",
    extensionsPath,
    "-out",
    certificatePath,
  ]);
  assert.match(csrPem, /CERTIFICATE REQUEST/);
  return { keyPath, certificatePath };
}

function selfSignedCertificate(directory, deviceId, deviceUuid) {
  const { keyPath } = generateCsr(directory, deviceId, deviceUuid);
  const certificatePath = path.join(directory, "device.crt");
  openssl([
    "req",
    "-new",
    "-x509",
    "-key",
    keyPath,
    "-days",
    "397",
    "-subj",
    `/CN=${deviceId}`,
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "extendedKeyUsage=clientAuth",
    "-addext",
    `subjectAltName=URI:urn:algaguard:device:${deviceUuid}`,
    "-out",
    certificatePath,
  ]);
  return { keyPath, certificatePath };
}

function mqttOptions(deviceId, certificatePath, keyPath) {
  return {
    clientId: deviceId,
    ca: deviceCa,
    cert: readFileSync(certificatePath),
    key: readFileSync(keyPath),
    servername: "localhost",
    rejectUnauthorized: true,
    protocolVersion: 5,
    clean: false,
    reconnectPeriod: 0,
    connectTimeout: 5_000,
    keepalive: 30,
    properties: { sessionExpiryInterval: 60 },
  };
}

async function connectDevice(deviceId, certificatePath, keyPath) {
  return mqtt.connectAsync(
    "mqtts://127.0.0.1:8883",
    mqttOptions(deviceId, certificatePath, keyPath),
  );
}

async function expectMqttRejected(options, label) {
  let client;
  try {
    client = await mqtt.connectAsync("mqtts://127.0.0.1:8883", {
      ...options,
      reconnectPeriod: 0,
      connectTimeout: 5_000,
    });
  } catch {
    return;
  }
  await client.endAsync().catch(() => undefined);
  assert.fail(`${label} unexpectedly connected`);
}

async function expectSubscriptionDenied(client, topic, label) {
  let denied = false;
  try {
    const grants = await client.subscribeAsync(topic, { qos: 1 });
    denied = grants.length > 0 && grants.every((grant) => grant.qos === 128);
  } catch {
    denied = true;
  }
  assert.equal(denied, true, `${label} subscription must be denied`);
}

function mqttMessage(client, topic, predicate = () => true, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const listener = (receivedTopic, payload) => {
      if (receivedTopic !== topic) return;
      const value = JSON.parse(payload.toString());
      if (!predicate(value)) return;
      clearTimeout(timer);
      client.off("message", listener);
      resolve(value);
    };
    const timer = setTimeout(() => {
      client.off("message", listener);
      reject(new Error(`Timed out waiting for ${topic}`));
    }, timeoutMs);
    client.on("message", listener);
  });
}

async function expectNoMqttMessage(client, topic, action, timeoutMs = 1_500) {
  const possible = mqttMessage(client, topic, () => true, timeoutMs)
    .then(() => true)
    .catch((error) => {
      if (error instanceof Error && error.message.includes("Timed out"))
        return false;
      throw error;
    });
  await action();
  assert.equal(await possible, false, `unexpected MQTT message on ${topic}`);
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ""}`);
}

function telemetryEnvelope(deviceId, sequence, profileId, overrides = {}) {
  const messageId = overrides.messageId ?? randomUUID();
  const batchId = overrides.batchId ?? randomUUID();
  return {
    schema: "urn:algaguard:schema:mqtt:telemetry-batch:v1",
    schemaVersion: "1.0.0",
    messageId,
    deviceId,
    sentAt: new Date().toISOString(),
    payload: {
      batchId,
      firstSequence: String(sequence),
      lastSequence: String(sequence),
      sampleCount: 1,
      activeProfile: { profileId, profileVersion: "1.0.0" },
      samples: [
        {
          sequence: String(sequence),
          observedAt: new Date().toISOString(),
          timestampQuality: "NTP_SYNCED",
          uptimeMs: String(sequence * 1_000),
          values: { temperatureC: 24.2, ph: 7.1, lightLux: 800 },
        },
      ],
      isReplay: false,
      createdFromSd: false,
    },
  };
}

async function openRealtime(token) {
  const ticket = await json(
    `${urls.realtime}/tickets`,
    { method: "POST", token, body: "{}" },
    201,
  );
  const socket = new WebSocket(
    `ws://127.0.0.1:3008/realtime?ticket=${ticket.ticket}`,
  );
  await Promise.race([
    once(socket, "open"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000),
    ),
  ]);
  return socket;
}

function websocketMessage(socket, predicate, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      const value = JSON.parse(event.data.toString());
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("Timed out waiting for WebSocket event"));
    }, timeoutMs);
    socket.addEventListener("message", listener);
  });
}

async function subscribeRealtime(socket, deviceUuid) {
  const requestId = randomUUID();
  const ack = websocketMessage(
    socket,
    (value) => value.requestId === requestId && Array.isArray(value.accepted),
  );
  socket.send(
    JSON.stringify({
      schema: "algaguard.websocket.subscribe",
      schemaVersion: "1.0.0",
      requestId,
      subscriptions: [
        {
          resourceType: "device",
          resourceId: deviceUuid,
          events: ["telemetry.updated"],
        },
      ],
    }),
  );
  const value = await ack;
  assert.equal(value.accepted.length, 1);
}

async function provisionDevice(user, organizationId, label) {
  const device = await json(
    `${urls.device}/devices`,
    {
      method: "POST",
      token: user.token,
      body: JSON.stringify({
        organizationId,
        hardwareModel: "ESP32-S3-N16R8",
      }),
    },
    201,
  );
  const setup = await json(
    `${urls.device}/devices/${device.deviceUuid}/setup`,
    {
      method: "POST",
      token: user.token,
      body: JSON.stringify({ expiresInSeconds: 600 }),
    },
    201,
  );
  await json(`${urls.device}/claims/consume`, {
    method: "POST",
    token: user.token,
    body: JSON.stringify({ organizationId, qr: setup }),
  });
  const bootstrap = await json(
    `${urls.device}/devices/${device.deviceUuid}/credential-bootstrap`,
    { method: "POST", token: user.token, body: "{}" },
    201,
  );
  const directory = path.join(testRoot, label, "initial");
  const generated = generateCsr(directory, device.deviceId, device.deviceUuid);
  const issuance = await json(
    `${urls.device}/device-credential-bootstrap/issue`,
    {
      method: "POST",
      token: bootstrap.bootstrapToken,
      body: JSON.stringify({
        schema:
          "urn:algaguard:schema:onboarding:credential-csr-submission:v1",
        schemaVersion: "1.0.0",
        deviceUuid: device.deviceUuid,
        deviceId: device.deviceId,
        purpose: "INITIAL",
        rotationId: null,
        idempotencyKey: randomUUID(),
        keyAlgorithm: "EC_P256",
        csrPem: generated.csrPem,
      }),
    },
    201,
  );
  const certificatePath = path.join(directory, "device.crt");
  writeFileSync(certificatePath, issuance.credential.certificatePem);
  assert.equal(issuance.credential.deviceId, device.deviceId);
  assert.equal(issuance.credential.deviceUuid, device.deviceUuid);
  assert.equal(issuance.credential.status, "ACTIVE");
  assert.equal("privateKey" in issuance, false);
  return {
    ...device,
    certificatePath,
    keyPath: generated.keyPath,
    certificatePem: issuance.credential.certificatePem,
    credential: issuance.credential,
  };
}

test(
  "production device credentials enforce mTLS, exact ACL, durable rotation, revocation, and service flows",
  { timeout: 360_000 },
  async () => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const startedAt = performance.now();
    const timings = {};
    const mark = (name) => {
      timings[name] = Math.round(performance.now() - startedAt);
    };
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const clients = new Set();
    let socket;
    try {
      const admin = await form(
        `${urls.keycloak}/realms/master/protocol/openid-connect/token`,
        {
          grant_type: "password",
          client_id: "admin-cli",
          username: "admin",
          password: "development-only-change-me",
        },
      );
      const user = await createUser(admin.access_token, suffix);
      const organization = await json(
        `${urls.access}/organizations`,
        {
          method: "POST",
          token: user.token,
          body: JSON.stringify({ name: `Credential E2E ${suffix}` }),
        },
        201,
      );
      const primary = await provisionDevice(user, organization.id, "primary");
      const secondary = await provisionDevice(
        user,
        organization.id,
        "secondary",
      );
      const inactive = await provisionDevice(
        user,
        organization.id,
        "inactive",
      );
      const ingestionToken = await clientToken(
        "algaguard-mqtt-ingestion-service",
        "replace-with-mqtt-ingestion-service-secret",
      );
      mark("provisioning_ms");

      await expectMqttRejected(
        {
          clientId: primary.deviceId,
          ca: deviceCa,
          servername: "localhost",
          rejectUnauthorized: true,
          protocolVersion: 5,
        },
        "client without certificate",
      );
      const wrongCa = selfSignedCertificate(
        path.join(testRoot, "wrong-ca"),
        "AG-888888",
        randomUUID(),
      );
      await expectMqttRejected(
        mqttOptions("AG-888888", wrongCa.certificatePath, wrongCa.keyPath),
        "client signed by wrong CA",
      );
      const unknown = signUnknownCertificate(
        path.join(testRoot, "unknown"),
        "AG-999999",
        randomUUID(),
      );
      await expectMqttRejected(
        mqttOptions("AG-999999", unknown.certificatePath, unknown.keyPath),
        "unknown certificate",
      );
      const expired = signUnknownCertificate(
        path.join(testRoot, "expired"),
        "AG-999998",
        randomUUID(),
        "0",
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expectMqttRejected(
        mqttOptions("AG-999998", expired.certificatePath, expired.keyPath),
        "expired certificate",
      );
      await expectMqttRejected(
        mqttOptions(
          secondary.deviceId,
          primary.certificatePath,
          primary.keyPath,
        ),
        "certificate and client identifier mismatch",
      );
      mark("negative_auth_ms");

      let primaryMqtt = await connectDevice(
        primary.deviceId,
        primary.certificatePath,
        primary.keyPath,
      );
      let secondaryMqtt = await connectDevice(
        secondary.deviceId,
        secondary.certificatePath,
        secondary.keyPath,
      );
      let inactiveMqtt = await connectDevice(
        inactive.deviceId,
        inactive.certificatePath,
        inactive.keyPath,
      );
      clients.add(primaryMqtt);
      clients.add(secondaryMqtt);
      clients.add(inactiveMqtt);
      const authenticationMetrics = await json(
        `${urls.device}/internal/device-credentials/metrics`,
        { token: ingestionToken },
      );
      assert.ok(authenticationMetrics.mtlsAccepted >= 3);
      assert.ok(authenticationMetrics.credentialMismatch >= 1);
      const primaryRoot = `algaguard/v1/devices/${primary.deviceId}`;
      const secondaryRoot = `algaguard/v1/devices/${secondary.deviceId}`;
      for (const topic of [
        `${primaryRoot}/telemetry/ack`,
        `${primaryRoot}/commands`,
        `${primaryRoot}/ota`,
      ]) {
        const grants = await primaryMqtt.subscribeAsync(topic, { qos: 1 });
        assert.equal(grants[0]?.qos, 1);
      }
      const secondaryAck = `${secondaryRoot}/telemetry/ack`;
      assert.equal(
        (await secondaryMqtt.subscribeAsync(secondaryAck, { qos: 1 }))[0]?.qos,
        1,
      );
      let crossDenied = false;
      try {
        const grants = await secondaryMqtt.subscribeAsync(
          `${primaryRoot}/telemetry/ack`,
          {
            qos: 1,
          },
        );
        crossDenied = grants.some((grant) => grant.qos === 128);
      } catch {
        crossDenied = true;
      }
      assert.equal(crossDenied, true, "cross-device subscribe must be denied");
      for (const [topic, label] of [
        [`${secondaryRoot}/#`, "device wildcard"],
        [`algaguard/v1/organizations/${organization.id}/#`, "organization"],
        ["algaguard/v1/internal/#", "internal"],
        ["algaguard/v1/management/#", "management"],
        ["$CONTROL/#", "broker management"],
        ["$SYS/#", "broker system"],
      ]) {
        await expectSubscriptionDenied(secondaryMqtt, topic, label);
      }

      const profile = await json(
        `${urls.profile}/profiles`,
        {
          method: "POST",
          token: user.token,
          body: JSON.stringify({
            organizationId: organization.id,
            name: `Credential profile ${suffix}`,
            configuration: {
              samplingSeconds: 30,
              targetTemperatureC: 24,
            },
          }),
        },
        201,
      );
      const assignment = await json(
        `${urls.profile}/devices/${primary.deviceId}/profile-assignment`,
        {
          method: "PUT",
          token: user.token,
          body: JSON.stringify({
            organizationId: organization.id,
            profileId: profile.profileId,
            version: 1,
          }),
        },
      );
      assert.equal(assignment.deviceId, primary.deviceId);

      socket = await openRealtime(user.token);
      await subscribeRealtime(socket, primary.deviceUuid);
      const realtimeEvent = websocketMessage(
        socket,
        (value) =>
          value.eventType === "telemetry.updated" &&
          value.deviceUuid === primary.deviceUuid,
      );
      const telemetry = telemetryEnvelope(primary.deviceId, 1, profile.profileId);
      const acknowledgement = mqttMessage(
        primaryMqtt,
        `${primaryRoot}/telemetry/ack`,
        (value) => value.payload?.batchId === telemetry.payload.batchId,
      );
      await primaryMqtt.publishAsync(
        `${primaryRoot}/telemetry`,
        JSON.stringify(telemetry),
        { qos: 1 },
      );
      const ack = await acknowledgement;
      assert.equal(ack.deviceId, primary.deviceId);
      assert.equal((await realtimeEvent).deviceUuid, primary.deviceUuid);

      const crossTelemetry = telemetryEnvelope(
        primary.deviceId,
        1,
        profile.profileId,
      );
      let crossPublishDenied = false;
      await expectNoMqttMessage(
        primaryMqtt,
        `${primaryRoot}/telemetry/ack`,
        async () => {
          try {
            await secondaryMqtt.publishAsync(
              `${primaryRoot}/telemetry`,
              JSON.stringify(crossTelemetry),
              { qos: 1 },
            );
          } catch (error) {
            crossPublishDenied = error?.code === 135;
          }
        },
      );
      assert.equal(
        crossPublishDenied,
        true,
        "cross-device publish must receive MQTT Not authorized",
      );

      mark("telemetry_acl_realtime_ms");

      const commandId = randomUUID();
      const commandMessage = mqttMessage(
        primaryMqtt,
        `${primaryRoot}/commands`,
        (value) => value.payload?.commandId === commandId,
      );
      await json(
        `${urls.command}/devices/${primary.deviceId}/commands`,
        {
          method: "POST",
          token: user.token,
          body: JSON.stringify({
            commandId,
            commandType: "REQUEST_STATUS",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            parameters: {},
          }),
        },
        202,
      );
      const deliveredCommand = await commandMessage;
      assert.equal(deliveredCommand.deviceId, primary.deviceId);
      await primaryMqtt.publishAsync(
        `${primaryRoot}/command-results`,
        JSON.stringify({
          schema: "urn:algaguard:schema:mqtt:command-result:v1",
          schemaVersion: "1.0.0",
          messageId: randomUUID(),
          deviceId: primary.deviceId,
          sentAt: new Date().toISOString(),
          payload: {
            commandId,
            status: "SUCCEEDED",
            reportedAt: new Date().toISOString(),
            progressPercent: 100,
            result: { statusReported: true },
          },
        }),
        { qos: 1 },
      );
      await waitFor(
        async () =>
          (
            await json(`${urls.command}/commands/${commandId}`, {
              token: user.token,
            })
          ).status === "SUCCEEDED",
        "command result persistence",
      );
      mark("command_ms");

      const artifact = Buffer.from(
        `AlgaGuard credential sprint artifact ${suffix}\n`,
      );
      const objectKey = `firmware/credential-e2e-${suffix}.bin`;
      const minio = new MinioClient({
        endPoint: "127.0.0.1",
        port: 9000,
        useSSL: false,
        accessKey: "algaguard-development",
        secretKey: "development-only-change-me",
      });
      await minio.putObject("algaguard-ota-development", objectKey, artifact);
      const signature = signBytes(
        "sha256",
        artifact,
        readFileSync(path.join(pkiRoot, "ota-signing", "signing.key")),
      ).toString("base64");
      const releaseId = randomUUID();
      const releaseToken = await clientToken(
        "algaguard-firmware-release",
        "replace-with-firmware-release-secret",
      );
      await json(
        `${urls.ota}/firmware/releases`,
        {
          method: "POST",
          token: releaseToken,
          body: JSON.stringify({
            releaseId,
            version: "1.0.0",
            hardwareModel: primary.hardwareModel,
            objectKey,
            sizeBytes: artifact.length,
            sha256: createHash("sha256").update(artifact).digest("hex"),
            signature,
            signatureAlgorithm: "ECDSA_P256_SHA256",
          }),
        },
        201,
      );
      const otaMessage = mqttMessage(
        primaryMqtt,
        `${primaryRoot}/ota`,
        (value) => value.payload?.releaseId === releaseId,
      );
      await json(
        `${urls.ota}/ota/rollouts`,
        {
          method: "POST",
          token: user.token,
          body: JSON.stringify({
            releaseId,
            rolloutRing: "DEVELOPMENT",
            deviceIds: [primary.deviceId],
          }),
        },
        201,
      );
      const deliveredOta = await otaMessage;
      assert.equal(deliveredOta.deviceId, primary.deviceId);
      assert.match(deliveredOta.payload.downloadUrl, /^http/);
      const otaAssignment = await json(
        `${urls.ota}/devices/${primary.deviceId}/assignment`,
        { token: user.token },
      );
      await primaryMqtt.publishAsync(
        `${primaryRoot}/ota/status`,
        JSON.stringify({
          schema: "urn:algaguard:schema:mqtt:ota-status:v1",
          schemaVersion: "1.0.0",
          messageId: randomUUID(),
          deviceId: primary.deviceId,
          sentAt: new Date().toISOString(),
          payload: {
            assignmentId: otaAssignment.assignment.assignmentId,
            releaseId,
            status: "VERIFIED",
            progressPercent: 100,
            downloadedBytes: artifact.length,
            reportedAt: new Date().toISOString(),
            runningVersion: primary.firmwareVersion,
          },
        }),
        { qos: 1 },
      );
      mark("ota_ms");

      await secondaryMqtt.endAsync();
      clients.delete(secondaryMqtt);
      const compromised = await json(
        `${urls.device}/devices/${secondary.deviceUuid}/credentials/${secondary.credential.credentialId}/revocation`,
        {
          method: "POST",
          token: user.token,
          body: JSON.stringify({ reason: "COMPROMISED" }),
        },
      );
      assert.equal(compromised.status, "COMPROMISED");
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await expectMqttRejected(
        mqttOptions(
          secondary.deviceId,
          secondary.certificatePath,
          secondary.keyPath,
        ),
        "compromised credential",
      );

      await inactiveMqtt.endAsync();
      clients.delete(inactiveMqtt);
      sql(
        `UPDATE devices SET lifecycle='INACTIVE' WHERE device_uuid='${inactive.deviceUuid}'`,
      );
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await expectMqttRejected(
        mqttOptions(
          inactive.deviceId,
          inactive.certificatePath,
          inactive.keyPath,
        ),
        "credential belonging to inactive device",
      );
      mark("negative_credential_state_ms");

      const rotation = await json(
        `${urls.device}/devices/${primary.deviceUuid}/credential-rotations`,
        {
          method: "POST",
          token: user.token,
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            reason: "SCHEDULED",
            overlapSeconds: 60,
          }),
        },
        202,
      );
      const rotationDirectory = path.join(testRoot, "primary", "rotation");
      const replacement = generateCsr(
        rotationDirectory,
        primary.deviceId,
        primary.deviceUuid,
      );
      const rotationIssuance = await json(
        `${urls.device}/internal/device-credential-rotations/${rotation.rotationId}/issue`,
        {
          method: "POST",
          token: ingestionToken,
          body: JSON.stringify({
            currentCertificatePem: primary.certificatePem,
            idempotencyKey: randomUUID(),
            keyAlgorithm: "EC_P256",
            csrPem: replacement.csrPem,
          }),
        },
        201,
      );
      const replacementCertificatePath = path.join(
        rotationDirectory,
        "device.crt",
      );
      writeFileSync(
        replacementCertificatePath,
        rotationIssuance.credential.certificatePem,
      );
      const replacementMqtt = await connectDevice(
        primary.deviceId,
        replacementCertificatePath,
        replacement.keyPath,
      );
      clients.add(replacementMqtt);
      await json(
        `${urls.device}/internal/device-credential-rotations/${rotation.rotationId}/acknowledgement`,
        {
          method: "POST",
          token: ingestionToken,
          body: JSON.stringify({
            newCredentialId: rotationIssuance.credential.credentialId,
            result: "CONNECTED",
          }),
        },
      );
      await primaryMqtt.endAsync().catch(() => undefined);
      clients.delete(primaryMqtt);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await expectMqttRejected(
        mqttOptions(
          primary.deviceId,
          primary.certificatePath,
          primary.keyPath,
        ),
        "rotated predecessor certificate",
      );
      const rotationMetrics = await json(
        `${urls.device}/internal/device-credentials/metrics`,
        { token: ingestionToken },
      );
      assert.ok(rotationMetrics.revokedOrExpired >= 1);
      mark("rotation_ms");

      await replacementMqtt.endAsync();
      clients.delete(replacementMqtt);
      compose([
        "restart",
        "device-service",
        "emqx",
        "mqtt-ingestion-service",
        "command-service",
        "ota-service",
      ]);
      compose([
        "up",
        "-d",
        "--wait",
        "device-service",
        "emqx",
        "mqtt-ingestion-service",
        "command-service",
        "ota-service",
      ]);
      primaryMqtt = await connectDevice(
        primary.deviceId,
        replacementCertificatePath,
        replacement.keyPath,
      );
      clients.add(primaryMqtt);
      assert.equal(
        (
          await primaryMqtt.subscribeAsync(`${primaryRoot}/telemetry/ack`, {
            qos: 1,
          })
        )[0]?.qos,
        1,
      );
      const afterRestart = telemetryEnvelope(
        primary.deviceId,
        2,
        profile.profileId,
      );
      const restartAck = mqttMessage(
        primaryMqtt,
        `${primaryRoot}/telemetry/ack`,
        (value) => value.payload?.batchId === afterRestart.payload.batchId,
      );
      await primaryMqtt.publishAsync(
        `${primaryRoot}/telemetry`,
        JSON.stringify(afterRestart),
        { qos: 1 },
      );
      await restartAck;
      mark("restart_recovery_ms");

      const revocation = await json(
        `${urls.device}/devices/${primary.deviceUuid}/credentials/${rotationIssuance.credential.credentialId}/revocation`,
        {
          method: "POST",
          token: user.token,
          body: JSON.stringify({ reason: "ADMIN_REVOKED" }),
        },
      );
      assert.equal(revocation.status, "REVOKED");
      await primaryMqtt.endAsync();
      clients.delete(primaryMqtt);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await expectMqttRejected(
        mqttOptions(
          primary.deviceId,
          replacementCertificatePath,
          replacement.keyPath,
        ),
        "revoked replacement certificate",
      );
      socket?.close(1000, "persistence restart");
      socket = undefined;
      compose(["down", "--remove-orphans"]);
      compose([
        "up",
        "-d",
        "--no-build",
        "--wait",
        "keycloak",
        "access-service",
        "device-service",
        "emqx",
      ]);
      await expectMqttRejected(
        mqttOptions(
          primary.deviceId,
          replacementCertificatePath,
          replacement.keyPath,
        ),
        "persistently revoked certificate after restart",
      );
      const credentials = await json(
        `${urls.device}/devices/${primary.deviceUuid}/credentials`,
        { token: user.token },
      );
      assert.equal(credentials.items.length, 2);
      assert.equal(
        credentials.items.every(
          (credential) =>
            !("privateKey" in credential) && !("privateKeyPem" in credential),
        ),
        true,
      );
      const audit = await json(
        `${urls.device}/devices/${primary.deviceUuid}/credential-audit`,
        { token: user.token },
      );
      assert.ok(audit.items.length >= 6);
      const postRestartMetrics = await json(
        `${urls.device}/internal/device-credentials/metrics`,
        { token: ingestionToken },
      );
      for (const name of [
        "mtlsAccepted",
        "credentialMismatch",
        "revokedOrExpired",
      ]) {
        assert.equal(Number.isInteger(postRestartMetrics[name]), true);
        assert.ok(postRestartMetrics[name] >= 0);
      }
      mark("revocation_persistence_ms");

      const evidence = {
        schema: "algaguard.local.device-credential-e2e-evidence",
        schemaVersion: "1.0.0",
        completedAt: new Date().toISOString(),
        composeProject:
          process.env.COMPOSE_PROJECT_NAME ?? "algaguard-credential-e2e",
        deviceIds: [primary.deviceId, secondary.deviceId, inactive.deviceId],
        deviceUuids: [
          primary.deviceUuid,
          secondary.deviceUuid,
          inactive.deviceUuid,
        ],
        initialFingerprintPrefix:
          primary.credential.fingerprintSha256.slice(0, 12),
        replacementFingerprintPrefix:
          rotationIssuance.credential.fingerprintSha256.slice(0, 12),
        credentialIds: {
          initial: primary.credential.credentialId,
          replacement: rotationIssuance.credential.credentialId,
        },
        validity: {
          initial: {
            notBefore: primary.credential.notBefore,
            notAfter: primary.credential.notAfter,
          },
          replacement: {
            notBefore: rotationIssuance.credential.notBefore,
            notAfter: rotationIssuance.credential.notAfter,
          },
        },
        metricSnapshots: {
          authentication: authenticationMetrics,
          rotation: rotationMetrics,
          postRestart: postRestartMetrics,
        },
        checks: {
          noCertificateRejected: true,
          wrongCaRejected: true,
          unknownCertificateRejected: true,
          expiredCertificateRejected: true,
          identityMismatchRejected: true,
          crossDeviceSubscribeDenied: true,
          crossDevicePublishDenied: true,
          wildcardAndPrivilegedNamespacesDenied: true,
          compromisedCredentialRejected: true,
          inactiveDeviceCredentialRejected: true,
          telemetryAcknowledged: true,
          realtimeDelivered: true,
          profileAssigned: true,
          commandCompleted: true,
          otaNotificationDelivered: true,
          rotationCompleted: true,
          predecessorRejected: true,
          restartRecovered: true,
          explicitRevocationPersisted: true,
        },
        timings,
      };
      writeFileSync(
        path.join(evidenceRoot, "device-credential-e2e.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } finally {
      socket?.close(1000, "test complete");
      for (const client of clients)
        await client.endAsync().catch(() => undefined);
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
