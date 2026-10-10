// The website (yas.run) on Fly, ported from .github/workflows/deploy-website.yml, which runs on GitHub until Forge's
// phase P4. Its job declares the organization's CI secret FLY_API_TOKEN (for ulti/yas on main): pushes to main are
// trusted runs once main is protected.
import { checkout, workflow } from "ultimator:ci";
import { nix } from "../lib/steps.ts";

export default workflow({
  on: {
    push: {
      branches: ["main"],
      paths: [
        "crates/website/**",
        "crates/browser/**",
        "js/web/**",
        "js/core/**",
        "js/solid/**",
        "js/ui/**",
        "install.sh",
        "install.ps1",
        "SKILL.md",
        "Cargo.toml",
        "Cargo.lock",
        "js/pnpm-lock.yaml",
        "js/pnpm-workspace.yaml",
        ".dockerignore",
        ".ultimator/workflows/deploy-website.ts",
        ".ultimator/lib/**",
      ],
    },
  },
  concurrency: { group: "deploy-website", cancelInProgress: false },
  jobs: () => [
    {
      id: "deploy",
      name: "Deploy",
      runsOn: "sandbox",
      timeoutMinutes: 60,
      secrets: ["FLY_API_TOKEN"],
      steps: [checkout(), nix(), { run: "nix run .#deploy-website" }],
    },
  ],
});
