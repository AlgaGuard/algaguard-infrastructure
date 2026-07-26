import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = readFileSync(
  new URL("../compose.application.yaml", import.meta.url),
  "utf8",
);
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");

test("Compose keeps the token issuer public and Docker Keycloak endpoints private", () => {
  assert.match(
    compose,
    /KEYCLOAK_ISSUER: \$\{PUBLIC_KEYCLOAK_URL\}\/realms\/algaguard/,
  );
  assert.match(
    compose,
    /KEYCLOAK_JWKS_URL: http:\/\/keycloak:8080\/realms\/algaguard\/protocol\/openid-connect\/certs/,
  );
  assert.match(
    compose,
    /KEYCLOAK_TOKEN_URL: http:\/\/keycloak:8080\/realms\/algaguard\/protocol\/openid-connect\/token/,
  );
  assert.doesNotMatch(compose, /KEYCLOAK_ISSUER: http:\/\/keycloak:8080/);
});

test("development demo seeding and authenticated smoke remain explicit workflow steps", () => {
  assert.match(
    makefile,
    /demo-seed:\s*\n\tnode scripts\/demo-seed\.mjs --confirm-development/,
  );
  assert.match(makefile, /demo-smoke:\s*\n\tnode scripts\/demo-smoke\.mjs/);
});
