import { spawnSync } from "node:child_process";

const files = ["--env-file", ".env", "-f", "compose.yaml", "-f", "compose.application.yaml"];
const result = spawnSync("docker", ["compose", ...files, "ps", "--format", "json"], {
  encoding: "utf8",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const required = new Set([
  "nginx", "keycloak", "emqx", "timescaledb", "redis", "minio", "api-gateway",
  "access-service", "device-service", "profile-service", "mqtt-ingestion-service",
  "telemetry-service", "command-service", "ota-service", "realtime-service", "web-dashboard",
]);
const containers = result.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const unhealthy = containers.filter(
  (container) =>
    required.has(container.Service) &&
    !/\bhealthy\b|\bUp\b/i.test(`${container.Health ?? ""} ${container.Status ?? ""}`),
);
const missing = [...required].filter((service) => !containers.some((container) => container.Service === service));
if (unhealthy.length || missing.length) {
  console.error(`Required services not ready: ${[...missing, ...unhealthy.map((item) => item.Service)].join(", ")}`);
  process.exit(1);
}
console.log(`Development stack healthy (${required.size} required services).`);
