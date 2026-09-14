# SevynOS Biometrics Security Architecture & Threat Model

## 1. Executive Summary

SevynOS mobile architecture incorporates a defense-in-depth biometric authentication subsystem mediating access to system unlock, privileged settings, credential release, and application authorization.

Biometric capabilities in SevynOS are strictly capability-gated (`"biometrics"`), sandboxed away from raw POSIX/Linux devices, and backed by a zero-leak hardware keystore vault (`/var/lib/sevynos/keystore/vault.json`).

This document details the biometric security architecture, threat vectors, anti-spoofing countermeasures, cryptographic challenge-response protocol, and keystore security policies.

---

## 2. Architectural Boundaries & Matching Modes

```
+-----------------------------------------------------------------------+
| Guest Application Sandbox (Hermes / Worker)                            |
| - Consumes typed @sevynos/sdk Biometrics API                         |
| - Never handles raw biometric templates, images, or sensor devices     |
+-----------------------------------------------------------------------+
                                  |
                                  | Capability IPC ("biometrics")
                                  v
+-----------------------------------------------------------------------+
| SevynOS Host / Genesis Wayland Compositor                             |
| - LinuxNativeModuleServices / Capability Broker                       |
| - Challenge / Nonce Generator & Session Policy                        |
| - Face Unlock Liveness Pipeline & Anti-Spoofing Evaluator              |
| - Device PIN / Passcode Fallback Verifier                             |
+-----------------------------------------------------------------------+
                |                                       |
                v                                       v
+-------------------------------+       +-------------------------------+
| Match-in-Hardware Subsystem   |       | Keystore Vault Service        |
| - fprintd / TEE / Enclave     |       | - AES-256-GCM Enclave         |
| - On-chip template storage    |       | - Hardware-derived Master Key |
| - Tamper-resistant matching   |       | - Zero-knowledge key release  |
+-------------------------------+       +-------------------------------+
```

### 2.1 Match-in-Hardware vs. Match-in-Software

1. **Match-in-Hardware (Primary Fingerprint Path)**:
   - Fingerprint verification utilizes hardware-backed biometric sensors managed through `fprintd` or platform Secure Processing Units (TEE / Secure Enclave).
   - Biometric sample processing, feature extraction, and template comparison execute entirely within isolated hardware boundaries.
   - Raw minutiae and sensor imagery never enter user-space memory or OS page caches.
   - The host system receives strictly signed boolean match results accompanied by device tokens.

2. **Match-in-Software with Hardened Isolation (Face Unlock Pipeline)**:
   - When dedicated depth/IR coprocessors are absent, face verification utilizes SevynOS's hardened vision pipeline.
   - Face data is processed in ephemeral memory buffers with immediate zeroization after evaluation.
   - Software templates are encrypted at rest with hardware-derived keys and are never exposed over IPC.

---

## 3. Facial Liveness & Anti-Spoofing Pipeline

To prevent presentation attacks (spoofer presenting physical photographs, high-resolution screens, or 3D masks), SevynOS enforces a multi-factor liveness pipeline:

### 3.1 Multi-Modal Sensor Fusion

1. **Infrared (IR) Reflectance Analysis**:
   - Compares active infrared illumination reflection against visible RGB reflectance to distinguish organic human tissue from synthetic materials, photographic paper, and OLED/LCD displays.
2. **Structured Light / Time-of-Flight (ToF) Depth Mapping**:
   - Assesses facial curvature and surface contour gradients. Flat surfaces (smartphones, paper printouts) fail depth variance thresholds ($z$-depth standard deviation $> 15\text{ mm}$).
3. **Micro-Movement and Ocular Motility (Blink Verification)**:
   - Tracks dynamic facial features over a continuous capture window, requiring natural micro-saccades, blink transitions, and respiratory micro-variations. Static representations are rejected.

### 3.2 Anti-Spoofing Evaluation Protocol

- Liveness evaluation produces a composite confidence score:
  $$\text{Score}_{\text{liveness}} = w_{\text{depth}} S_{\text{depth}} + w_{\text{IR}} S_{\text{IR}} + w_{\text{motion}} S_{\text{motion}}$$
