// Forge CI's SDK: the types of the built-in module `ultimator:ci`, which `.ultimator/workflows/*.ts` import.
// `ultimator ci init` writes this file into a repository's `.ultimator/`; `ultimator ci init --check` says whether the
// copy there is current. Workflows are evaluated at planning time with no I/O, clock or randomness: `Date`,
// `Math.random` and timers don't exist there. docs/CI.md describes every field.

declare module "ultimator:ci" {
  /** A glob over branches, tags or paths: `*` within a segment, `**` across them, `!` in front to exclude. */
  export type Glob = string;

  /** Executor labels: which executors may run a job (all of them must be on the executor). */
  export type Labels = string | readonly string[];

  export interface PushTrigger {
    /** Branches whose pushes start it (every branch without). */
    branches?: readonly Glob[];
    /** Only when the push changed one of these paths. */
    paths?: readonly Glob[];
    /** Not when every path the push changed is one of these. */
    ignorePaths?: readonly Glob[];
  }

  export interface TagTrigger {
    /** Tags whose creation starts it (`v*`). */
    patterns: readonly Glob[];
  }

  export type PullRequestAction = "opened" | "synchronize" | "reopened";

  export interface PullRequestTrigger {
    /** Base branches (every branch without). */
    branches?: readonly Glob[];
    paths?: readonly Glob[];
    ignorePaths?: readonly Glob[];
    /** opened, synchronize (a new head) and reopened without. */
    actions?: readonly PullRequestAction[];
  }

  export interface QueueTrigger {
    /** Branches whose merge queue candidates it tests (every queued branch without). */
    branches?: readonly Glob[];
  }

  export type Input =
    | { type: "string"; description?: string; default?: string; required?: boolean }
    | { type: "boolean"; description?: string; default?: boolean }
    | { type: "choice"; description?: string; options: readonly string[]; default?: string };

  export interface DispatchTrigger {
    inputs?: Readonly<Record<string, Input>>;
  }

  export interface Triggers {
    push?: PushTrigger;
    tag?: TagTrigger;
    pullRequest?: PullRequestTrigger;
    queue?: QueueTrigger;
    /** Cron expressions, in UTC: `"17 3 * * *"`. */
    schedule?: readonly string[];
    /** Runs by hand: `ultimator ci run OWNER/NAME WORKFLOW`, or the CI page. */
    dispatch?: DispatchTrigger;
  }

  export type Event =
    | { kind: "push"; branch: string; before: string | null }
    | { kind: "tag"; tag: string }
    | { kind: "pullRequest"; number: number; action: PullRequestAction; base: string; head: string }
    | { kind: "queue"; base: string; candidate: number; pulls: readonly number[] }
    | { kind: "schedule"; cron: string }
    | { kind: "dispatch"; inputs: Readonly<Record<string, string | boolean>> };

  /** What a workflow is planned for. */
  export interface Context {
    readonly event: Event;
    readonly repository: { readonly owner: string; readonly name: string; readonly defaultBranch: string };
    /** `refs/heads/main`, `refs/tags/v1.2.0`, `refs/pull/7/head`, `refs/queue/main/3`. */
    readonly ref: string;
    /** The commit its jobs check out. */
    readonly sha: string;
    /** The branch pushed, or a pull request's or a candidate's base; null for a tag. */
    readonly branch: string | null;
    readonly tag: string | null;
    /** Pushes to protected refs, queue candidates, dispatches and schedules by those who may push: secrets and
     * caches' writes are theirs alone. */
    readonly trusted: boolean;
    /** The member it runs for, by user ID; null for a schedule's. */
    readonly actor: string | null;
    /** What the push or pull request changed; null when unknown (or past 1,000 paths). */
    readonly changedPaths: readonly string[] | null;
    /** Whether it changed a path one of these globs takes (true when unknown). */
    changed(...globs: readonly Glob[]): boolean;
  }

  /** When a step or job runs, once those before it (a job's needs) are done. */
  export type When = "success" | "failure" | "always";

  export type Shell = "bash" | "sh" | "pwsh" | "powershell" | "cmd" | "python";

  export interface Concurrency {
    /** Runs of one group go one at a time: a newer one waits, and replaces any still waiting. */
    group: string;
    /** A newer run cancels the one running. */
    cancelInProgress?: boolean;
  }

