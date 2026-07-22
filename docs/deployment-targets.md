# Portable deployment targets

The initial hosted target is one AWS EC2 Linux VM running Docker Compose. The final target is campus Linux using the same images, environment variables, volumes, health checks, NGINX routes, EMQX topics, and database migrations. DNS, certificates, instance sizing, backup destination, and production secrets remain TBD. GHCR provides images; deployment is manual/protected until evidence supports automation.
