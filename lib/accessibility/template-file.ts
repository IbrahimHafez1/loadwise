// The accessibility findings of one markup file outside the TypeScript program: .html, .vue or .svelte.
import fs from 'node:fs';
import path from 'node:path';
import { reviewMarkers } from '../performance/review-context.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import type { Finding } from '../shared/types.js';
import type { MarkupDocument } from './markup.js';
import { checkMarkup } from './rules.js';
import { templateDocument } from './template-elements.js';
import type { TemplateDialect } from './template-elements.js';

interface TextRegion {
  start: number;
  end: number;
}

// A line this long is a bundler's output, not hand-written markup.
const minifiedLineLength = 5000;
const generatedHeaderLength = 2048;
const maxSiblingScriptCount = 50;
// The marker must sit inside one comment: a lazy `[\s\S]*?` would run past a `-->` and let a hand-written page whose
// text says "do not edit" count as generated.
const generatedCommentPattern =
  /<!--(?:(?!-->)[\s\S])*?(?:@generated|auto-?generated|generated (?:by|automatically|from)|do not (?:edit|modify))(?:(?!-->)[\s\S])*?-->/i;
const generatorMetaPattern = /<meta\s+name\s*=\s*["']generator["']/i;
const minifiedMarkupPattern = /[.-]min\.html?$/i;
const angularComponentTemplatePattern = /\.component\.html?$/i;
const templateUrlPattern = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/g;
const openingTagStartPattern = /^<([A-Za-z][\w-]*)/;
const reviewCommentPattern = /<!--\s*loadwise-reviewed\s+([a-z][a-z0-9-]*)\s+--\s+(\S.*?)\s*-->/;
const templateTagPattern = /<(\/?)template\b/gi;

function hasMinifiedLine(text: string): boolean {
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (lineEnd - lineStart > minifiedLineLength) return true;
    lineStart = lineEnd + 1;
  }
  return false;
}

function isSkippedMarkup(file: string, text: string): boolean {
  if (isVendoredMinified(file) || minifiedMarkupPattern.test(file) || hasMinifiedLine(text)) return true;
  const header = text.slice(0, generatedHeaderLength);
  return generatedCommentPattern.test(header) || generatorMetaPattern.test(header);
}

// Sibling scripts are read once per folder: a folder of many pages would otherwise read every script for every page.
const templateUrlsByDirectory = new Map<string, ReadonlySet<string>>();

function templateUrlBaseNames(scriptText: string): string[] {
  if (!scriptText.includes('templateUrl')) return [];
  return Array.from(scriptText.matchAll(templateUrlPattern), (match) => match[1].split(/[\\/]/).pop() ?? '');
}

function siblingTemplateUrls(directory: string): ReadonlySet<string> {
  const known = templateUrlsByDirectory.get(directory);
  if (known) return known;
  const baseNames = new Set<string>();
  try {
    const scripts = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .slice(0, maxSiblingScriptCount);
    for (const name of scripts) {
      for (const baseName of templateUrlBaseNames(fs.readFileSync(path.join(directory, name), 'utf8'))) {
        baseNames.add(baseName);
      }
    }
  } catch {
    // An unreadable folder has no known component templates.
  }
  templateUrlsByDirectory.set(directory, baseNames);
  return baseNames;
}

/** True for a template an Angular component loads: named `*.component.html` or named by a sibling script's templateUrl. */
function isAngularTemplate(file: string): boolean {
  if (angularComponentTemplatePattern.test(file)) return true;
  const resolved = path.resolve(file);
  return siblingTemplateUrls(path.dirname(resolved)).has(path.basename(resolved));
}

/** Offset just after the `>` ending the tag opened at `tagStart`, skipping quoted attribute values; -1 if unterminated. */
function openingTagEnd(text: string, tagStart: number): number {
  let quote = '';
  for (let index = tagStart; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index + 1;
  }
  return -1;
}

function templateBlockEnd(text: string, contentStart: number): number {
  templateTagPattern.lastIndex = contentStart;
  let depth = 1;
  for (let tag = templateTagPattern.exec(text); tag; tag = templateTagPattern.exec(text)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return tag.index;
  }
  return text.length;
}

function skipBlock(text: string, name: string, from: number): number {
  const closing = new RegExp(`</${name}\\s*>`, 'ig');
  closing.lastIndex = from;
  const match = closing.exec(text);
  return match ? match.index + match[0].length : -1;
}

/** The content of the top-level `<template>` block of a .vue file; undefined when absent or not HTML (`lang="pug"`). */
function vueTemplateRegion(text: string): TextRegion | undefined {
  let index = 0;
  while (index < text.length) {
    const tagStart = text.indexOf('<', index);
    if (tagStart === -1) return undefined;
    if (text.startsWith('<!--', tagStart)) {
      const commentEnd = text.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) return undefined;
      index = commentEnd + 3;
      continue;
    }
    const name = openingTagStartPattern.exec(text.slice(tagStart, tagStart + 64))?.[1];
    const tagEnd = name ? openingTagEnd(text, tagStart) : -1;
    if (!name || tagEnd === -1) {
      index = tagStart + 1;
      continue;
    }
    if (name.toLowerCase() === 'template') {
      const language = /\blang\s*=\s*["']?([\w-]+)/i.exec(text.slice(tagStart, tagEnd))?.[1];
      if (language && language.toLowerCase() !== 'html') return undefined;
      return { start: tagEnd, end: templateBlockEnd(text, tagEnd) };
    }
    if (text[tagEnd - 2] === '/') {
      index = tagEnd;
      continue;
    }
    const blockEnd = skipBlock(text, name, tagEnd);
    if (blockEnd === -1) return undefined;
    index = blockEnd;
  }
  return undefined;
}

function htmlDialect(file: string): TemplateDialect {
  return isAngularTemplate(file) ? 'angular' : 'html';
}

function markupDocument(file: string, text: string): MarkupDocument | undefined {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.svelte') return templateDocument(file, text, 'svelte');
  if (extension === '.vue') {
    const region = vueTemplateRegion(text);
    return region && templateDocument(file, text, 'vue', region.start, region.end);
  }
  if (extension === '.html' || extension === '.htm') return templateDocument(file, text, htmlDialect(file));
  return undefined;
}

/** The reason of a `<!-- loadwise-reviewed <rule-id> -- reason -->` comment on the finding's line or the line above. */
function reviewedMarkupReason(lines: readonly string[], finding: Finding): string | undefined {
  const lineIndex = (finding.line ?? 1) - 1;
  const sameLine = reviewCommentPattern.exec(lines[lineIndex] ?? '');
  const lineAbove = lines[lineIndex - 1]?.trim() ?? '';
  const above = lineAbove.startsWith('<!--') ? reviewCommentPattern.exec(lineAbove) : null;
  const match = [sameLine, above].find((candidate) => candidate?.[1] === finding.ruleId);
  return match ? `Reviewed in source: ${match[2]}` : undefined;
}

function withReviewedReasons(text: string, findings: Finding[]): Finding[] {
  if (!findings.length || !reviewMarkers.some((marker) => text.includes(marker))) return findings;
  const lines = text.split(/\r?\n/);
  return findings.map((finding) => {
    const reason = reviewedMarkupReason(lines, finding);
    return reason ? { ...finding, contextualReason: reason } : finding;
  });
}

function checkTemplateFile(file: string, text: string): Finding[] {
  if (isSkippedMarkup(file, text)) return [];
  const document = markupDocument(file, text);
  return document ? withReviewedReasons(text, checkMarkup(document)) : [];
}

export { checkTemplateFile };
