import https from "node:https";
import { readFileSync } from "node:fs";

const ca = readFileSync(".local/pki/gateway-ca/ca.crt");
const requests = [
  ["https://localhost:8443/", 200],
  ["https://localhost:8443/api/health/ready", 200],
  ["https://localhost:8443/auth/realms/algaguard/.well-known/openid-configuration", 200],
];

for (const [url, expected] of requests) {
  await new Promise((resolve, reject) => {
    https.get(url, { ca, servername: "localhost" }, (response) => {
      response.resume();
      response.statusCode === expected
        ? resolve()
        : reject(new Error(`${url} returned ${response.statusCode}, expected ${expected}`));
    }).on("error", reject);
  });
}
console.log("Gateway transport smoke passed with the local development CA.");
