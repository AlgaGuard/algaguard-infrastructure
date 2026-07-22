import assert from "node:assert/strict";
import test from "node:test";
import mqtt from "mqtt";

const urls = {
  access: "http://localhost:3001/v1",
  device: "http://localhost:3002/v1",
  profile: "http://localhost:3003/v1",
  telemetry: "http://localhost:3005/v1",
  command: "http://localhost:3006/v1",
  ota: "http://localhost:3007/v1",
  realtime: "http://localhost:3008/v1",
  keycloak: "http://localhost:8081",
};

async function json(url, options = {}, expected = 200) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const body = await response.json();
  assert.equal(response.status, expected, `${url}: ${JSON.stringify(body)}`);
  return body;
}

function message(client, topic, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${topic}`)), timeoutMs);
    const listener = (receivedTopic, payload) => {
      if (receivedTopic !== topic) return;
      clearTimeout(timer);
      client.off("message", listener);
      resolve(JSON.parse(payload.toString()));
    };
    client.on("message", listener);
  });
}

function websocketMessage(socket, predicate = () => true, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket event")), timeoutMs);
    const listener = (event) => {
      const value = JSON.parse(event.data.toString());
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(value);
    };
    socket.addEventListener("message", listener);
  });
}

test("portable platform vertical slice", { timeout: 120_000 }, async () => {
  const subjectId = `e2e-${Date.now()}`;

  const realm = await json(`${urls.keycloak}/realms/algaguard`);
  assert.equal(realm.realm, "algaguard");
  const tokenResponse = await fetch(`${urls.keycloak}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: "development-only-change-me",
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const admin = await tokenResponse.json();
  const userResponse = await fetch(`${urls.keycloak}/admin/realms/algaguard/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      username: subjectId,
      email: `${subjectId}@example.invalid`,
      emailVerified: true,
      firstName: "Platform",
      lastName: "Test",
      enabled: true,
      credentials: [{ type: "password", value: "development-e2e-only", temporary: false }],
    }),
  });
  assert.ok([201, 409].includes(userResponse.status));
  const loginResponse = await fetch(`${urls.keycloak}/realms/algaguard/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "algaguard-e2e",
      username: subjectId,
      password: "development-e2e-only",
    }),
  });
  const loginText = await loginResponse.text();
  assert.equal(loginResponse.status, 200, loginText);
  const login = JSON.parse(loginText);
  assert.ok(login.access_token);

  const organization = await json(
    `${urls.access}/organizations`,
    { method: "POST", body: JSON.stringify({ name: "E2E Organization", ownerSubjectId: subjectId }) },
    201,
  );
  const device = await json(
    `${urls.device}/devices`,
    { method: "POST", body: JSON.stringify({ organizationId: organization.id }) },
    201,
  );
  assert.match(device.id, /^AG-[0-9]{6}$/);
  const setup = await json(
    `${urls.device}/devices/${device.id}/setup`,
    {
      method: "POST",
      body: JSON.stringify({ bootstrapUrl: "https://development.algaguard.local", environment: "development" }),
    },
    201,
  );
  const allowedQrKeys = new Set([
    "schema",
    "schemaVersion",
    "deviceId",
    "claimCode",
    "bootstrapUrl",
    "environment",
    "bleServiceId",
    "expiresAt",
  ]);
  assert.ok(Object.keys(setup).every((key) => allowedQrKeys.has(key)));
  assert.ok(!JSON.stringify(setup).toLowerCase().includes("password"));
  const claim = await json(
    `${urls.device}/claims/consume`,
    {
      method: "POST",
      body: JSON.stringify({ claimCode: setup.claimCode, subjectId, organizationId: organization.id }),
    },
  );
  await json(
    `${urls.device}/claims/consume`,
    {
      method: "POST",
      body: JSON.stringify({ claimCode: setup.claimCode, subjectId, organizationId: organization.id }),
    },
    410,
  );
  const credentials = await json(`${urls.device}/devices/${device.id}/bootstrap`, {
    method: "POST",
    body: JSON.stringify({ bootstrapToken: claim.bootstrapToken }),
  });
  assert.equal(credentials.developmentOnly, true);

  const profile = await json(
    `${urls.profile}/profiles`,
    { method: "POST", body: JSON.stringify({ name: "E2E profile", configuration: { sampleSeconds: 1 } }) },
    201,
  );
  const original = structuredClone(profile.current);
  await json(
    `${urls.profile}/profiles/${profile.profileId}/versions`,
    { method: "POST", body: JSON.stringify({ sampleSeconds: 2 }) },
    201,
  );
  assert.deepEqual(profile.current, original);

  const ticket = await json(
    `${urls.realtime}/tickets`,
    { method: "POST", body: JSON.stringify({ subjectId }) },
    201,
  );
  const socket = new WebSocket(`ws://localhost:3008/realtime?ticket=${ticket.ticket}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({ subscriptions: [{ resourceType: "current-user", events: ["telemetry.updated"] }] }));
  const subscriptionAck = await websocketMessage(socket, (value) => Array.isArray(value.accepted));
  assert.equal(subscriptionAck.accepted.length, 1);
  const reused = new WebSocket(`ws://localhost:3008/realtime?ticket=${ticket.ticket}`);
  const reusedClose = await new Promise((resolve) => reused.addEventListener("close", resolve, { once: true }));
  assert.equal(reusedClose.code, 4401);

  const deviceMqtt = await mqtt.connectAsync("mqtt://localhost:11883", {
    clientId: device.id,
    username: "development-device-harness",
    clean: true,
  });
  const ackTopic = `algaguard/v1/devices/${device.id}/telemetry/ack`;
  const commandTopic = `algaguard/v1/devices/${device.id}/commands`;
  await deviceMqtt.subscribeAsync([ackTopic, commandTopic], { qos: 1 });
  const now = new Date();
  const messageId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const telemetry = {
    schema: "urn:algaguard:schema:mqtt:telemetry-batch:v1",
    schemaVersion: "1.0.0",
    messageId,
    deviceId: device.id,
    sentAt: now.toISOString(),
    payload: {
      batchId,
      firstSequence: "1",
      lastSequence: "2",
      sampleCount: 2,
      samples: [1, 2].map((sequence) => ({
        sequence: String(sequence),
        observedAt: new Date(now.getTime() + sequence).toISOString(),
        timestampQuality: "NTP_SYNCED",
        uptimeMs: String(sequence * 1000),
        values: { temperatureC: 24 + sequence / 10, ph: 7.1, lightLux: 800 },
        qualityFlags: ["SIMULATED"],
        simulationScenario: "platform-e2e",
      })),
    },
  };
  const ackPromise = message(deviceMqtt, ackTopic);
  const livePromise = websocketMessage(socket, (value) => value.eventType === "telemetry.updated");
  await deviceMqtt.publishAsync(`algaguard/v1/devices/${device.id}/telemetry`, JSON.stringify(telemetry), { qos: 1 });
  const ack = await ackPromise;
  assert.equal(ack.payload.batchId, batchId);
  assert.equal(ack.payload.duplicate, false);
  const live = await livePromise;
  assert.equal(live.deviceId, device.id);
  const latest = await json(`${urls.telemetry}/devices/${device.id}/latest`);
  assert.equal(latest.latest.sequence, "2");
  const duplicatePromise = message(deviceMqtt, ackTopic);
  await deviceMqtt.publishAsync(`algaguard/v1/devices/${device.id}/telemetry`, JSON.stringify(telemetry), { qos: 1 });
  assert.equal((await duplicatePromise).payload.duplicate, true);

  const command = await json(
    `${urls.command}/devices/${device.id}/commands`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "REQUEST_STATUS",
        payload: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        deduplicationKey: crypto.randomUUID(),
      }),
    },
    201,
  );
  const commandPromise = message(deviceMqtt, commandTopic);
  await json(`${urls.command}/commands/${command.id}/publish`, { method: "POST", body: "{}" });
  const deliveredCommand = await commandPromise;
  assert.equal(deliveredCommand.payload.commandId, command.id);
  await deviceMqtt.publishAsync(
    `algaguard/v1/devices/${device.id}/command-results`,
    JSON.stringify({ payload: { commandId: command.id, status: "SUCCEEDED" } }),
    { qos: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await json(`${urls.command}/commands/${command.id}`)).status, "SUCCEEDED");

  const release = await json(
    `${urls.ota}/releases`,
    {
      method: "POST",
      body: JSON.stringify({
        hardwareModel: device.hardwareModel,
        version: "1.0.1",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        signature: { algorithm: "ECDSA_P256_SHA256", keyId: "development", value: "test-signature" },
        ring: "DEVELOPMENT",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        objectKey: "e2e/firmware.bin",
      }),
    },
    201,
  );
  const assignment = await json(
    `${urls.ota}/releases/${release.id}/assignments`,
    {
      method: "POST",
      body: JSON.stringify({
        deviceId: device.id,
        hardwareModel: device.hardwareModel,
        version: "1.0.0",
        ring: "DEVELOPMENT",
      }),
    },
    201,
  );
  assert.match(assignment.downloadUrl, /^http/);
  assert.equal(assignment.manifest.sha256, "a".repeat(64));

  socket.close();
  await deviceMqtt.endAsync();
});
