# Repository working rules

- Docker Compose is the first deployment target; keep every core dependency portable between local, AWS EC2, and campus Linux.
- Do not commit secrets, generated certificates, private keys, database contents, or provider credentials.
- Do not introduce Kafka, Kubernetes, EKS, AWS IoT Core, AppSync, or another mandatory managed dependency in this phase.
- Validate Compose, YAML, shell, health checks, volumes, and development configuration before publishing.
- Never perform destructive automatic database resets or claim a deployment without runtime evidence.
