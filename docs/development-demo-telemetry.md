# Protected development telemetry simulator control

The `demo-simulator` Compose profile is absent from normal startup and the
simulator feature flag defaults to `0`. The protected GitHub Actions workflow
uses the `development` environment, OIDC, and SSM Run Command to invoke the
host controller with `start`, `stop`, or `status`. No public control endpoint or
port is created.

The controller is idempotent, validates the immutable release configuration,
and emits only `DEMO_SIMULATOR_DISABLED`, `DEMO_SIMULATOR_STARTING`,
`DEMO_SIMULATOR_RUNNING`, `DEMO_SIMULATOR_STOPPED`, or
`DEMO_SIMULATOR_FAILED`. The worker fails closed unless exactly one claimed
development device is eligible. Stop removes the simulator container and
runtime override; regular services and ownership records are untouched.
