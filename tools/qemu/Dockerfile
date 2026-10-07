FROM rust:1.88-bookworm AS bridge
RUN apt-get update && apt-get install -y --no-install-recommends libegl1-mesa-dev libgles2-mesa-dev libvulkan-dev libwayland-dev libxkbcommon-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY hosts/linux/native/Cargo.toml hosts/linux/native/Cargo.lock ./
COPY hosts/linux/native/src ./src
RUN cargo build --locked --release

FROM debian:bookworm AS hermes-runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake git libicu-dev libreadline-dev ninja-build python3 && \
    rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch hermes-v250829098.0.10 \
    https://github.com/facebook/hermes.git /src/hermes
COPY hosts/linux/hermes /src/hermes/tools/sevyn-host
COPY hosts/linux/dist/hermes-application-runtime.js /tmp/hermes-application-runtime.js
RUN printf '\nadd_subdirectory(tools/sevyn-host)\n' >> /src/hermes/CMakeLists.txt && \
    cmake -S /src/hermes -B /src/hermes-build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_DEBUGGER=OFF \
      -DHERMES_BUILD_APPLE_FRAMEWORK=OFF && \
    cmake --build /src/hermes-build --target sevyn-hermes-host hermesc -j 4 && \
    /src/hermes-build/bin/hermesc -O -emit-binary -out \
      /tmp/hermes-application-runtime.hbc /tmp/hermes-application-runtime.js

FROM node:24-bookworm-slim AS node-runtime
# sharp (native JPEG decoder for the browser screencast pipeline) is external
# to the esbuild bundle; installed here where npm exists, then copied into
# the final image at /opt/sevynos where the bundle resolves it at runtime.
RUN npm install --prefix /opt/sevynos --omit=dev sharp@0.35.4

FROM node-runtime AS studio-tools
RUN npm install --prefix /opt/sevynos/studio-tools --omit=dev esbuild@0.25.12

# code-server (Sevyn Code IDE backend) — installed from the official release
# tarball for reproducibility. Runs bound to 127.0.0.1 only; the SevynOS
# host streams it via CDP screencast, never exposed to the network.
FROM node-runtime AS sevyn-code-server
ARG CODE_SERVER_VERSION=4.104.2
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" \
    | tar -xz -C /opt \
    && mv "/opt/code-server-${CODE_SERVER_VERSION}-linux-amd64" /opt/code-server \
    && ln -s /opt/code-server/bin/code-server /usr/local/bin/code-server

FROM debian:bookworm-slim AS image
ARG SEVYN_OS_VERSION=0.1.0
RUN (sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || sed -i 's/main/main contrib non-free non-free-firmware/' /etc/apt/sources.list 2>/dev/null || true) && \
    apt-get update && apt-get install -y --no-install-recommends \
    acpid at-spi2-core busybox-static chromium chromium-sandbox cpio dialog dosfstools e2fsprogs efibootmgr fonts-dejavu-core gzip grub-common grub2-common grub-efi-amd64-bin grub-pc-bin iproute2 libglib2.0-bin libnotify-bin live-boot linux-image-amd64 libxkbcommon0 os-prober parted python3 python3-pil speech-dispatcher squashfs-tools tzdata udev weston zstd ntfs-3g exfatprogs \
    libgl1-mesa-dri libegl-mesa0 libgbm1 libgles2 libglx-mesa0 mesa-va-drivers mesa-vulkan-drivers mesa-utils pciutils usbutils \
    alsa-utils alsa-ucm-conf pipewire pipewire-audio geoclue-2.0 geoclue-2-demo bluez iio-sensor-proxy fprintd libpam-fprintd firmware-sof-signed \
    firmware-amd-graphics firmware-iwlwifi firmware-realtek firmware-atheros firmware-brcm80211 firmware-misc-nonfree \
    wpasupplicant wireless-tools rfkill wireless-regdb fonts-font-awesome \
    v4l-utils ffmpeg sudo passwd && rm -rf /var/lib/apt/lists/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=studio-tools /opt/sevynos/studio-tools /opt/sevynos/studio-tools
