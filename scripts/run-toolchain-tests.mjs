import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const target = process.argv[2];
const definitions = {
  'go-sdk': {
    local: { command: 'go', probe: ['version'], args: ['test', './...'] },
    directory: 'packages/sdk-go',
    image: 'golang:1.24-alpine',
    container: ['go', 'test', './...'],
  },
  'java-sdk': {
    local: { command: 'mvn', probe: ['-version'], args: ['-o', '-B', 'test'] },
    directory: 'packages/sdk-java',
    image: 'maven:3.9.12-eclipse-temurin-21',
    container: ['mvn', '-o', '-B', 'test'],
    maven: true,
  },
  'java-gateway': {
    local: { command: 'mvn', probe: ['-version'], args: ['-o', '-B', 'test'] },
    directory: 'services/guard-gateway',
    image: 'maven:3.9.12-eclipse-temurin-21',
    container: ['mvn', '-o', '-B', 'test'],
    maven: true,
  },
};

if (!(target in definitions)) {
  process.stderr.write(`Usage: node scripts/run-toolchain-tests.mjs <${Object.keys(definitions).join('|')}>\n`);
  process.exit(2);
}

const definition = definitions[target];
const workingDirectory = path.join(root, definition.directory);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 127;
  }
  return result.status ?? 1;
}

const localProbe = spawnSync(definition.local.command, definition.local.probe, {
  cwd: workingDirectory,
  env: process.env,
  stdio: 'ignore',
  shell: false,
});

if (!localProbe.error && localProbe.status === 0) {
  process.exit(run(definition.local.command, definition.local.args, { cwd: workingDirectory }));
}

const imageCheck = spawnSync('docker', ['image', 'inspect', definition.image], {
  cwd: root,
  env: process.env,
  stdio: 'ignore',
  shell: false,
});
if (imageCheck.error || imageCheck.status !== 0) {
  process.stderr.write(`Required offline toolchain image is unavailable: ${definition.image}\n`);
  process.exit(1);
}

const dockerArguments = [
  'run', '--rm', '--pull=never', '--network', 'none',
  '--volume', `${root}:/workspace`,
  '--workdir', `/workspace/${definition.directory.replaceAll('\\', '/')}`,
];
if (definition.maven) {
  const profile = process.env.USERPROFILE;
  const repository = profile ? path.join(profile, '.m2', 'repository') : '';
  if (!repository || !existsSync(repository)) {
    process.stderr.write('A populated local Maven repository is required for offline Java tests.\n');
    process.exit(1);
  }
  dockerArguments.push('--volume', `${repository}:/root/.m2/repository:ro`);
}
dockerArguments.push(definition.image, ...definition.container);
process.exit(run('docker', dockerArguments));