  interface StepBase {
    /** What the log calls it (the command's first line without). */
    name?: string;
    /** success (the default: nothing before it failed), failure, or always. */
    when?: When;
    continueOnError?: boolean;
    timeoutMinutes?: number;
  }

  export interface RunStep extends StepBase {
    /** A script. It may append `KEY=VALUE` lines to `$ULTIMATOR_OUTPUT` (outputs), `$ULTIMATOR_ENV` (later steps'
     * environment), paths to `$ULTIMATOR_PATH`, and Markdown to `$ULTIMATOR_SUMMARY`. */
    run: string;
    /** bash by default (`bash --noprofile --norc -eo pipefail`). */
    shell?: Shell;
    /** Relative to the workspace. */
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  }

  export interface CheckoutStep extends StepBase {
    builtin: "checkout";
    /** OWNER/NAME of the organization's repositories (the run's own without). */
    repository?: string;
    /** A branch, tag or commit (the run's commit for its own repository). */
    ref?: string;
    /** A flake.lock (path in the workspace) whose pin for the repository says the commit. */
    pin?: string;
    /** The name the lock file knows it by, when not this one (the GitHub name it still fetches). */
    pinRepository?: string;
    /** Where, in the workspace (its root without). */
    path?: string;
    /** Commits of history, 0 for all (1 without). */
    fetchDepth?: number;
    clean?: boolean;
  }

  /** A value only known on the machine: the SHA-256 of the files these globs take, in the workspace. */
  export interface HashFiles {
    readonly hashFiles: readonly Glob[];
  }

  export type CacheKeyPart = string | number | HashFiles;

  export interface CacheStep extends StepBase {
    builtin: "cache";
    /** Parts joined with `-`. */
    key: CacheKeyPart | readonly CacheKeyPart[];
    /** Prefixes tried in order when the key misses. */
    restoreKeys?: readonly string[];
    paths: readonly string[];
  }

  export interface UploadStep extends StepBase {
    builtin: "upload";
    /** The artifact's name, unique in the run. */
    name: string;
    paths: readonly Glob[];
    retentionDays?: number;
  }

  export interface DownloadStep extends StepBase {
    builtin: "download";
    /** One artifact, or every artifact whose name a glob takes. */
    name?: string;
    pattern?: Glob;
    /** Where, in the workspace (each in a directory of its name, with `pattern`). */
    path?: string;
  }

  export type Step = RunStep | CheckoutStep | CacheStep | UploadStep | DownloadStep;

  export interface Job {
    /** Unique in the workflow: its check is `<workflow>/<id>`. Letters, digits, `.`, `_`, `-`. */
    id: string;
    /** What people read (the ID without). */
    name?: string;
    runsOn: Labels;
    /** Jobs it waits for: those returned with it, or their IDs. */
    needs?: readonly (Job | string)[];
    /** success (the default: every need succeeded), failure (one failed), or always. */
    when?: When;
    /** 360 without. */
    timeoutMinutes?: number;
    /** Its failure doesn't fail the run. */
    continueOnError?: boolean;
    env?: Readonly<Record<string, string>>;
    /** The organization's secrets it reads, each as an environment variable of its name (trusted runs alone). */
    secrets?: readonly string[];
    /** Outputs it publishes: keys its steps wrote to `$ULTIMATOR_OUTPUT` (the last one wins), which the jobs that
     * need it get as `ULTIMATOR_NEEDS_<JOB>_<KEY>` (upper case, `-` and `.` as `_`). */
    outputs?: readonly string[];
    concurrency?: Concurrency;
    steps: readonly Step[];
  }

  export interface Workflow {
    on: Triggers;
    /** For the whole run. */
    concurrency?: Concurrency | ((ctx: Context) => Concurrency | null);
    /** The run's jobs ([] plans none). */
    jobs(ctx: Context): readonly Job[] | Promise<readonly Job[]>;
  }

  /** The workflow its file default-exports. */
  export function workflow(definition: Workflow): Workflow;
  /** A job, typed (it returns it as is). */
  export function job(definition: Job): Job;
  export function checkout(options?: Omit<CheckoutStep, "builtin">): CheckoutStep;
  export function cache(options: Omit<CacheStep, "builtin">): CacheStep;
  export function upload(options: Omit<UploadStep, "builtin">): UploadStep;
  export function download(options: Omit<DownloadStep, "builtin">): DownloadStep;
  export function hashFiles(...globs: readonly Glob[]): HashFiles;
}