COPY --from=sevyn-code-server /opt/code-server /opt/code-server
COPY --from=sevyn-code-server /usr/local/bin/code-server /usr/local/bin/code-server
COPY --from=hermes-runtime /src/hermes-build/bin/hermesc /usr/local/lib/sevynos/hermesc
COPY --from=bridge /src/target/release/sevyn-wayland-bridge /usr/local/bin/sevyn-wayland-bridge
COPY --from=hermes-runtime /src/hermes-build/bin/sevyn-hermes-host /usr/local/bin/sevyn-hermes-host
COPY --from=hermes-runtime /tmp/hermes-application-runtime.hbc /opt/sevynos/hermes-application-runtime.hbc
COPY --from=node-runtime /opt/sevynos /opt/sevynos
COPY hosts/linux/dist/genesis-wayland.mjs /opt/sevynos/genesis-wayland.mjs
COPY hosts/linux/dist/third-party-application-process.mjs /opt/sevynos/third-party-application-process.mjs
COPY hosts/linux/native/smoke-wayland.py /usr/local/lib/sevynos/smoke-wayland.py
COPY tools/qemu/build-font-atlas.py /usr/local/lib/sevynos/build-font-atlas.py
COPY tools/qemu/generate-demo-audio.py /usr/local/lib/sevynos/generate-demo-audio.py
COPY hosts/linux/native/smoke-wayland.sh /usr/local/bin/smoke-wayland
COPY tools/qemu/init /init
# Sevyn CLI — the only shell users ever see (no bash, no Linux shell)
COPY tools/qemu/sevyn /usr/local/bin/sevyn
RUN chmod +x /usr/local/bin/sevyn
# Sevyn Code (code-server) configuration: Open VSX registry, Sevyn CLI terminal
# Installed to the default user's config locations; code-server runs as that user.
COPY tools/qemu/sevyn-code-server-config.yaml /etc/sevyn/code-server-config.yaml
COPY tools/qemu/sevyn-code-server-settings.json /etc/sevyn/code-server-settings.json
COPY tools/qemu/default.script /usr/share/udhcpc/default.script
COPY tools/qemu/weston.ini /etc/xdg/weston/weston.ini
COPY tools/qemu/wpa_supplicant.conf /etc/sevynos/wpa_supplicant.conf
COPY tools/qemu/start-genesis.sh /usr/local/bin/start-genesis
COPY tools/qemu/request-shutdown.sh /usr/local/bin/request-genesis-shutdown
COPY tools/qemu/sevyn-installer.sh /usr/local/bin/sevyn-installer
COPY tools/qemu/sevyn-installer-chroot.sh /usr/local/bin/sevyn-installer-chroot
COPY tools/qemu/installer-accounts.mjs /usr/local/lib/sevyn-installer-accounts.mjs
COPY tools/qemu/installer-partition-plan.mjs /usr/local/lib/sevyn-installer-partition-plan.mjs
COPY tools/qemu/sevyn-installed-init /usr/local/lib/sevynos/installed-init
COPY tools/qemu/sevyn-apply-update.sh /usr/local/lib/sevynos/apply-update
COPY tools/qemu/sevyn-installer.desktop /usr/share/applications/sevyn-installer.desktop
COPY tools/qemu/acpi-power-button /etc/acpi/events/sevyn-power-button
COPY tools/qemu/usb-automount.rules /etc/udev/rules.d/99-sevyn-usb-automount.rules
COPY tools/qemu/sevyn-usb-mount.sh /usr/local/bin/sevyn-usb-mount
COPY tools/qemu/sevyn-usb-unmount.sh /usr/local/bin/sevyn-usb-unmount
# Update trust anchor (public keys only — the private signing key never
# enters the image). Staged by tools/qemu/build.mjs from
# SEVYN_UPDATE_TRUSTED_KEYS; an empty "keys" array means dev build.
COPY tools/qemu/build/trusted-update-keys.json /etc/sevynos/trusted-update-keys.json
COPY tools/qemu/build-image.sh /usr/local/bin/build-sevyn-image
COPY tools/qemu/sevyn-studio-builder.mjs /usr/local/bin/sevyn-studio-build
RUN mkdir -p /usr/local/share/sevynos && ln -s /opt/sevynos/studio-tools/node_modules/esbuild/bin/esbuild /usr/local/lib/sevynos/esbuild && python3 /usr/local/lib/sevynos/build-font-atlas.py /usr/local/share/sevynos/font-atlas.json && \
    python3 /usr/local/lib/sevynos/generate-demo-audio.py /tmp/sevyn-demo-audio && mkdir -p /usr/share/sevyn/music && \
    ffmpeg -nostdin -loglevel error -i /tmp/sevyn-demo-audio/genesis-horizon.wav /usr/share/sevyn/music/genesis-horizon.flac && \
    ffmpeg -nostdin -loglevel error -i /tmp/sevyn-demo-audio/silicon-pulse.wav /usr/share/sevyn/music/silicon-pulse.mp3 && \
    ffmpeg -nostdin -loglevel error -i /tmp/sevyn-demo-audio/nebula-drift.wav /usr/share/sevyn/music/nebula-drift.ogg && \
    cp /tmp/sevyn-demo-audio/digital-dawn.wav /usr/share/sevyn/music/digital-dawn.wav && \
    ffmpeg -nostdin -loglevel error -i /tmp/sevyn-demo-audio/midnight-terminal.wav /usr/share/sevyn/music/midnight-terminal.m4a && rm -rf /tmp/sevyn-demo-audio && \
    mkdir -p /etc/udhcpc && cp /usr/share/udhcpc/default.script /etc/udhcpc/default.script && chmod 0755 /init /usr/local/bin/start-genesis /usr/local/bin/request-genesis-shutdown /usr/local/bin/sevyn-installer /usr/local/bin/sevyn-installer-chroot /usr/local/bin/sevyn-studio-build /usr/local/lib/sevynos/installed-init /usr/local/lib/sevynos/apply-update /usr/local/lib/sevynos/hermesc /usr/local/lib/sevynos/esbuild /usr/local/bin/smoke-wayland /usr/local/bin/build-sevyn-image /usr/local/bin/sevyn-usb-mount /usr/local/bin/sevyn-usb-unmount /usr/share/udhcpc/default.script /etc/udhcpc/default.script && /usr/local/bin/build-sevyn-image && \
    printf 'VERSION_ID=%s\n' "$SEVYN_OS_VERSION" > /etc/sevynos-release

FROM debian:bookworm-slim AS boot-media
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends grub-common grub-pc-bin grub-efi-amd64-bin mtools xorriso && rm -rf /var/lib/apt/lists/*
COPY --from=image /artifacts /artifacts
COPY tools/qemu/grub.cfg /usr/local/share/sevynos/grub.cfg
COPY tools/qemu/build-live-media.sh /usr/local/bin/build-sevyn-live-media
RUN chmod 0755 /usr/local/bin/build-sevyn-live-media && /usr/local/bin/build-sevyn-live-media

FROM scratch
COPY --from=boot-media /artifacts /
