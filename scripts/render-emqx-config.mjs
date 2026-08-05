#!/usr/bin/env node
// EMQX's rule-engine action/connector config (unlike its core listener and
// authentication config) does not support ${ENV_VAR} interpolation or
// EMQX_A__B__C-style environment overrides -- verified empirically against a
// live EMQX 5.8 instance, where both approaches were silently ignored. The
// broker device-auth token therefore has to be substituted into base.hocon
// as a literal before the file is mounted, the same way scripts/pki.mjs
// renders secret-bearing material into the release directory. This does a
// plain, non-regex string replacement (never interprets the token as a
// pattern or special replacement sequence).
import { readFileSync, writeFileSync } from "node:fs";

const [, , path] = process.argv;
const token = process.env.BROKER_DEVICE_AUTH_TOKEN;

if (!path) {
  process.stderr.write("Usage: render-emqx-config.mjs <path-to-base.hocon>\n");
  process.exit(1);
}
if (!token) {
  process.stderr.write("BROKER_DEVICE_AUTH_TOKEN is required.\n");
  process.exit(1);
}

const placeholder = "__BROKER_DEVICE_AUTH_TOKEN__";
const original = readFileSync(path, "utf8");
if (!original.includes(placeholder)) {
  process.stderr.write(`${placeholder} was not found in ${path}.\n`);
  process.exit(1);
}
writeFileSync(path, original.split(placeholder).join(token));
