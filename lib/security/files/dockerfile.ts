// Dockerfile checks. Instructions are read as logical lines, so a backslash continuation is one
// instruction.
import { isSecretKey, isPlaceholderValue } from './secret-values.js';
import type { FileFinding } from '../types/file-finding.js';

const dockerfileName = /^(?:.+\.)?Dockerfile(?:\..+)?$/i;
const developmentName = /(?:^|[._-])(?:dev|development|test|ci|local|toolchain)(?:[._-]|$)/i;
// `dev` is not here: a folder such as dev-gateway can still hold an image that is deployed.
const developmentFolderWords = new Set([
  'test',
  'tests',
  'e2e',
  'devcontainer',
  'fake',
  'fixtures',
  'sandbox',
  'playwright',
]);
const developmentReason = 'Development or test image.';
const nonRootImage = /nonroot|unprivileged|rootless/i;
const secretFile =
  /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:key|p12|pfx)|.*(?:priv|key|secret).*\.pem)$/i;
const templateEnvFile = /^\.env\.(?:example|sample|template|dist)$/i;
const keyValuePair = /([A-Za-z_][\w.]*)=("[^"]*"|'[^']*'|\S*)/g;

function baseNameOf(file: string) {
  return file.split('/').at(-1) ?? '';
}

function isInDevelopmentFolder(file: string) {
  return file
    .split('/')
    .slice(0, -1)
    .some((folder: string) =>
      folder
        .toLowerCase()
        .split(/[._-]+/)
        .some((word) => developmentFolderWords.has(word)),
    );
}

function isDockerfile(file: string) {
  return dockerfileName.test(baseNameOf(file));
}

interface DockerInstruction {
  line: number;
  name: string;
  args: string;
}

interface DockerStage {
  image: string;
  alias: string | undefined;
  line: number;
  instructions: DockerInstruction[];
}

function logicalInstructions(text: string) {
  const instructions: DockerInstruction[] = [];
  let pending: { line: number; text: string } | undefined;
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('#') || (!trimmed && !pending)) return;
    const continued = trimmed.endsWith('\\');
    const content = continued ? trimmed.slice(0, -1) : trimmed;
    if (pending) pending.text += ' ' + content;
    else pending = { line: index + 1, text: content };
    if (continued) return;
    const match = /^(\w+)\s*(.*)$/.exec(pending.text);
    if (match) instructions.push({ line: pending.line, name: match[1].toUpperCase(), args: match[2] });
    pending = undefined;
  });
  return instructions;
}

function parseStages(instructions: readonly DockerInstruction[]) {
  const stages: DockerStage[] = [];
  for (const instruction of instructions) {
    if (instruction.name === 'FROM') {
      const tokens = instruction.args.split(/\s+/).filter((token) => !token.startsWith('--'));
      const aliasIndex = tokens.findIndex((token) => token.toLowerCase() === 'as');
      stages.push({
        image: tokens[0] ?? '',
        alias: aliasIndex === -1 ? undefined : tokens[aliasIndex + 1]?.toLowerCase(),
        line: instruction.line,
        instructions: [],
      });
    } else stages.at(-1)?.instructions.push(instruction);
  }
  return stages;
}

function isStageName(image: string, stages: readonly DockerStage[]) {
  return stages.some((stage) => stage.alias === image.toLowerCase());
}

function unpinnedFinding(stage: DockerStage, earlierStages: readonly DockerStage[]): FileFinding | undefined {
  const image = stage.image;
  if (!image || image === 'scratch' || image.includes('$') || image.includes('@')) return undefined;
  if (isStageName(image, earlierStages)) return undefined;
  const tag = baseNameOf(image).split(':')[1];
  if (tag && tag !== 'latest') return undefined;
  const problem = tag ? 'uses the :latest tag' : 'has no tag';
  return {
    ruleId: 'dockerfile-unpinned-base-image',
    line: stage.line,
    message: `Base image "${image}" ${problem}. Pin a version tag, or a digest for reproducible builds.`,
  };
}

// The last USER wins; a stage without one inherits from its base stage.
function effectiveUser(
  stage: DockerStage,
  stages: readonly DockerStage[],
  visited = new Set<DockerStage>(),
): DockerInstruction | undefined {
  const users = stage.instructions.filter((instruction) => instruction.name === 'USER');
  if (users.length) return users.at(-1);
  const base = stages.find((candidate) => candidate.alias === stage.image.toLowerCase());
  if (!base || visited.has(base)) return undefined;
  return effectiveUser(base, stages, visited.add(stage));
}

