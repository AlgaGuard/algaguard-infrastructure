#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const target = process.env.DEMO_ENV_FILE ?? ".env";
if (existsSync(target)) {
  process.stderr.write(`${target} already exists; refusing to replace local secrets.\n`);
  process.exit(1);
}

const secretKeys = new Set([
  "POSTGRES_PASSWORD", "KEYCLOAK_ADMIN_PASSWORD", "MINIO_ROOT_PASSWORD",
  "GRAFANA_ADMIN_PASSWORD", "ALGAGUARD_ACCESS_SERVICE_SECRET",
  "ALGAGUARD_DEVICE_SERVICE_SECRET", "ALGAGUARD_MQTT_INGESTION_SERVICE_SECRET",
  "ALGAGUARD_TELEMETRY_SERVICE_SECRET", "ALGAGUARD_REALTIME_SERVICE_SECRET",
  "ALGAGUARD_PROFILE_SERVICE_SECRET", "ALGAGUARD_COMMAND_SERVICE_SECRET",
  "ALGAGUARD_OTA_SERVICE_SECRET", "ALGAGUARD_FIRMWARE_RELEASE_SECRET",
  "BROKER_DEVICE_AUTH_TOKEN", "EMQX_NODE_COOKIE",
]);

const value = () => randomBytes(32).toString("base64url");
const lines = readFileSync(".env.example", "utf8").split(/\r?\n/).map((line) => {
  const [key] = line.split("=", 1);
  return secretKeys.has(key) ? `${key}=${value()}` : line;
});
writeFileSync(target, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`Created ignored ${target} with generated development secrets.\n`);