- A verification attempt is rejected if $\text{Score}_{\text{liveness}} < 0.85$, even if facial feature recognition indicates a high template match score.

---

## 4. Replay Resistance: Cryptographic Challenge-Response

Biometric verification calls are vulnerable to message interception and replay attacks if not cryptographically bound to an ephemeral session.

### 4.1 Nonce-Based Verification

1. **Challenge Generation**:
   - The caller or Genesis authentication broker requests an ephemeral cryptographic challenge:
     $$\text{Nonce} = \text{CSPRNG}(256\text{ bits})$$
   - The nonce is associated with a 60-second time-to-live (TTL) and recorded in the host session table.
2. **Attestation & Assertion Signing**:
   - The biometric authentication provider binds the verification result to the challenge:
     $$\text{Assertion} = \text{Sign}_{K_{\text{device}}}(\text{Nonce} \parallel \text{CredentialId} \parallel \text{Timestamp} \parallel \text{Status})$$
3. **Nonce Consumption**:
   - The assertion is validated against the stored nonce.
   - The nonce is instantly invalidated upon receipt, preventing replay of previously captured verification tokens.

---

## 5. Hardware Keystore Vault Security

SevynOS hosts a hardware-backed cryptographic vault (`/var/lib/sevynos/keystore/vault.json`) that secures cryptographic keys, biometric binding secrets, and credential metadata.

### 5.1 Key Derivation and Encryption

- **Master Encryption Key (MEK)**: Derived via HKDF / Argon2id from a hardware-fused secret (TPM2 / Secure Key Storage) combined with the device PIN salt.
- **Envelope Encryption**:
  - Vault entries are encrypted with `AES-256-GCM` using unique 96-bit initialization vectors (IV) per entry.
  - Authentication tags (128-bit) verify integrity and prevent ciphertext manipulation.
- **Zero-Leak Memory Management**:
  - Decrypted keys exist only in transient memory during cryptographic execution and are purged with `crypto.randomFillSync()` on completion.

---

## 6. Authentication Fallback Hierarchy

To ensure the device remains accessible under sensor failure or physical impairment while preserving appliance security:

1. **Tier 1: Biometric Authentication (Fingerprint / Face Unlock)**:
   - Primary low-friction unlock mechanism.
   - Limited to 5 consecutive failed attempts before biometric lockout.
2. **Tier 2: Device Master PIN / Passcode**:
   - Required upon device reboot, after 72 hours of inactivity, after 5 biometric failures, or upon modifying security credentials.
   - Rate-limited with exponential backoff to prevent brute-force attacks.
3. **Tier 3: Recovery Key**:
   - Offline cryptographic recovery key for storage restoration if the device PIN is lost.

---

## 7. Threat Vectors & Countermeasures Matrix

| Threat Vector                        | Attack Scenario                                                                | Countermeasure in SevynOS                                                                                                                    |
| :----------------------------------- | :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| **Presentation Attack (Spoofing)**   | Attacker displays photo or video of device owner to camera                     | Multi-modal liveness pipeline requiring depth, IR reflectance, and micro-blink verification (`livenessRequired: true`).                      |
| **Biometric Replay**                 | Attacker replays intercepted biometric success IPC payload                     | Nonce-based challenge-response protocol with single-use CSPRNG tokens and 60s TTL.                                                           |
| **Direct Hardware Tampering**        | Attacker intercepts SPI/I2C sensor lines to inject synthetic minutiae          | Match-in-hardware architecture with cryptographically signed payloads between sensor chip and host kernel.                                   |
| **Cold-Boot / Storage Extraction**   | Attacker reads `/var/lib/sevynos/keystore/vault.json` from offline disk        | Vault is encrypted with AES-256-GCM using hardware-fused TPM/TEE master keys.                                                                |
| **Application Privilege Escalation** | Rogue app attempts to access biometric templates or enroll unauthorized finger | Capability broker enforces strict `"biometrics"` permission; guest sandbox lacks direct POSIX device access or template export capabilities. |
| **Exhaustive Brute-Force**           | Rapid iterative biometric or PIN guessing attempts                             | Exponential backoff lockout: 5 biometric attempts enforce PIN fallback; PIN enforce timed penalties.                                         |
