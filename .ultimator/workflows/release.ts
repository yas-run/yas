// YAS's release on Forge (xmit-dev/ultimator docs/CI.md), ported from .github/workflows/release.yml, which runs on
// GitHub until Forge's phase P4. A tag v* is verified, tested, built for every platform and published.
//
// - The tag's signature: GitHub said whether a "verified identity" signed it; here git checks its SSH signature
//   against YAS_TAG_SIGNERS (an allowed_signers file: `pc@rrier.fr ssh-ed25519 AAAA…`), an organization CI secret only
//   because admins alone set secrets (Forge has no repository variables yet): for ulti/yas on refs/tags/v*. Without
//   it, or unsigned, the release stops.
// - GitHub Releases go with GitHub: the tarballs, zip and extension modules are kept as this run's artifact
//   `release-<tag>` (P4 gives them a home on Forge).
// - crates.io takes the secret CARGO_REGISTRY_TOKEN; npm takes NPM_TOKEN (a granular token), both for ulti/yas on
//   refs/tags/v*, each declared by the job that publishes. Trusted publishing (OIDC) works from GitHub Actions only, so
//   provenance is lost.
import { checkout, download, upload, workflow, type Job } from "ultimator:ci";
import {
  nix,
  packages,
  sh,
  windowsX64,
  type PackagesLabel,
} from "../lib/steps.ts";

