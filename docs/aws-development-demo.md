# AWS development demo

The Thursday demo uses one SSM-managed Amazon Linux `t3.micro` instance with a
30 GiB encrypted gp3 root volume, a persistent 2 GiB swap file, and an Elastic
IP. Only ports 80 and 443 are public; SSH, databases, cache, admin services, and
MQTT stay closed. GitHub Actions assumes exact repository/environment OIDC
roles and deploys immutable commit-SHA images by SSM Run Command. Runtime
secrets are read from `/algaguard/development/` in SSM.

The public names are `algaguard.bosilu.dev`, `api.algaguard.bosilu.dev`,
`auth.algaguard.bosilu.dev`, and `realtime.algaguard.bosilu.dev`.
`mqtt.algaguard.bosilu.dev` is reserved and not exposed in D1.

Stopping EC2 makes the application unavailable but preserves the Elastic IP,
DNS mapping, and encrypted EBS. EBS and public IPv4 charges continue while the
instance is stopped.

## DNS and TLS

Create `A` records for `algaguard`, `api.algaguard`, `auth.algaguard`, and
`realtime.algaguard` at Porkbun, all targeting the stack Elastic IP. The
deployment refuses certificate issuance until all four names resolve to the
expected address. NGINX redirects HTTP to HTTPS and serves only a publicly
trusted certificate for those names. A systemd timer performs bounded renewal
checks. MQTT remains closed.

## Immutable deployment

The `Development deployment` workflow accepts the exact heads of the five
authoritative branches, proves they match GitHub, builds application images
from immutable SHAs, and pushes them to private ECR. It uploads a safe release
bundle to the encrypted private backup bucket and invokes the EC2 host through
SSM. The host reads runtime values directly from KMS-backed SecureStrings under
`/algaguard/development/`; GitHub Actions never receives those plaintexts.
Rollback switches the `current` release link back to the preceding immutable
manifest if health checks fail. No image uses a mutable `latest` deployment
tag.

## Operations and recovery

```powershell
aws ec2 stop-instances --region ap-southeast-1 --instance-ids <instance-id>
aws ec2 start-instances --region ap-southeast-1 --instance-ids <instance-id>
aws ssm send-command --region ap-southeast-1 --instance-ids <instance-id> `
  --document-name AWS-RunShellScript `
  --parameters commands="systemctl status algaguard-development.service"
```

The stack is enabled at boot and Docker uses persistent encrypted EBS volumes.
The swap file is created with mode `0600`, registered in `/etc/fstab`, and
enabled idempotently by both first-boot and deployment scripts. Swap reduces
the risk of an abrupt OOM kill but does not add CPU or make a 1 GiB instance
equivalent to the former `t3.large`; health checks remain the acceptance gate.

The daily backup command is `/opt/algaguard/bin/backup-development`; the
synthetic restore proof is `/opt/algaguard/bin/verify-backup-restore`. Backups
are encrypted and private, expire after 14 days, and noncurrent versions expire
after 7 days.

The infrastructure profile is intentionally bounded to `t3.micro` and 30 GiB,
which are common EC2 Free Tier dimensions. Free Tier eligibility is
account- and offer-dependent, and it is not a hard spending cap. Public IPv4,
EBS retained after instance termination, snapshots, ECR, DNS, transfer, and
usage after credits or eligibility expire can still incur charges. Keep the
existing USD 20 budget alert, review Cost Explorer and Free Tier usage, and stop
the instance when it is not needed. The Elastic IP preserves stable DNS across
stop/start, but public IPv4 and EBS can continue to accrue charges while the
application is stopped.

The former 50 GiB root volume cannot be shrunk in place. Migration therefore
uses a new 30 GiB encrypted root volume, an encrypted private backup, and
health-checked data restoration. The old host or recovery artifact is removed
only after the replacement passes public HTTPS and application checks.

`/opt/algaguard/bin/backup-development-migration` briefly stops the stack and
Docker to capture consistent Docker volumes, runtime PKI, and public TLS state.
It uploads an AES-256 encrypted archive plus a SHA-256 checksum to the private
backup bucket. On a replacement host,
`/opt/algaguard/bin/restore-development-migration <object-key>` verifies the
checksum, restores the state while Docker is stopped, and rolls back its local
changes if extraction or service startup fails. Never use the migration archive
as a public artifact.

## Owned-device bootstrap recovery

`ALGAGUARD_ENABLE_OWNED_DEVICE_BOOTSTRAP_REISSUE` defaults to `0`. It may be
set to `1` only for a bounded development/demo recovery window. The Device
Service then permits an authenticated current owner to request one short-lived
bootstrap session for an existing claimed device. The operation rejects an
active session, does not create a claim/device/ownership record, does not alter
`ownershipVersion`, returns the token only once with `Cache-Control: no-store`,
and stores only its hash. Disable the flag after the replacement session is
issued. Physical-session handoff remains a separate default-off feature with a
separate ephemeral wrapping key.

On the development host, the root-owned
`/opt/algaguard/current/scripts/set-development-recovery-window.sh` command
provides the bounded operational transition. `enable-reissue` enables only the
owned-device reissue route. `enable-handoff` disables reissue, creates a fresh
32-byte wrapping key directly inside the mode-0600 runtime environment, and
enables only the handoff routes. `disable-all` removes the wrapping key and
the development timing override, then returns both features to their
default-off state. `enable-reissue` and `enable-handoff` apply the same bounded
15-minute server window; the server-returned expiry remains authoritative.
Each transition recreates
only Device Service and waits for its health check; the script never prints the
wrapping key.
