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

On a POSIX shell, use `cp .env.example .env` instead. Plaintext MQTT is disabled. Devices use mutual TLS at `mqtts://localhost:8883`; backend MQTT clients use the Compose-only `mqtts://emqx:8884` listener with certificates from a separate development service CA.

## Development PKI and authenticated credential proof

The development PKI is explicit and provider-independent. It writes private material only under the Git-ignored `.local/pki` directory, refuses to overwrite existing keys, and is not a production CA:

```powershell
make pki-init
make pki-server-cert
make pki-service-cert SERVICE_NAME=algaguard-mqtt-ingestion-service
make pki-service-cert SERVICE_NAME=algaguard-command-service
make pki-service-cert SERVICE_NAME=algaguard-ota-service
make pki-ota-signing-key
make pki-inspect
```

`make pki-device-cert DEVICE_ID=AG-000001 DEVICE_UUID=<uuid>` creates a development-only diagnostic device certificate. The application bootstrap flow instead generates the private key and CSR in the simulator and sends only the CSR to Device Service. `make pki-clean-dev` is the explicit destructive cleanup command.

After generating the server and service credentials above, run `make credential-e2e`. The runner deletes only the dedicated `algaguard-credential-e2e` test volumes, builds and migrates the services, and validates certificate bootstrap, wrong-CA/unknown/expired/mismatched rejection, exact device-topic ACLs, telemetry acknowledgement, realtime delivery, profile/command/OTA flows, rotation, old-certificate denial, service recovery, and revocation across a full stop/restart without deleting volumes. It records safe evidence under the ignored `.local/evidence` directory and removes containers without deleting the resulting volumes.

`make e2e` remains as an alias for `make credential-e2e`; the authenticated credential proof replaces the older pre-authentication vertical slice. Lower-level identity regression tests remain in their owning service repositories.

Application services bind only to host loopback in development. NGINX does not route the authenticated Device Service context endpoint; backend services reach it on the private Compose network with client-credentials tokens.

The supplied values are development-only placeholders. Device and service certificate paths are mounted from `.local/pki`; Compose stages only the EMQX server key and public trust certificates into a broker-owned volume so `0600` key permissions remain portable across host user IDs. CA private keys and service client keys are not exposed to the broker. Existing WSS/HTTPS certificate generation and trust-store installation are documented in [local TLS](docs/local-tls.md). No certificate private key is committed. Production CA selection remains open behind the Device Service CA interface.

No AWS or campus deployment has been performed by this repository. See [deployment notes](docs/deployment-targets.md).
AlgaGuard platform-first implementation repository
