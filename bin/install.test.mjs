import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const binary = `#!/bin/sh
case "$1" in
  --version) echo "yas 1.2.3" ;;
  --license) echo MIT ;;
  generate) mkdir -p "$2/man" && echo completion > "$2/man/yas.1" ;;
  *) exit 1 ;;
esac
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "yas-install-test-"));
  const home = join(dir, "owner's home");
  const commands = join(dir, "commands");
  const archive = join(dir, "release.tar.gz");
  const elevationLog = join(dir, "elevation.log");
  const payload = join(dir, "payload");
  for (const path of [home, commands, join(payload, "bin")]) {
    mkdirSync(path, { recursive: true });
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(payload, "bin/yas"), binary, { mode: 0o755 });
  const tar = spawnSync("tar", ["-czf", archive, "-C", payload, "bin"]);
  assert.equal(tar.status, 0, tar.stderr.toString());
  writeFileSync(join(commands, "curl"), '#!/bin/sh\ncat "$TEST_ARCHIVE"\n', {
    mode: 0o755,
  });
  // Simulate elevation by making a test-owned directory writable. Never run
  // real sudo/doas, even when testing the system-prefix fallback.
  for (const command of ["sudo", "doas"]) {
    writeFileSync(
      join(commands, command),
      `#!/bin/sh
echo "$0 $*" >> "$TEST_ELEVATION_LOG"
chmod u+w "$TEST_PREFIX/bin"
exec "$@"
`,
      { mode: 0o755 },
    );
  }
  const prefix = join(home, ".local");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${commands}:${prefix}/bin:${process.env.PATH}`,
    YAS_PREFIX: "",
    YAS_INSTALL_DIR: "",
    YAS_GPL: "",
    TEST_ARCHIVE: archive,
    TEST_ELEVATION_LOG: elevationLog,
  };
  return {
    dir,
    home,
    prefix,
    elevationLog,
    run(overrides = {}) {
      return spawnSync("sh", [installer], {
        env: { ...env, TEST_PREFIX: prefix, ...overrides },
        encoding: "utf8",
        timeout: 10_000,
      });
    },
  };
}

test("fresh personal installs and upgrades stay owned by the invoking user", (t) => {
  const f = fixture(t);
  const installed = join(f.prefix, "bin/yas");
  for (const upgrading of [false, true]) {
    if (upgrading) {
      writeFileSync(installed, binary.replace("1.2.3", "1.2.2"));
      chmodSync(installed, 0o555);
    }
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(installed, "utf8"), binary);
    for (const path of [installed, join(f.prefix, "share/man/yas.1")]) {
      assert.equal(statSync(path).uid, process.getuid());
    }
    assert.equal(existsSync(f.elevationLog), false);
  }
});

const needsUnprivilegedUser = {
  skip: process.getuid?.() === 0 ? "requires unprivileged writes" : false,
};

for (const selection of ["default", "explicit", "legacy", "home"]) {
  test(
    `unwritable personal installs refuse elevation (${selection} prefix)`,
    needsUnprivilegedUser,
    (t) => {
      const f = fixture(t);
      const prefix = selection === "home" ? f.home : f.prefix;
      const bin = join(prefix, "bin");
      mkdirSync(bin, { recursive: true });
      chmodSync(bin, 0o555);
      t.after(() => {
        if (existsSync(bin)) chmodSync(bin, 0o755);
      });
      const overrides =
        selection === "default"
          ? {}
          : selection === "legacy"
            ? { YAS_INSTALL_DIR: bin }
            : { YAS_PREFIX: prefix };
      const result = f.run({ TEST_PREFIX: prefix, ...overrides });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fix its ownership or permissions/);
      assert.equal(existsSync(f.elevationLog), false);
      assert.equal(existsSync(join(bin, "yas")), false);
      assert.equal(existsSync(join(prefix, "share")), false);
    },
  );
}

test(
  "system prefixes retain the elevation fallback",
  needsUnprivilegedUser,
  (t) => {
    const f = fixture(t);
    // A sibling sharing HOME's spelling is still outside the home directory.
    const prefix = `${f.home}-system`;
    mkdirSync(join(prefix, "bin"), { recursive: true });
    chmodSync(join(prefix, "bin"), 0o555);
    const result = f.run({ YAS_PREFIX: prefix, TEST_PREFIX: prefix });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(f.elevationLog, "utf8"), /sudo/);
    assert.equal(readFileSync(join(prefix, "bin/yas"), "utf8"), binary);
    assert.equal(existsSync(join(prefix, "share/man/yas.1")), true);
  },
);
