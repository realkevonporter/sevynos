FROM rust:1.88-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends libegl1-mesa-dev libgles2-mesa-dev libvulkan-dev libwayland-dev libxkbcommon-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo test --locked && cargo build --locked --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libxkbcommon0 weston python3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/sevyn-wayland-bridge /usr/local/bin/sevyn-wayland-bridge
COPY smoke-wayland.py /usr/local/lib/sevynos/smoke-wayland.py
COPY smoke-wayland.sh /usr/local/bin/smoke-wayland
CMD ["smoke-wayland"]
