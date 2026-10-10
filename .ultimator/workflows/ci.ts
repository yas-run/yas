// YAS's CI on Forge (xmit-dev/ultimator docs/CI.md), ported from .github/workflows/ci.yml, which runs on GitHub until
// Forge's phase P4. Linux jobs run in sandboxes, with Nix (../lib/steps.ts); packages also on arm64-ci (Linux arm64)
// and crab (macOS arm64); Windows x86_64 on crab-win under emulation. The coverage summary goes to the job's summary;
// there is no sticky pull request comment. The check to require is `ci/ok`.
import {
  cache,
  checkout,
  hashFiles,
  upload,
  workflow,
  type Job,
} from "ultimator:ci";
import { nix, packages, windowsX64, type PackagesLabel } from "../lib/steps.ts";

/** A sandbox job: the repository, Nix, then its steps. */
function linux(
  id: string,
  name: string,
  timeoutMinutes: number,
  steps: Job["steps"],
): Job {
  return {
    id,
    name,
    runsOn: "sandbox",
    timeoutMinutes,
    steps: [checkout(), nix(), ...steps],
  };
}

export default workflow({
  on: { push: { branches: ["main"] }, pullRequest: {} },
  jobs: (ctx) => {
    const platforms: { runner: string; label: PackagesLabel }[] = [
      { runner: "sandbox", label: "linux-x86_64" },
      { runner: "arm64-ci", label: "linux-aarch64" },
      { runner: "crab", label: "macos-aarch64" },
    ];
    const suites: Job[] = [
      linux("nix-syntax", "Nix syntax", 15, [
        {
          name: "Parse all Nix files",
          run: "find . -name '*.nix' -exec nix-instantiate --parse {} + > /dev/null",
        },
      ]),
      linux("lint", "Lint", 60, [
        { run: "./bin/lint --check" },
        {
          name: "Check crates.io publication plan",
          run: "./bin/publish-crates --plan",
        },
      ]),
      // Publishing builds nothing (--no-verify), so build every crate from its package here, as crates.io users will.
      linux("package-crates", "Package crates", 90, [
        { run: "./bin/package-crates" },
      ]),
      linux("test", "Tests", 90, [{ run: "./bin/tests" }]),
      linux("protocol-fuzz", "Protocol fuzz", 60, [
        {
          name: "Fuzz every YAS wire surface",
          env: { YAS_FUZZ_SECONDS: "60" },
          run: "./bin/fuzz",
        },
      ]),
      linux("e2e", "E2E", 90, [
        { run: "./bin/e2e" },
        upload({
          name: "playwright-report",
          when: "always",
          paths: ["e2e/test-results/"],
          retentionDays: 7,
        }),
      ]),
      linux("coverage", "Coverage", 90, [
        { name: "Run tests with coverage", run: "./bin/coverage" },
        {
          name: "Write coverage summary",
          run: 'cat coverage-summary.txt >> "$ULTIMATOR_SUMMARY"',
        },
        upload({
          name: "coverage-report",
          when: "always",
          paths: ["coverage-report/html/"],
          retentionDays: 30,
        }),
      ]),
      ...platforms.map(
        ({ runner, label }): Job => ({
          id: `packages-${label}`,
          name: `Packages (${label})`,
          runsOn: runner,
          timeoutMinutes: 120,
          steps: [checkout(), ...packages(label)],
        }),
      ),
      {
        id: "windows",
        name: "Windows (x86_64, emulated)",
        runsOn: "crab-win",
        timeoutMinutes: 150,
        env: { RUSTFLAGS: "-D warnings" },
        steps: [
          checkout(),
          cache({
            key: ["yas-windows-x86_64", hashFiles("Cargo.lock"), ctx.sha],
            restoreKeys: ["yas-windows-x86_64-"],
            paths: ["target"],
          }),
          ...windowsX64(),
        ],
      },
    ];
    // The check to require (`ci/ok`): it passes only when every suite passed, none skipped or cancelled.
    const ok: Job = {
      id: "ok",
      name: "CI",
      needs: suites,
      when: "always",
      runsOn: "sandbox",
      timeoutMinutes: 5,
      steps: [
        {
          name: "Every suite must pass",
          run: '[ "$ULTIMATOR_NEEDS_RESULT" = success ] || { echo "::error::Every CI suite must succeed."; exit 1; }',
        },
      ],
    };
    return [...suites, ok];
  },
});
