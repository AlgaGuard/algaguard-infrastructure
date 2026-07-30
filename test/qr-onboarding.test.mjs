import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync('compose.application.yaml', 'utf8');
const cloud = fs.readFileSync('compose.cloud.yaml', 'utf8');
const controller = fs.readFileSync('scripts/set-qr-onboarding.sh', 'utf8');
const workflow = fs.readFileSync('.github/workflows/qr-onboarding.yml', 'utf8');

test('QR onboarding is disabled by default and mapped only to Device Service', () => {
  assert.match(app, /ALGAGUARD_ENABLE_QR_ONBOARDING:-0/);
  assert.match(cloud, /ALGAGUARD_ENABLE_QR_ONBOARDING:-0/);
  assert.match(cloud, /^\s{6}QR_ONBOARDING_SIGNING_PRIVATE_KEY_PKCS8:\s*$/m);
});

test('protected controller injects and removes the signing key without printing it', () => {
  assert.match(controller, /ssm get-parameter[\s\S]*--with-decryption/);
  assert.match(controller, /QR_ONBOARDING_SIGNING_PRIVATE_KEY_PKCS8/);
  assert.match(controller, /ALGAGUARD_ENABLE_QR_ONBOARDING=0/);
  assert.match(controller, /600\|900/);
  assert.match(controller, /systemd-run --quiet/);
  assert.match(controller, /algaguard-qr-onboarding-expiry/);
  assert.doesNotMatch(controller, /cat\s+\"\$secret\"/);
});

test('workflow is exact-SHA OIDC and SSM only', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /git\/ref\/heads\/develop/);
  assert.match(workflow, /ssm send-command/);
  assert.match(workflow, /window_seconds/);
  assert.doesNotMatch(workflow, /ssh|scp/i);
});
