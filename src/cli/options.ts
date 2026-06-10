import { parsePositiveIntegerText, readSafeTextInput } from '../lib/text-safety';

const COMMANDS = ['repos', 'issues', 'prs', 'runs', 'stars', 'audit', 'build-pr', 'release-tag'] as const;
const COMMAND_SET: ReadonlySet<string> = new Set(COMMANDS);
const MAX_CLI_ARGS = 128;
const MAX_POSITIONAL_ARGS = 16;

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
  assertCliArgVector(argv);
  const rawCommand = argv[0] ?? 'help';

  if (rawCommand === 'help' || rawCommand === '--help' || rawCommand === '-h') {
    return { kind: 'help' };
  }

  if (rawCommand.length === 0) {
    throw new Error('Invalid CLI argument.');
  }

  if (!isCommand(rawCommand)) {
    throw new Error('Unknown command.');
  }

  return {
    kind: 'command',
    command: rawCommand,
    options: parseOptions(readArgTail(argv, 1))
  };
}

export function parseOptions(args: readonly string[]): CliOptions {
  assertCliArgVector(args);
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
  const seenOptions = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      appendPositionalsFrom(options, args, index + 1);
      break;
    }

    if (!arg.startsWith('-')) {
      pushPositional(options, arg);
    } else if (arg === '--json') {
      markOptionOnce(seenOptions, arg);
      options.json = true;
    } else if (arg === '--discover') {
      markOptionOnce(seenOptions, arg);
      options.discover = true;
    } else if (arg === '--repo') {
      markOptionOnce(seenOptions, arg);
      options.repo = readTextValue(args, (index += 1), '--repo');
    } else if (arg === '--pr') {
      markOptionOnce(seenOptions, arg);
      options.pr = parsePositiveInteger(readValue(args, (index += 1), '--pr'), '--pr');
    } else if (arg === '--tag') {
      markOptionOnce(seenOptions, arg);
      options.tag = readTextValue(args, (index += 1), '--tag');
    } else if (arg === '--ref') {
      markOptionOnce(seenOptions, arg);
      options.targetRef = readTextValue(args, (index += 1), '--ref');
    } else if (arg === '--confirm') {
      markOptionOnce(seenOptions, arg);
      options.confirm = true;
    } else if (arg === '--force') {
      markOptionOnce(seenOptions, arg);
      options.force = true;
    } else if (arg === '--allow-draft') {
      markOptionOnce(seenOptions, arg);
      options.allowDraft = true;
    } else if (arg === '--allow-fork') {
      markOptionOnce(seenOptions, arg);
      options.allowFork = true;
    } else if (arg === '--allow-non-default-base') {
      markOptionOnce(seenOptions, arg);
      options.allowNonDefaultBase = true;
    } else {
      throw new Error('Unknown option.');
    }
  }

  return options;
}

function assertCliArgVector(args: readonly unknown[]): asserts args is readonly string[] {
  if (args.length > MAX_CLI_ARGS) {
    throw new Error('Too many CLI arguments.');
  }

  for (let index = 0; index < args.length; index += 1) {
    if (typeof args[index] !== 'string') {
      throw new Error('Invalid CLI argument.');
    }
  }
}

function readArgTail(args: readonly string[], start: number): string[] {
  const tail: string[] = [];
  for (let index = start; index < args.length; index += 1) {
    tail.push(args[index]);
  }

  return tail;
}

function markOptionOnce(seenOptions: Set<string>, option: string): void {
  if (seenOptions.has(option)) {
    throw new Error('Duplicate option.');
  }

  seenOptions.add(option);
}

function appendPositionalsFrom(options: CliOptions, values: readonly string[], start: number): void {
  for (let index = start; index < values.length; index += 1) {
    pushPositional(options, values[index]);
  }
}

function pushPositional(options: CliOptions, value: string): void {
  if (options.positionals.length >= MAX_POSITIONAL_ARGS) {
    throw new Error('Too many positional arguments.');
  }

  const safe = readSafeTextInput(value);
  if (safe === null || safe.length === 0) {
    throw new Error('Invalid positional argument.');
  }

  options.positionals.push(safe);
}

function readValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function readTextValue(args: readonly string[], index: number, option: string): string {
  const value = readValue(args, index, option);
  const safe = readSafeTextInput(value);
  if (safe === null) {
    throw new Error(`${option} has invalid value.`);
  }
  return safe;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = parsePositiveIntegerText(value);
  if (parsed === null) {
    throw new Error(`${option} must be a positive number.`);
  }

  return parsed;
}

function isCommand(value: string): value is Command {
  return COMMAND_SET.has(value);
}
