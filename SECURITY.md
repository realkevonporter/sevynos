# Security policy

SevynOS is in early development and does not yet provide a production security
guarantee. Supported security reports currently cover the latest `main` branch.

Do not open a public issue for a suspected vulnerability. Email
`kevonporter@outlook.com` with a description, affected component, reproduction,
impact, and any suggested mitigation. Remove secrets and unrelated personal
data from logs before sending them.

Please allow a reasonable period for acknowledgement and remediation before
public disclosure. The project will coordinate credit and disclosure timing
with the reporter when practical.

Security-sensitive areas include application package validation, permissions,
service brokering, process isolation, filesystem boundaries, installer disk
selection, update integrity, native IPC, and handling of untrusted media or
network data.
