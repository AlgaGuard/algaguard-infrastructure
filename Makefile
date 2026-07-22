ENV_FILE ?= .env
COMPOSE = docker compose --env-file $(ENV_FILE)

.PHONY: up down logs check smoke app-up app-down e2e

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
	sh scripts/e2e.sh
