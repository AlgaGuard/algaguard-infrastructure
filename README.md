# AlgaGuard portable infrastructure

Docker Compose-first development platform for the temporary AWS EC2 host and the final campus Linux host. The same Linux containers and configuration interfaces are used in both locations; no AWS-managed core service is required.

## Local use

```powershell
Copy-Item .env.example .env
make check
make up
make logs
make down
```

On a POSIX shell, use `cp .env.example .env` instead. The host development MQTT endpoint is `mqtt://localhost:11883`; containers use `mqtt://emqx:1883`. The non-default host port avoids collisions with an independently installed local broker.

Run the device-identity proof with `make e2e`. It builds the identity-path services, applies their explicit migrations, starts the stack, and tests Keycloak users/service clients, claim/bootstrap, canonical MQTT ingestion, UUID authorization, committed-event routing, restart persistence, ownership transfer, historical isolation, negative inputs, and duplicate replay. The script stops containers without deleting named volumes.

Application services bind only to host loopback in development. NGINX does not route the authenticated Device Service context endpoint; backend services reach it on the private Compose network with client-credentials tokens.

The supplied values are development-only placeholders. WSS/HTTPS/MQTT TLS uses locally generated certificates mounted under `certs/`; certificate generation and trust-store installation are documented in [local TLS](docs/local-tls.md). No certificate private key is committed.

No AWS or campus deployment has been performed by this repository. See [deployment notes](docs/deployment-targets.md).
AlgaGuard platform-first implementation repository