export default workflow({
  on: { tag: { patterns: ["v*"] } },
  concurrency: (ctx) => ({
    group: `release-${ctx.ref}`,
    cancelInProgress: false,
  }),
  jobs: (ctx) => {
    const tag = ctx.tag ?? "";
    const version = tag.replace(/^v/, "");
    const verify: Job = {
      id: "verify-tag",
      name: "Verify the tag's signature",
      runsOn: "sandbox",
      timeoutMinutes: 5,
      secrets: ["YAS_TAG_SIGNERS"],
      env: { TAG: tag },
      steps: [
        checkout({ fetchDepth: 0 }),
        {
          name: "Verify the tag's SSH signature",
          run: sh`
            tag="$TAG"
            SIGNERS="\${YAS_TAG_SIGNERS:-}"
            if [ -z "$SIGNERS" ]; then
              echo "::error::No YAS_TAG_SIGNERS secret for this run: nothing to verify \${tag}'s signature against"
              exit 1
            fi
            git fetch --force origin "refs/tags/\${tag}:refs/tags/\${tag}"
            [ "$(git cat-file -t "$tag")" = tag ] || { echo "::error::\${tag} isn't an annotated, signed tag"; exit 1; }
            printf '%s\\n' "$SIGNERS" > "$ULTIMATOR_CI_TEMP/allowed_signers"
            if ! git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$ULTIMATOR_CI_TEMP/allowed_signers" verify-tag "$tag"; then
              echo "::error::Tag \${tag} is not signed by an allowed signer"
              exit 1
            fi
          `,
        },
      ],
    };
    /** A sandbox job after the tag is verified: the repository, Nix, then its steps. */
    const linux = (
      id: string,
      name: string,
      timeoutMinutes: number,
      steps: Job["steps"],
    ): Job => ({
      id,
      name,
      needs: [verify],
      runsOn: "sandbox",
      timeoutMinutes,
      steps: [checkout(), nix(), ...steps],
    });
    const platforms: { runner: string; label: PackagesLabel }[] = [
      { runner: "sandbox", label: "linux-x86_64" },
      { runner: "arm64-ci", label: "linux-aarch64" },
      { runner: "crab", label: "macos-aarch64" },
    ];
    const tarballs = platforms.map(
      ({ runner, label }): Job => ({
        id: `packages-${label}`,
        name: `Packages (${label})`,
        needs: [verify],
        runsOn: runner,
        timeoutMinutes: 120,
        steps: [
          checkout(),
          ...packages(label),
          upload({ name: `tarballs-${label}`, paths: ["dist/*.tar.gz"] }),
        ],
      }),
    );
    const windows: Job = {
      id: "windows",
      name: "Windows (x86_64, emulated)",
      needs: [verify],
      runsOn: "crab-win",
      timeoutMinutes: 150,
      env: { RUSTFLAGS: "-D warnings", VERSION: version },
      steps: [
        checkout(),
        ...windowsX64(),
        {
          name: "Package zips",
          shell: "bash",
          run: sh`
            version="$VERSION"
            mkdir -p dist licenses
            cp vendor/yas-alacritty-terminal/LICENSE-APACHE licenses/yas-alacritty-terminal-APACHE-2.0.txt
            for bin in yas; do
              cp "target/release/\${bin}.exe" "\${bin}.exe"
              7z a "dist/\${bin}_\${version}_windows_x86_64.zip" "\${bin}.exe" LICENSE licenses
              rm "\${bin}.exe"
            done
            ls -lh dist/
          `,
        },
        upload({ name: "windows-x86_64", paths: ["dist/*.zip"] }),
      ],
    };
    // Wasm and bundled QuickJS modules are architecture-independent, so one job builds the extension objects every
    // platform's release points at.
    const extensions = linux("extensions", "Extensions", 60, [
      { run: "./bin/extensions" },
      upload({
        name: "extensions",
        paths: [
          "extensions/dist/*.wasm",
          "extensions/dist/*.js",
          "extensions/dist/manifest.json",
        ],
      }),
    ]);
    const fuzz = ["frame", "families", "packed"].map((target) =>
      linux(`protocol-fuzz-${target}`, `Protocol fuzz (${target})`, 90, [
        {
          name: `Sustained YAS wire fuzz campaign (${target})`,
          env: { YAS_FUZZ_SECONDS: "3600", YAS_FUZZ_TARGET: target },
          run: "./bin/fuzz",
        },
      ]),
    );
    const gathered = sh`
      mkdir -p artifacts
      find downloaded -type f -exec cp {} artifacts/ \\;
    `;
    const built: Job[] = [
      linux("lint", "Lint", 60, [
        { run: "./bin/lint --check" },
        { run: "./bin/publish-crates --plan" },
      ]),
      linux("test", "Tests", 90, [{ run: "./bin/tests" }]),
      linux("e2e", "E2E", 90, [{ run: "./bin/e2e" }]),
      linux("coverage", "Coverage", 90, [{ run: "./bin/coverage" }]),
      ...tarballs,
      windows,
      extensions,
      ...fuzz,
    ];
    const release: Job = {
      id: "release",
      name: "Release artifact",
      needs: built,
      runsOn: "sandbox",
      timeoutMinutes: 15,
      env: { VERSION: version },
      steps: [
        download({ pattern: "tarballs-*", path: "downloaded" }),
        download({ name: "windows-x86_64", path: "downloaded/windows-x86_64" }),
        download({ name: "extensions", path: "downloaded/extensions" }),
        {
          name: "Add stable latest-release asset names and checksums",
          run: sh`
            mkdir -p release
            find downloaded -type f -exec cp {} release/ \\;
            version="$VERSION"
            cd release
            for file in *.tar.gz *.zip; do
              cp "$file" "\${file/_\${version}_/_}"
            done
            sha256sum -- * > SHA256SUMS
            ls -lh
          `,
        },
        upload({
          name: `release-${tag}`,
          paths: ["release/*"],
          retentionDays: 90,
        }),
      ],
    };
    const npmrc = sh`
      [ -n "\${NPM_TOKEN:-}" ] || { echo "::error::No NPM_TOKEN secret for this run"; exit 1; }
      export NODE_AUTH_TOKEN="$NPM_TOKEN" NPM_CONFIG_USERCONFIG="$ULTIMATOR_CI_TEMP/npmrc"
      printf '//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\\n' > "$NPM_CONFIG_USERCONFIG"
    `;
    /** A publishing job: after the release artifact, with the secret it publishes with. */
    const publish = (
      id: string,
      name: string,
      timeoutMinutes: number,
      secret: string,
      steps: Job["steps"],
    ): Job => ({
      ...linux(id, name, timeoutMinutes, steps),
      needs: [release],
      secrets: [secret],
    });
    return [
      verify,
      ...built,
      release,
      publish("publish-crates", "crates.io", 60, "CARGO_REGISTRY_TOKEN", [
        { run: "./bin/publish-crates" },
      ]),
      publish("publish-npm", "npm (packages)", 30, "NPM_TOKEN", [
        {
          name: "Publish with a granular token",
          run: `${npmrc}./bin/publish-npm-packages --access public\n`,
        },
      ]),
      {
        id: "publish-bin-npm",
        name: "npm (binaries)",
        needs: [release],
        runsOn: "sandbox",
        timeoutMinutes: 30,
        secrets: ["NPM_TOKEN"],
        env: { VERSION: version },
        steps: [
          checkout(),
          download({ pattern: "tarballs-*", path: "downloaded" }),
          download({
            name: "windows-x86_64",
            path: "downloaded/windows-x86_64",
          }),
          {
            name: "Build YAS binary npm packages",
            run: `${gathered}./bin/build-npm-bin-packages artifacts dist/npm-bin "$VERSION"\n`,
          },
          {
            name: "Publish YAS binary npm packages with a granular token",
            run: `${npmrc}./bin/publish-npm-bin-packages dist/npm-bin --access public\n`,
          },
        ],
      },
    ];
  },
});
