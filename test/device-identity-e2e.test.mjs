import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import mqtt from "mqtt";
import { createClient } from "redis";

const urls = {
  access: "http://127.0.0.1:3001/v1",
  device: "http://127.0.0.1:3002/v1",
  telemetry: "http://127.0.0.1:3005/v1",
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

async function form(url, values, expected = 200, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: new URLSearchParams(values),
  });
  const body = await responseBody(response);
  assert.equal(response.status, expected, `${url}: ${JSON.stringify(body)}`);
  return body;
}

function tokenSubject(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;
}

async function createUser(adminToken, username, email) {
  await json(
    `${urls.keycloak}/admin/realms/algaguard/users`,
    {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({
        username,
        email,
        emailVerified: true,
        firstName: "Identity",
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
  return { token: login.access_token, subjectId: tokenSubject(login.access_token) };
}

async function clientToken(clientId, secret) {
  const value = await form(
    `${urls.keycloak}/realms/algaguard/protocol/openid-connect/token`,
    {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    },
  );
  return value.access_token;
}

function mqttMessage(client, topic, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const listener = (receivedTopic, payload) => {
      if (receivedTopic !== topic) return;
      clearTimeout(timer);
      client.off("message", listener);
      resolve(JSON.parse(payload.toString()));
    };
    const timer = setTimeout(() => {
      client.off("message", listener);
      reject(new Error(`Timed out waiting for ${topic}`));
    }, timeoutMs);
    client.on("message", listener);
  });
}

function websocketMessage(socket, predicate = () => true, timeoutMs = 10_000) {
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

async function maybeWebsocketMessage(socket, predicate, timeoutMs = 700) {
  try {
    await websocketMessage(socket, predicate, timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Timed out")) return false;
    throw error;
  }
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
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return { socket, ticket: ticket.ticket };
}

async function subscribeDevice(socket, deviceUuid) {
  const requestId = crypto.randomUUID();
  const result = websocketMessage(
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
  return result;
}

function telemetryEnvelope(deviceId, sequence, overrides = {}) {
  const messageId = overrides.messageId ?? crypto.randomUUID();
  const batchId = overrides.batchId ?? crypto.randomUUID();
  const sample = {
    sequence: String(sequence),
    observedAt: new Date().toISOString(),
    timestampQuality: "NTP_SYNCED",
    uptimeMs: String(sequence * 1000),
    values: { temperatureC: 24.2, ph: 7.1, lightLux: 800 },
  };
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
      activeProfile: {
        profileId: "30000000-0000-4000-8000-000000000001",
        profileVersion: "1.0.0",
      },
      samples: [sample],
      isReplay: false,
      createdFromSd: false,
    },
    ...overrides.envelope,
  };
}

async function expectNoAck(client, topic, payload, ackTopic) {
  const possible = mqttMessage(client, ackTopic, 1_000)
    .then(() => true)
    .catch((error) => {
      if (error instanceof Error && error.message.includes("Timed out")) return false;
      throw error;
    });
  await client.publishAsync(topic, JSON.stringify(payload), { qos: 1 });
  assert.equal(await possible, false, `unexpected ACK for ${topic}`);
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

test("device identity resolution, restart, transfer, and no-leak routing", { timeout: 240_000 }, async () => {
  const startedAt = performance.now();
  const timings = {};
  const mark = (name) => {
    timings[name] = Math.round(performance.now() - startedAt);
  };
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const emailA = `identity-a-${suffix}@example.invalid`;
  const emailB = `identity-b-${suffix}@example.invalid`;
  const sockets = new Set();
  let deviceMqtt;
  let redis;
  try {
    assert.equal((await json(`${urls.keycloak}/realms/algaguard`)).realm, "algaguard");
    const admin = await form(
      `${urls.keycloak}/realms/master/protocol/openid-connect/token`,
      {
        grant_type: "password",
        client_id: "admin-cli",
        username: "admin",
        password: "development-only-change-me",
      },
    );
    const userA = await createUser(admin.access_token, `identity-a-${suffix}`, emailA);
    const userB = await createUser(admin.access_token, `identity-b-${suffix}`, emailB);
    mark("users_ready_ms");

    const organizationA = await json(
      `${urls.access}/organizations`,
      { method: "POST", token: userA.token, body: JSON.stringify({ name: `Identity A ${suffix}` }) },
      201,
    );
    const organizationB = await json(
      `${urls.access}/organizations`,
      { method: "POST", token: userB.token, body: JSON.stringify({ name: `Identity B ${suffix}` }) },
      201,
    );
    const invitation = await json(
      `${urls.access}/organizations/${organizationB.id}/invitations`,
      {
        method: "POST",
        token: userB.token,
        body: JSON.stringify({ email: emailA, role: "ADMIN", expiresInSeconds: 3600 }),
      },
      201,
    );
    await json(`${urls.access}/invitations/accept`, {
      method: "POST",
      token: userA.token,
      body: JSON.stringify({ token: invitation.token }),
    });

    const device = await json(
      `${urls.device}/devices`,
      {
        method: "POST",
        token: userA.token,
        body: JSON.stringify({ organizationId: organizationA.id }),
      },
      201,
    );
    assert.match(device.deviceUuid, /^[0-9a-f-]{36}$/);
    assert.match(device.deviceId, /^AG-[0-9]{6}$/);
    const setup = await json(
      `${urls.device}/devices/${device.deviceUuid}/setup`,
      { method: "POST", token: userA.token, body: JSON.stringify({ expiresInSeconds: 600 }) },
      201,
    );
    const claim = await json(`${urls.device}/claims/consume`, {
      method: "POST",
      token: userA.token,
      body: JSON.stringify({ organizationId: organizationA.id, qr: setup }),
    });
    const credentials = await json(`${urls.device}/devices/${device.deviceId}/bootstrap`, {
      method: "POST",
      body: JSON.stringify({ sessionToken: claim.bootstrap.sessionToken }),
    });
    assert.equal(credentials.developmentOnly, true);

    const accessServiceToken = await clientToken(
      "algaguard-access-service",
      "replace-with-access-service-secret",
    );
    let context = await json(
      `${urls.device}/internal/devices/by-device-id/${device.deviceId}/context`,
      { token: accessServiceToken },
    );
    assert.equal(context.deviceUuid, device.deviceUuid);
    assert.equal(context.organizationId, organizationA.id);
    assert.equal(context.ownershipVersion, "1");
    mark("mapping_active_ms");

    const realtimeA = await openRealtime(userA.token);
    sockets.add(realtimeA.socket);
    const replay = new WebSocket(
      `ws://127.0.0.1:3008/realtime?ticket=${realtimeA.ticket}`,
    );
    const replayClosed = new Promise((resolve) => replay.addEventListener("close", resolve, { once: true }));
    assert.equal((await replayClosed).code, 4401);
    assert.equal((await subscribeDevice(realtimeA.socket, device.deviceUuid)).accepted.length, 1);

    const realtimeBPreTransfer = await openRealtime(userB.token);
    sockets.add(realtimeBPreTransfer.socket);
    const deniedB = await subscribeDevice(realtimeBPreTransfer.socket, device.deviceUuid);
    assert.equal(deniedB.accepted.length, 0);
    assert.equal(deniedB.rejected.length, 1);

    deviceMqtt = await mqtt.connectAsync("mqtt://127.0.0.1:11883", {
      clientId: device.deviceId,
      username: "development-device-harness",
      password: "replace-with-mqtt-device-password",
      clean: true,
    });
    const ackTopic = `algaguard/v1/devices/${device.deviceId}/telemetry/ack`;
    await deviceMqtt.subscribeAsync(ackTopic, { qos: 1 });
    const first = telemetryEnvelope(device.deviceId, 1);
    const firstAck = mqttMessage(deviceMqtt, ackTopic);
    const firstLive = websocketMessage(realtimeA.socket, (value) => value.eventType === "telemetry.updated");
    const leakedToB = maybeWebsocketMessage(
      realtimeBPreTransfer.socket,
      (value) => value.eventType === "telemetry.updated",
      900,
    );
    await deviceMqtt.publishAsync(
      `algaguard/v1/devices/${device.deviceId}/telemetry`,
      JSON.stringify(first),
      { qos: 1 },
    );
    assert.equal((await firstAck).payload.duplicate, false);
    const firstEvent = await firstLive;
    assert.equal(firstEvent.deviceUuid, device.deviceUuid);
    assert.equal(firstEvent.deviceId, device.deviceId);
    assert.equal(firstEvent.organizationId, organizationA.id);
    assert.equal(await leakedToB, false);
    const initialHistory = await json(
      `${urls.telemetry}/devices/${device.deviceUuid}/telemetry`,
      { token: userA.token },
    );
    assert.equal(initialHistory.items.length, 1);
    assert.equal(initialHistory.items[0].organizationIdAtIngest, organizationA.id);
    mark("first_delivery_ms");

    await expectNoAck(
      deviceMqtt,
      "algaguard/v1/devices/AG-999999/telemetry",
      telemetryEnvelope("AG-999999", 50),
      "algaguard/v1/devices/AG-999999/telemetry/ack",
    );
    await expectNoAck(
      deviceMqtt,
      "algaguard/v1/devices/AG-BAD/telemetry",
      telemetryEnvelope("AG-BAD", 51),
      "algaguard/v1/devices/AG-BAD/telemetry/ack",
    );
    await expectNoAck(
      deviceMqtt,
      `algaguard/v1/devices/${device.deviceId}/telemetry`,
      telemetryEnvelope("AG-999999", 52),
      ackTopic,
    );
    const unclaimed = await json(
      `${urls.device}/devices`,
      {
        method: "POST",
        token: userB.token,
        body: JSON.stringify({ organizationId: organizationB.id }),
      },
      201,
    );
    await expectNoAck(
      deviceMqtt,
      `algaguard/v1/devices/${unclaimed.deviceId}/telemetry`,
      telemetryEnvelope(unclaimed.deviceId, 53),
      `algaguard/v1/devices/${unclaimed.deviceId}/telemetry/ack`,
    );
    sql(`UPDATE devices SET lifecycle='INACTIVE' WHERE device_uuid='${device.deviceUuid}'`);
    await expectNoAck(
      deviceMqtt,
      `algaguard/v1/devices/${device.deviceId}/telemetry`,
      telemetryEnvelope(device.deviceId, 54),
      ackTopic,
    );
    sql(`UPDATE devices SET lifecycle='ACTIVE' WHERE device_uuid='${device.deviceUuid}'`);
    await expectNoAck(
      deviceMqtt,
      `algaguard/v1/devices/${device.deviceId}/telemetry`,
      telemetryEnvelope(device.deviceId, 55, {
        envelope: { organizationId: organizationA.id },
      }),
      ackTopic,
    );

    const invalidUuid = await openRealtime(userA.token);
    sockets.add(invalidUuid.socket);
    invalidUuid.socket.send(
      JSON.stringify({
        schema: "algaguard.websocket.subscribe",
        schemaVersion: "1.0.0",
        requestId: crypto.randomUUID(),
        subscriptions: [
          {
            resourceType: "device",
            resourceId: device.deviceId,
            events: ["telemetry.updated"],
          },
        ],
      }),
    );
    const invalidClosed = await new Promise((resolve) =>
      invalidUuid.socket.addEventListener("close", resolve, { once: true }),
    );
    assert.equal(invalidClosed.code, 4400);

    redis = createClient({ url: "redis://127.0.0.1:6379" });
    await redis.connect();
    const metricsBefore = await fetch(`${urls.realtime}/metrics`).then((value) => value.text());
    const invalidBefore = Number(/algaguard_realtime_invalid_events_total (\d+)/.exec(metricsBefore)?.[1] ?? 0);
    const noInvalidDelivery = maybeWebsocketMessage(
      realtimeA.socket,
      (value) => value.eventType === "telemetry.updated",
      700,
    );
    await redis.publish(
      "algaguard.live",
      JSON.stringify({
        schema: "urn:algaguard:schema:internal:telemetry-committed:v1",
        schemaVersion: "1.0.0",
        eventId: crypto.randomUUID(),
        eventType: "telemetry.committed",
        occurredAt: new Date().toISOString(),
        deviceUuid: device.deviceUuid,
        deviceId: device.deviceId,
        ownershipVersion: "1",
        batchId: crypto.randomUUID(),
        firstSequence: "1",
        lastSequence: "1",
        sampleCount: 1,
        payload: { sample: first.payload.samples[0] },
      }),
    );
    assert.equal(await noInvalidDelivery, false);
    const metricsAfter = await fetch(`${urls.realtime}/metrics`).then((value) => value.text());
    const invalidAfter = Number(/algaguard_realtime_invalid_events_total (\d+)/.exec(metricsAfter)?.[1] ?? 0);
    assert.equal(invalidAfter, invalidBefore + 1);
    mark("negative_cases_ms");

    await deviceMqtt.endAsync();
    deviceMqtt = undefined;
    for (const socket of sockets) socket.close();
    sockets.clear();
    compose([
      "restart",
      "access-service",
      "device-service",
      "mqtt-ingestion-service",
      "telemetry-service",
      "realtime-service",
    ]);
    compose([
      "up",
      "-d",
      "--wait",
      "access-service",
      "device-service",
      "mqtt-ingestion-service",
      "telemetry-service",
      "realtime-service",
    ]);
    context = await json(
      `${urls.device}/internal/devices/by-device-id/${device.deviceId}/context`,
      { token: accessServiceToken },
    );
    assert.equal(context.deviceUuid, device.deviceUuid);
    assert.equal(context.organizationId, organizationA.id);
    assert.equal(context.ownershipVersion, "1");
    deviceMqtt = await mqtt.connectAsync("mqtt://127.0.0.1:11883", {
      clientId: device.deviceId,
      username: "development-device-harness",
      password: "replace-with-mqtt-device-password",
      clean: true,
    });
    await deviceMqtt.subscribeAsync(ackTopic, { qos: 1 });
    const realtimeAAfterRestart = await openRealtime(userA.token);
    sockets.add(realtimeAAfterRestart.socket);
    assert.equal((await subscribeDevice(realtimeAAfterRestart.socket, device.deviceUuid)).accepted.length, 1);
    const second = telemetryEnvelope(device.deviceId, 2);
    const secondAck = mqttMessage(deviceMqtt, ackTopic);
    const secondLive = websocketMessage(
      realtimeAAfterRestart.socket,
      (value) => value.eventType === "telemetry.updated" && value.sequence === "2",
    );
    await deviceMqtt.publishAsync(
      `algaguard/v1/devices/${device.deviceId}/telemetry`,
      JSON.stringify(second),
      { qos: 1 },
    );
    assert.equal((await secondAck).payload.duplicate, false);
    await secondLive;
    mark("restart_delivery_ms");

    const transferred = await json(
      `${urls.device}/devices/${device.deviceUuid}/ownership-transfer`,
      {
        method: "POST",
        token: userA.token,
        body: JSON.stringify({ organizationId: organizationB.id }),
      },
    );
    assert.equal(transferred.previousOrganizationId, organizationA.id);
    assert.equal(transferred.device.organizationId, organizationB.id);
    assert.equal(transferred.device.ownershipVersion, "2");
    await json(
      `${urls.access}/organizations/${organizationB.id}/memberships/${userA.subjectId}`,
      { method: "DELETE", token: userB.token },
      204,
    );

    const realtimeBAfterTransfer = await openRealtime(userB.token);
    sockets.add(realtimeBAfterTransfer.socket);
    assert.equal(
      (await subscribeDevice(realtimeBAfterTransfer.socket, device.deviceUuid)).accepted.length,
      1,
    );
    const third = telemetryEnvelope(device.deviceId, 3);
    const thirdAck = mqttMessage(deviceMqtt, ackTopic);
    const thirdLiveB = websocketMessage(
      realtimeBAfterTransfer.socket,
      (value) => value.eventType === "telemetry.updated" && value.sequence === "3",
    );
    const thirdLeakA = maybeWebsocketMessage(
      realtimeAAfterRestart.socket,
      (value) => value.eventType === "telemetry.updated" && value.sequence === "3",
      1_000,
    );
    await deviceMqtt.publishAsync(
      `algaguard/v1/devices/${device.deviceId}/telemetry`,
      JSON.stringify(third),
      { qos: 1 },
    );
    assert.equal((await thirdAck).payload.duplicate, false);
    const thirdEvent = await thirdLiveB;
    assert.equal(thirdEvent.organizationId, organizationB.id);
    assert.equal(await thirdLeakA, false);
    const rejectedAfterTransfer = await subscribeDevice(
      realtimeAAfterRestart.socket,
      device.deviceUuid,
    );
    assert.equal(rejectedAfterTransfer.accepted.length, 0);
    assert.equal(rejectedAfterTransfer.rejected.length, 1);

    const historyB = await json(
      `${urls.telemetry}/devices/${device.deviceUuid}/telemetry`,
      { token: userB.token },
    );
    assert.deepEqual(
      historyB.items.map((item) => item.sequence),
      ["3"],
    );
    assert.equal(historyB.items[0].organizationIdAtIngest, organizationB.id);
    await json(
      `${urls.telemetry}/devices/${device.deviceUuid}/telemetry`,
      { token: userA.token },
      403,
    );
    const rawOrganizations = sql(
      `SELECT sequence::text || ':' || organization_id_at_ingest::text FROM telemetry_samples WHERE device_uuid='${device.deviceUuid}' ORDER BY sequence`,
    ).split(/\r?\n/);
    assert.deepEqual(rawOrganizations, [
      `1:${organizationA.id}`,
      `2:${organizationA.id}`,
      `3:${organizationB.id}`,
    ]);

    const duplicateAck = mqttMessage(deviceMqtt, ackTopic);
    await deviceMqtt.publishAsync(
      `algaguard/v1/devices/${device.deviceId}/telemetry`,
      JSON.stringify(third),
      { qos: 1 },
    );
    assert.equal((await duplicateAck).payload.duplicate, true);
    assert.equal(
      sql(`SELECT count(*) FROM telemetry_samples WHERE device_uuid='${device.deviceUuid}'`),
      "3",
    );

    const mqttServiceToken = await clientToken(
      "algaguard-mqtt-ingestion-service",
      "replace-with-mqtt-ingestion-service-secret",
    );
    await json(
      `${urls.telemetry}/ingestion/batches`,
      {
        method: "POST",
        token: mqttServiceToken,
        body: JSON.stringify({
          batchId: crypto.randomUUID(),
          deviceUuid: device.deviceUuid,
          deviceId: device.deviceId,
          organizationId: organizationA.id,
          ownershipVersion: "1",
          correlationId: crypto.randomUUID(),
          activeProfile: third.payload.activeProfile,
          samples: [
            {
              ...third.payload.samples[0],
              sequence: "99",
              uptimeMs: "99000",
            },
          ],
        }),
      },
      409,
    );
    mark("transfer_complete_ms");
    process.stdout.write(
      `${JSON.stringify({
        evidence: "device-identity-e2e",
        deviceUuid: device.deviceUuid,
        deviceId: device.deviceId,
        organizationA: organizationA.id,
        organizationB: organizationB.id,
        ownershipVersion: "2",
        storedSamples: 3,
        unauthorizedLeak: false,
        timings,
      })}\n`,
    );
  } finally {
    if (deviceMqtt) await deviceMqtt.endAsync().catch(() => {});
    if (redis?.isOpen) await redis.quit().catch(() => {});
    for (const socket of sockets) socket.close();
  }
});
