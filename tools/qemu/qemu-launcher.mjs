import { spawn } from "node:child_process";
import { resolve } from "node:path";

const RUNNER_IMAGE = "sevynos-qemu-runner";

export function resolveInteractiveHardwareArguments(platform = process.platform) {
  const audioDriver = platform === "darwin" ? "coreaudio" : "pa";
  return [
    "-netdev",
    "user,id=sevyn-net",
    "-device",
    "virtio-net-pci,netdev=sevyn-net",
    "-audiodev",
    `${audioDriver},id=sevyn-audio`,
    "-device",
    "ich9-intel-hda",
    "-device",
    "hda-duplex,audiodev=sevyn-audio",
  ];
}

export async function resolveQemuInvocation(output, qemuArguments, options = {}) {
  const configuredBinary = process.env["SEVYN_QEMU_BINARY"];
  if (configuredBinary !== undefined)
    return { command: configuredBinary, arguments: qemuArguments };

  if (await succeeds("qemu-system-x86_64", ["--version"]))
    return {
      command: "qemu-system-x86_64",
      arguments: resolveLocalQemuArguments(qemuArguments),
    };

  if (options.visible === true)
    throw new Error(
      "Visible QEMU mode requires a local QEMU installation. Install it with `brew install qemu`, then run `pnpm qemu:run` again.",
    );

  if (!(await succeeds("docker", ["version", "--format", "{{.Server.Version}}"])))
    throw new Error(
      "QEMU is not installed and Docker is unavailable. Install QEMU with `brew install qemu`, start Docker Desktop, or set SEVYN_QEMU_BINARY.",
    );

  if (!(await succeeds("docker", ["image", "inspect", RUNNER_IMAGE]))) {
    await execute("docker", [
      "build",
      "--file",
      resolve(import.meta.dirname, "Dockerfile.runner"),
      "--tag",
      RUNNER_IMAGE,
      import.meta.dirname,
    ]);
  }

  return {
    command: "docker",
    arguments: [
      "run",
      "--rm",
      "-v",
      `${output}:/sevyn`,
      RUNNER_IMAGE,
      ...containerPaths(qemuArguments),
    ],
  };
}

export function resolveLocalQemuArguments(
  qemuArguments,
  platform = process.platform,
  architecture = process.arch,
) {
  if (
    platform !== "darwin" ||
    architecture !== "x64" ||
    hasExplicitAccelerator(qemuArguments)
  )
    return [...qemuArguments];
  return ["-accel", "hvf", ...qemuArguments];
}

function hasExplicitAccelerator(argumentsValue) {
  return argumentsValue.some(
    (argument, index) =>
      argument === "-accel" ||
      argument.startsWith("-accel=") ||
      (argumentsValue[index - 1] === "-machine" && argument.includes("accel=")),
  );
}

function containerPaths(arguments_) {
  return arguments_.map((argument) =>
    argument.startsWith(`${resolve(import.meta.dirname, "build")}/`)
      ? `/sevyn/${argument.slice(argument.lastIndexOf("/") + 1)}`
      : argument,
  );
}

function succeeds(command, arguments_) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, arguments_, { stdio: "ignore" });
    child.once("error", () => resolvePromise(false));
    child.once("exit", (code) => resolvePromise(code === 0));
  });
}

function execute(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} exited with ${String(code)}.`)),
    );
  });
}
