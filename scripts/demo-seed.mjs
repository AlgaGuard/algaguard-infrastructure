#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

if (!process.argv.includes("--confirm-development")) {
  throw new Error("Refusing to seed without --confirm-development.");
}

const stateFile = ".local/demo/demo-user.json";
const gatewayCaFile = ".local/pki/gateway-ca/ca.crt";

function readEnv(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

function readState() {
  return existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : {};
}

function requestJson(target, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(target);
  const transport = url.protocol === "https:" ? https : http;
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const requestHeaders = {
    accept: "application/json",
    ...headers,
    ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
  };
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers: requestHeaders,
        ...(url.protocol === "https:"
          ? { ca: readFileSync(gatewayCaFile), servername: "localhost" }
          : {}),
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = text;
          }
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              new Error(
                `${method} ${url.pathname} returned ${response.statusCode}: ${typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed)}`,
              ),
            );
            return;
          }
          resolve({
            body: parsed,
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.setTimeout(15_000, () =>
      request.destroy(new Error(`${method} ${url.pathname} timed out`)),
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const environment = { ...readEnv(".env"), ...process.env };
const existing = readState();
const email =
  environment.DEMO_USER_EMAIL ?? existing.email ?? "demo@algaguard.local";
const password =
  environment.DEMO_USER_PASSWORD ??
  existing.password ??
  randomBytes(24).toString("base64url");
const tankId = existing.tankId ?? randomUUID();
const adminCredentials = new URLSearchParams({
  grant_type: "password",
  client_id: "admin-cli",
  username: environment.KEYCLOAK_ADMIN,
  password: environment.KEYCLOAK_ADMIN_PASSWORD,
});
const adminToken = (
  await requestJson(
    "https://localhost:8443/auth/realms/master/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: adminCredentials.toString(),
    },
  )
).body.access_token;
const adminHeaders = {
  authorization: `Bearer ${adminToken}`,
  "content-type": "application/json",
};
const users = (
  await requestJson(
    `https://localhost:8443/auth/admin/realms/algaguard/users?username=${encodeURIComponent(email)}&exact=true`,
    { headers: adminHeaders },
  )
).body;
let userId = users[0]?.id;
if (!userId) {
  const created = await requestJson(
    "https://localhost:8443/auth/admin/realms/algaguard/users",
    {
      method: "POST",
      headers: adminHeaders,
      body: {
        username: email,
        email,
        firstName: "AlgaGuard",
        lastName: "Demo",
        enabled: true,
        emailVerified: true,
        requiredActions: [],
      },
    },
  );
  userId = created.headers.location?.split("/").at(-1);
}
if (!userId)
  throw new Error("Keycloak did not return the seeded user identifier.");

await requestJson(
  `https://localhost:8443/auth/admin/realms/algaguard/users/${userId}`,
  {
    method: "PUT",
    headers: adminHeaders,
    body: {
      username: email,
      email,
      firstName: "AlgaGuard",
      lastName: "Demo",
      enabled: true,
      emailVerified: true,
      requiredActions: [],
    },
  },
);

await requestJson(
  `https://localhost:8443/auth/admin/realms/algaguard/users/${userId}/reset-password`,
  {
    method: "PUT",
    headers: adminHeaders,
    body: { type: "password", temporary: false, value: password },
  },
);
const ownerRole = (
  await requestJson(
    "https://localhost:8443/auth/admin/realms/algaguard/roles/OWNER",
    { headers: adminHeaders },
  )
).body;
await requestJson(
  `https://localhost:8443/auth/admin/realms/algaguard/users/${userId}/role-mappings/realm`,
  {
    method: "POST",
    headers: adminHeaders,
    body: [ownerRole],
  },
);

const userCredentials = new URLSearchParams({
  grant_type: "password",
  client_id: "algaguard-e2e",
  username: email,
  password,
});
const userToken = (
  await requestJson(
    "https://localhost:8443/auth/realms/algaguard/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: userCredentials.toString(),
    },
  )
).body.access_token;
const userHeaders = {
  authorization: `Bearer ${userToken}`,
  "content-type": "application/json",
};
const organizations = (
  await requestJson("http://127.0.0.1:3001/v1/organizations", {
    headers: userHeaders,
  })
).body.items;
let organization = organizations.find((item) => item.name === "AlgaGuard Demo");
if (!organization) {
  organization = (
    await requestJson("http://127.0.0.1:3001/v1/organizations", {
      method: "POST",
      headers: userHeaders,
      body: { name: "AlgaGuard Demo" },
    })
  ).body;
}
const devices = (
  await requestJson(
    `http://127.0.0.1:3002/v1/devices?organizationId=${organization.id}`,
    { headers: userHeaders },
  )
).body.items;
let device = devices.find((item) => item.tankId === tankId);
if (!device) {
  device = (
    await requestJson("http://127.0.0.1:3002/v1/devices", {
      method: "POST",
      headers: userHeaders,
      body: {
        organizationId: organization.id,
        tankId,
        hardwareModel: "ESP32-S3-DEVKITC-1-N16R8",
      },
    })
  ).body;
}

mkdirSync(".local/demo", { recursive: true });
writeFileSync(
  stateFile,
  `${JSON.stringify({ email, password, userId, organizationId: organization.id, tankId, deviceId: device.deviceId, deviceUuid: device.deviceUuid }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
console.log(
  `Development demo seed ready: organization=${organization.id} tank=${tankId} device=${device.deviceId}. Credentials are stored only in ${stateFile}.`,
);
