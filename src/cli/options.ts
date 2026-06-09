const COMMANDS = ['repos', 'issues', 'prs', 'runs', 'stars', 'audit', 'build-pr', 'release-tag'] as const;
const COMMAND_SET: ReadonlySet<string> = new Set(COMMANDS);

export type Command = (typeof COMMANDS)[number];

export type CliOptions = {
  json: boolean;
  repo?: string;
  discover: boolean;
  pr?: number;
  tag?: string;
  targetRef?: string;
  confirm: boolean;
  force: boolean;
  allowDraft: boolean;
  allowFork: boolean;
  allowNonDefaultBase: boolean;
  positionals: string[];
};

export type ParsedCommandLine =
  | { kind: 'help' }
  | {
      kind: 'command';
      command: Command;
      options: CliOptions;
    };

export const HELP = `Usage: nullbuilder <command> [options]

Commands:
  repos                 Show configured repositories and latest CI/nightly/release status
  issues                Show open issues across configured repositories
  prs                   Show open pull requests across configured repositories
  runs                  Show latest CI/nightly/release runs across repositories
  stars                 Show current stars and recent growth
  audit                 Check repository policy, workflow, and security posture
  build-pr <repo>       Create a build-pr-* tag on a pull request head SHA
  release-tag <repo>    Create a v* release tag on the default branch, branch, or SHA

Options:
  --repo <repo>         Filter list commands by repository name or owner/name
  --discover           Include discovered public Zig/null repositories for NULLBUILDER_OWNER
  --json                Print JSON
  --pr <number>         Pull request number for build-pr
  --tag <tag>           Tag name. build-pr defaults to build-pr-<pr>-<sha>
  --ref <ref>           Branch name or commit SHA for release-tag. Defaults to default branch
  --confirm            Actually create/update the tag. Without this, tag commands are dry runs
  --force              Move an existing tag when used with --confirm
  --allow-draft        Allow draft PRs for build-pr
  --allow-fork         Allow fork PRs for build-pr
  --allow-non-default-base
                       Allow PRs not targeting the repository default branch
  -h, --help            Show help

Environment:
  NULLBUILDER_REPOS     Comma or whitespace-separated repositories. Defaults to NullClaw Zig repos
  NULLBUILDER_IGNORE_REPOS
                        Repositories skipped by discovery. Defaults to known forks/connectors
  NULLBUILDER_OWNER     Default owner for unqualified repository names. Defaults to nullclaw
  NULLBUILDER_DISCOVER_REPOS=true
  NULLBUILDER_CACHE_TTL_MS=60000
  NULLBUILDER_CONCURRENCY=3
  NULLBUILDER_GITHUB_TOKEN
                        Token for private repos and write operations
`;

export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const [rawCommand = 'help', ...rest] = argv;

  if (rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
    return { kind: 'help' };
  }

  if (!isCommand(rawCommand)) {
    throw new Error(`Unknown command: ${rawCommand}`);
  }

  return {
    kind: 'command',
    command: rawCommand,
    options: parseOptions(rest)
  };
}

export function parseOptions(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    discover: false,
    confirm: false,
    force: false,
    allowDraft: false,
    allowFork: false,
    allowNonDefaultBase: false,
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      options.positionals.push(...args.slice(index + 1));
      break;
    }

    if (!arg.startsWith('-')) {
      options.positionals.push(arg);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--discover') {
      options.discover = true;
    } else if (arg === '--repo') {
      options.repo = readValue(args, (index += 1), '--repo');
    } else if (arg === '--pr') {
      options.pr = parsePositiveInteger(readValue(args, (index += 1), '--pr'), '--pr');
    } else if (arg === '--tag') {
      options.tag = readValue(args, (index += 1), '--tag');
    } else if (arg === '--ref') {
      options.targetRef = readValue(args, (index += 1), '--ref');
    } else if (arg === '--confirm') {
      options.confirm = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--allow-draft') {
      options.allowDraft = true;
    } else if (arg === '--allow-fork') {
      options.allowFork = true;
    } else if (arg === '--allow-non-default-base') {
      options.allowNonDefaultBase = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${option} must be a positive number.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} must be a positive number.`);
  }

  return parsed;
}

function isCommand(value: string): value is Command {
  return COMMAND_SET.has(value);
}
