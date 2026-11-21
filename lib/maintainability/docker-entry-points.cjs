'use strict';

const path = require('node:path').posix;

const literalPath = /^[\w./-]+$/;
const sourceScript = /\.[cm]?[jt]s$/;

// npm runs package scripts from the package directory, so this literal command establishes the build context.
function localDockerBuild(command, directory) {
  const build = /^docker build (?:-f ([\w./-]+) )?(?:-t [\w./:-]+ )?([\w./-]+)$/.exec(command);
  if (!build) return;
  const [, file, context] = build;
  if ([context, file].some((name) => name && (name.startsWith('-') || path.isAbsolute(name)))) return;
  const contextDirectory = path.join(directory, context);
  const dockerfile = file ? path.join(directory, file) : path.join(contextDirectory, 'Dockerfile');
  if ([contextDirectory, dockerfile].some((name) => name === '..' || name.startsWith('../'))) return;
  return { contextDirectory, dockerfile };
}

function nodeTarget(raw, workingDirectory) {
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(args) || args[0] !== 'node') return;
  const script = args[1];
  if (typeof script !== 'string' || !literalPath.test(script) || script.startsWith('-') || !sourceScript.test(script))
    return;
  if (workingDirectory || path.isAbsolute(script)) return path.resolve(workingDirectory || '/', script);
}

// Only trace explicit file copies. A RUN, ADD or unrecognised COPY may generate or replace previously copied files.
function dockerNodeEntry(text, contextDirectory, known) {
  if (!text || /\\\r?\n|<<|^\s*#\s*(?:escape|syntax)\s*=/im.test(text)) return;
  const files = new Map();
  let workingDirectory;
  let nodeImage;
  let entrypoint;
  let command;
  for (const line of text.split(/\r?\n/)) {
    const instruction = /^\s*([a-z]+)\s+(.+?)\s*$/i.exec(line);
    if (!instruction) continue;
    const [, name, args] = instruction;
    switch (name.toUpperCase()) {
      case 'FROM':
        files.clear();
        workingDirectory = undefined;
        nodeImage = /^node(?=[:@\s]|$)/.test(args);
        entrypoint = command = undefined;
        break;
      case 'WORKDIR':
        workingDirectory = literalPath.test(args) && path.isAbsolute(args) ? args : undefined;
        break;
      case 'COPY': {
        const parts = args.split(/\s+/);
        const [source, dest] = parts;
        if (parts.length !== 2 || !parts.every((part) => literalPath.test(part) && !part.startsWith('-'))) {
          files.clear();
          break;
        }
        const local = path.join(contextDirectory, source);
        if (
          path.isAbsolute(source) ||
          source.split('/').includes('..') ||
          !known.has(local) ||
          (!workingDirectory && !path.isAbsolute(dest))
        ) {
          files.clear();
          break;
        }
        const directory = dest.endsWith('/') || dest === '.';
        const target = path.resolve(workingDirectory || '/', dest, directory ? path.basename(source) : '');
        files.set(target, local);
        break;
      }
      case 'RUN':
      case 'ADD':
        files.clear();
        break;
      case 'ENTRYPOINT':
        entrypoint = args;
        break;
      case 'CMD':
        command = args;
        break;
    }
  }
  const target = nodeTarget(entrypoint ?? (nodeImage && command), workingDirectory);
  if (target && !target.split('/').includes('node_modules')) return files.get(target);
}

module.exports = { localDockerBuild, dockerNodeEntry };