// The registry image a stage ultimately builds on, following FROM <earlier stage> links.
function registryImage(stage: DockerStage, stages: readonly DockerStage[], visited = new Set<DockerStage>()): string {
  const base = stages.find((candidate) => candidate.alias === stage.image.toLowerCase());
  if (!base || visited.has(base)) return stage.image;
  return registryImage(base, stages, visited.add(stage));
}

function rootFinding(stages: readonly DockerStage[]): FileFinding | undefined {
  const final = stages[stages.length - 1];
  const user = effectiveUser(final, stages);
  if (!user) {
    const image = registryImage(final, stages);
    if (image === 'scratch' || nonRootImage.test(image)) return undefined;
    return {
      ruleId: 'dockerfile-runs-as-root',
      line: final.line,
      message:
        'The final stage inherits its user from the base image. Verify the inherited user is non-root or set USER explicitly.',
    };
  }
  const name = user.args.trim().split(':')[0];
  if (name.includes('$') || !/^(?:root|0)$/i.test(name)) return undefined;
  return {
    ruleId: 'dockerfile-runs-as-root',
    line: user.line,
    message: 'The final USER is root, so the container runs as root. Switch to a non-root account.',
  };
}

function assignments(args: string) {
  return [...args.matchAll(keyValuePair)].map(([, key, value]): [string, string] => [
    key,
    value.replace(/^(["'])(.*)\1$/, '$2'),
  ]);
}

// ENV also accepts the legacy `ENV KEY value` form.
function envAssignments(args: string): [string, string][] {
  if (/^[A-Za-z_][\w.]*=/.test(args)) return assignments(args);
  const [key, ...rest] = args.split(/\s+/);
  return key && rest.length ? [[key, rest.join(' ')]] : [];
}

function copySources(args: string) {
  if (/(?:^|\s)--from=/.test(args)) return [];
  const words = args.startsWith('[') ? [...args.matchAll(/"([^"]*)"/g)].map((match) => match[1]) : args.split(/\s+/);
  return words.filter((word) => word && !word.startsWith('--')).slice(0, -1);
}

function secretBuildFindings({ name, args, line }: DockerInstruction): FileFinding[] {
  if (name === 'ARG' || name === 'ENV') {
    const pairs = name === 'ARG' ? assignments(args) : envAssignments(args);
    return pairs
      .filter(([key, value]) => isSecretKey(key) && !isPlaceholderValue(value, key))
      .map(([key]) => ({
        ruleId: 'dockerfile-secret-in-build',
        line,
        message: `${name} "${key}" has a secret default baked into the image layers. Pass it at run time or as a build secret mount.`,
      }));
  }
  if (name !== 'COPY' && name !== 'ADD') return [];
  return copySources(args)
    .map(baseNameOf)
    .filter((baseName) => secretFile.test(baseName) && !templateEnvFile.test(baseName))
    .map((baseName) => ({
      ruleId: 'dockerfile-secret-in-build',
      line,
      message: `${name} puts "${baseName}" into the image. Mount it as a build secret or provide it at run time.`,
    }));
}

function remoteAddFindings({ name, args, line }: DockerInstruction): FileFinding[] {
  if (name !== 'ADD' || /(?:^|\s)--checksum=/.test(args)) return [];
  if (!args.split(/\s+/).some((word) => /^https?:\/\//i.test(word))) return [];
  return [
    {
      ruleId: 'dockerfile-add-remote-url',
      line,
      message:
        'ADD fetches a remote URL without verification. Download with curl and check a checksum, or COPY a local file.',
    },
  ];
}

function checkDockerfile(file: string, text: string): FileFinding[] {
  const instructions = logicalInstructions(text);
  const stages = parseStages(instructions);
  if (!stages.length) return [];
  const findings: (FileFinding | undefined)[] = [rootFinding(stages)];
  stages.forEach((stage, index) => findings.push(unpinnedFinding(stage, stages.slice(0, index))));
  for (const instruction of instructions) {
    findings.push(...secretBuildFindings(instruction), ...remoteAddFindings(instruction));
  }
  const isDevelopmentFile = developmentName.test(baseNameOf(file)) || isInDevelopmentFolder(file);
  const contextualReason = isDevelopmentFile ? developmentReason : undefined;
  return findings
    .filter((finding): finding is FileFinding => finding !== undefined)
    .map((finding) => ({ column: 1, ...finding, ...(contextualReason && { contextualReason }) }));
}

export { checkDockerfile, isDockerfile };
