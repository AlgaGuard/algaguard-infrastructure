ENV_FILE ?= .env
COMPOSE = docker compose --env-file $(ENV_FILE)

.PHONY: up down logs check smoke app-up app-down e2e credential-e2e pki-init pki-server-cert pki-gateway-cert pki-service-cert pki-ota-signing-key pki-device-cert pki-inspect pki-clean-dev demo-env-init demo-env-check demo-up demo-migrate demo-health demo-smoke demo-logs demo-stop demo-reset-destructive

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200

check:
	docker compose --env-file .env.example config --quiet

smoke:
	sh scripts/smoke.sh

app-up:
	$(COMPOSE) -f compose.yaml -f compose.application.yaml up -d --build

app-down:
	$(COMPOSE) -f compose.yaml -f compose.application.yaml down

e2e:
	sh scripts/credential-e2e.sh

credential-e2e:
	sh scripts/credential-e2e.sh

pki-init:
	node scripts/pki.mjs init

pki-server-cert:
	node scripts/pki.mjs server-cert

pki-gateway-cert:
	node scripts/pki.mjs gateway-cert

pki-service-cert:
	node scripts/pki.mjs service-cert "$(SERVICE_NAME)"

pki-ota-signing-key:
	node scripts/pki.mjs ota-signing-key

pki-device-cert:
	node scripts/pki.mjs device-cert "$(DEVICE_ID)" "$(DEVICE_UUID)"

pki-inspect:
	node scripts/pki.mjs inspect

pki-clean-dev:
	node scripts/pki.mjs clean-dev --confirm

demo-env-check: check

demo-env-init:
	node scripts/demo-env.mjs

demo-up:
	$(COMPOSE) -f compose.yaml -f compose.application.yaml up -d --build

demo-migrate:
	$(COMPOSE) -f compose.yaml -f compose.application.yaml run --rm --no-deps access-service node dist/scripts/migrate.js
	$(COMPOSE) -f compose.yaml -f compose.application.yaml run --rm --no-deps device-service node dist/scripts/migrate.js
	$(COMPOSE) -f compose.yaml -f compose.application.yaml run --rm --no-deps profile-service node dist/scripts/migrate.js
	$(COMPOSE) -f compose.yaml -f compose.application.yaml run --rm --no-deps telemetry-service node dist/scripts/migrate.js
	$(COMPOSE) -f compose.yaml -f compose.application.yaml run --rm --no-deps mqtt-ingestion-service node dist/scripts/migrate.js
	$(COMPOSE) -f compose.yaml -f compose.application.yaml run --rm --no-deps command-service node dist/scripts/migrate.js
	$(COMPOSE) -f compose.yaml -f compose.application.yaml run --rm --no-deps ota-service node dist/scripts/migrate.js

demo-health:
	node scripts/demo-health.mjs

demo-smoke:
	node scripts/demo-smoke.mjs

demo-logs:
	$(COMPOSE) -f compose.yaml -f compose.application.yaml logs -f --tail=200

demo-stop:
	$(COMPOSE) -f compose.yaml -f compose.application.yaml down

demo-reset-destructive:
	$(COMPOSE) -f compose.yaml -f compose.application.yaml down --volumes --remove-orphans
