# AWS development demo

The Thursday demo uses one SSM-managed Amazon Linux EC2 instance with encrypted
EBS and an Elastic IP. Only ports 80 and 443 are public; SSH, databases, cache,
admin services, and MQTT stay closed. GitHub Actions assumes exact
repository/environment OIDC roles and deploys immutable commit-SHA images by
SSM Run Command. Runtime secrets are read from `/algaguard/development/` in SSM.

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
The daily backup command is `/opt/algaguard/bin/backup-development`; the
synthetic restore proof is `/opt/algaguard/bin/verify-backup-restore`. Backups
are encrypted and private, expire after 14 days, and noncurrent versions expire
after 7 days.

At the current Singapore on-demand price of USD 0.1056/hour for `t3.large`, 48
running hours cost about USD 5.07 before storage, public IPv4, ECR, DNS, and
transfer. The expected short demo total is USD 14–18; a USD 20 AWS budget alert
is intentionally stricter than the operator's USD 200 ceiling.
