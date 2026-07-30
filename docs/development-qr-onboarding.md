# Development QR onboarding control

QR onboarding is disabled by default and can run only in the development
Device Service. The protected `qr-onboarding.yml` workflow controls a bounded
window through SSM; it never exposes the signing key in workflow output.
The enable action accepts only a 10- or 15-minute window and installs a host
timer that invokes the same fail-closed disable path automatically. Manual
disable cancels the pending timer.

The private P-256 signing key is stored only as the encrypted SecureString
`/algaguard/development/qr-onboarding-signing-private-key-pkcs8`. Enabling
injects it into the restricted runtime environment and restarts only Device
Service. Disabling removes both the key and runtime override. The legacy
physical handoff remains independently disabled.

The compact OLED QR is public invitation data, not an enrollment credential.
Authentication, ownership, lifecycle, nonce replay, BLE binding, and CSR
issuance checks remain authoritative.
