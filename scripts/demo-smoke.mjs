import https from "node:https";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";

const ca = readFileSync(".local/pki/gateway-ca/ca.crt");
const requests = [
  ["https://localhost:8443/", 200],
  ["https://localhost:8443/api/health/ready", 200],
  [
    "https://localhost:8443/auth/realms/algaguard/.well-known/openid-configuration",
    200,
  ],
];

for (const [url, expected] of requests) {
  await new Promise((resolve, reject) => {
    https
      .get(url, { ca, servername: "localhost" }, (response) => {
        response.resume();
        response.statusCode === expected
          ? resolve()
          : reject(
              new Error(
                `${url} returned ${response.statusCode}, expected ${expected}`,
              ),
            );
      })
      .on("error", reject);
  });
}
console.log("Gateway transport smoke passed with the local development CA.");

const stateFile = ".local/demo/demo-user.json";
if (!existsSync(stateFile))
  throw new Error(`Missing ${stateFile}; run make demo-seed first.`);
const seed = JSON.parse(readFileSync(stateFile, "utf8"));

function requestJson(target, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(target);
  const transport = url.protocol === "https:" ? https : http;
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers: {
          accept: "application/json",
          ...headers,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
        ...(url.protocol === "https:" ? { ca, servername: "localhost" } : {}),
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
          if ((response.statusCode ?? 500) >= 400)
            return reject(
              new Error(
                `${method} ${url.pathname} returned ${response.statusCode}`,
              ),
            );
          resolve(parsed);
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const credentials = new URLSearchParams({
  grant_type: "password",
  client_id: "algaguard-e2e",
  username: seed.email,
  password: seed.password,
});
const token = (
  await requestJson(
    "https://localhost:8443/auth/realms/algaguard/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: credentials.toString(),
    },
  )
).access_token;
const headers = { authorization: `Bearer ${token}` };
const organizations = (
  await requestJson("http://127.0.0.1:3001/v1/organizations", { headers })
).items;
if (!organizations.some((item) => item.id === seed.organizationId))
  throw new Error("Seeded organization is not visible to the demo user.");
const devices = (
  await requestJson(
    `http://127.0.0.1:3002/v1/devices?organizationId=${seed.organizationId}`,
    { headers },
  )
).items;
if (
  !devices.some(
    (item) =>
      item.deviceUuid === seed.deviceUuid && item.tankId === seed.tankId,
  )
)
  throw new Error(
    "Seeded tank/device association is not visible to the demo user.",
  );
console.log(
  "Authenticated demo smoke passed for the seeded organization, tank, and device.",
);
