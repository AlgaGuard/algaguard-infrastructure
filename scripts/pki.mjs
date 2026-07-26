#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.PKI_DIR ?? ".local/pki");
const marker = path.join(root, ".algaguard-development-pki");
const command = process.argv[2];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function openssl(args) {
  try {
    execFileSync(process.env.OPENSSL ?? "openssl", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch {
    fail("OpenSSL command failed; private material was not printed.");
  }
}

function requireDevelopmentPki() {
  if (!existsSync(marker)) fail("Run pki-init first.");
}

function protect(file) {
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

function refuse(...files) {
  if (files.some(existsSync)) fail("Refusing to overwrite existing PKI material.");
}

function createCa(name, commonName) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  const key = path.join(directory, "ca.key");
  const certificate = path.join(directory, "ca.crt");
  refuse(key, certificate);
  openssl([
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    key,
  ]);
  protect(key);
  openssl([
    "req",
    "-new",
    "-x509",
    "-key",
    key,
    "-sha256",
    "-days",
    "3650",
    "-subj",
    `/CN=${commonName}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-out",
    certificate,
  ]);
}

function sign(name, commonName, caName, extensionLines) {
  requireDevelopmentPki();
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  const key = path.join(directory, "tls.key");
  const csr = path.join(directory, "tls.csr");
  const certificate = path.join(directory, "tls.crt");
  const extensions = path.join(directory, "tls.ext");
  refuse(key, csr, certificate, extensions);
  openssl([
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    key,
  ]);
  protect(key);
  openssl(["req", "-new", "-key", key, "-subj", `/CN=${commonName}`, "-out", csr]);
  writeFileSync(extensions, `${extensionLines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    path.join(root, caName, "ca.crt"),
    "-CAkey",
    path.join(root, caName, "ca.key"),
    "-CAcreateserial",
    "-days",
    "397",
    "-sha256",
    "-extfile",
    extensions,
    "-out",
    certificate,
  ]);
  rmSync(csr);
  rmSync(extensions);
  return certificate;
}

function initialize() {
  if (existsSync(root) && readFileSafe(marker) !== undefined)
    fail("Refusing to overwrite existing PKI material.");
  if (existsSync(root) && !isEmpty(root))
    fail("PKI directory exists and is not an initialized empty directory.");
  mkdirSync(root, { recursive: true });
  writeFileSync(marker, "development-only\n", { mode: 0o600 });
  createCa("device-ca", "AlgaGuard Development Device CA");
  createCa("service-ca", "AlgaGuard Development Service CA");
  process.stdout.write(`Initialized development-only PKI at ${root}\n`);
}

function readFileSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isEmpty(directory) {
  try {
    accessSync(directory);
    return !existsSync(directory) || readdirSync(directory).length === 0;
  } catch {
    return true;
  }
}

function serverCertificate() {
  const certificate = sign("emqx", "emqx", "device-ca", [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:emqx,DNS:localhost,IP:127.0.0.1",
  ]);
  process.stdout.write(`Created development EMQX public certificate ${certificate}\n`);
}

function gatewayCertificate() {
  requireDevelopmentPki();
  const gatewayCa = path.join(root, "gateway-ca", "ca.crt");
  if (!existsSync(gatewayCa)) createCa("gateway-ca", "AlgaGuard Development Gateway CA");
  const hosts = (process.env.PUBLIC_TLS_HOSTS ?? "localhost,127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (!hosts.length || hosts.some((host) => !/^[a-zA-Z0-9.-]+$/.test(host)))
    fail("PUBLIC_TLS_HOSTS must be a comma-separated list of DNS names or IP addresses.");
  const subjectAltName = hosts
    .map((host) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `IP:${host}` : `DNS:${host}`))
    .join(",");
  const certificate = sign("gateway", hosts[0], "gateway-ca", [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=${subjectAltName}`,
  ]);
  process.stdout.write(`Created development gateway certificate ${certificate}\n`);
}

function serviceCertificate(name) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(name ?? ""))
    fail("A lowercase service name is required.");
  const certificate = sign(`services/${name}`, name, "service-ca", [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=clientAuth",
  ]);
  process.stdout.write(`Created development service public certificate ${certificate}\n`);
}

function otaSigningKey() {
  requireDevelopmentPki();
  const directory = path.join(root, "ota-signing");
  mkdirSync(directory, { recursive: true });
  const privateKey = path.join(directory, "signing.key");
  const publicKey = path.join(directory, "signing-public.pem");
  refuse(privateKey, publicKey);
  openssl([
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    privateKey,
  ]);
  protect(privateKey);
  openssl(["pkey", "-in", privateKey, "-pubout", "-out", publicKey]);
  process.stdout.write(`Created development OTA public key ${publicKey}\n`);
}

function deviceCertificate(deviceId, deviceUuid) {
  if (!/^AG-[0-9]{6}$/.test(deviceId ?? "")) fail("DEVICE_ID must match AG-000001.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceUuid ?? ""))
    fail("DEVICE_UUID must be an RFC 4122 version 4 UUID.");
  const certificate = sign(`devices/${deviceId}`, deviceId, "device-ca", [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyAgreement",
    "extendedKeyUsage=clientAuth",
    `subjectAltName=URI:urn:algaguard:device:${deviceUuid}`,
  ]);
  process.stdout.write(`Created development device public certificate ${certificate}\n`);
}

function inspect() {
  requireDevelopmentPki();
  const certificates = [
    path.join(root, "device-ca", "ca.crt"),
    path.join(root, "service-ca", "ca.crt"),
    path.join(root, "emqx", "tls.crt"),
  ].filter(existsSync);
  for (const certificate of certificates) {
    process.stdout.write(`${path.relative(root, certificate)}\n`);
    const output = execFileSync(process.env.OPENSSL ?? "openssl", [
      "x509",
      "-in",
      certificate,
      "-noout",
      "-subject",
      "-issuer",
      "-serial",
      "-dates",
      "-fingerprint",
      "-sha256",
    ], { encoding: "utf8", windowsHide: true });
    process.stdout.write(output);
  }
}

function clean() {
  requireDevelopmentPki();
  if (process.argv[3] !== "--confirm") fail("pki-clean-dev requires --confirm.");
  const expectedSuffix = path.join(".local", "pki").toLowerCase();
  if (!process.env.PKI_DIR && !root.toLowerCase().endsWith(expectedSuffix))
    fail("Refusing to clean an unexpected path.");
  rmSync(root, { recursive: true, force: false });
  process.stdout.write(`Removed development-only PKI at ${root}\n`);
}

switch (command) {
  case "init":
    initialize();
    break;
  case "server-cert":
    serverCertificate();
    break;
  case "gateway-cert":
    gatewayCertificate();
    break;
  case "service-cert":
    serviceCertificate(process.argv[3]);
    break;
  case "ota-signing-key":
    otaSigningKey();
    break;
  case "device-cert":
    deviceCertificate(process.argv[3], process.argv[4]);
    break;
  case "inspect":
    inspect();
    break;
  case "clean-dev":
    clean();
    break;
  default:
    fail("Usage: pki.mjs init|server-cert|gateway-cert|service-cert NAME|ota-signing-key|device-cert DEVICE_ID DEVICE_UUID|inspect|clean-dev --confirm");
}
