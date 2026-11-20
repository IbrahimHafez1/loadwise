'use strict';

const path = require('node:path');

function directory(value) {
  return path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '') || '.';
}

function within(file, folder) {
  return folder === '.' || file.startsWith(folder + '/');
}

// Kosaraju's two passes use explicit stacks so long import chains never consume the JS call stack.
function components(adjacency, reverse) {
  const count = adjacency.length;
  const visited = new Uint8Array(count);
  const finished = [];
  for (let start = 0; start < count; start++) {
    if (visited[start]) continue;
    const stack = [{id: start, next: 0}];
    visited[start] = 1;
    while (stack.length) {
      const current = stack[stack.length - 1];
      if (current.next === adjacency[current.id].length) {
        finished.push(current.id);
        stack.pop();
        continue;
      }
      const target = adjacency[current.id][current.next++].to;
      if (!visited[target]) {
        visited[target] = 1;
        stack.push({id: target, next: 0});
      }
    }
  }

  const component = new Int32Array(count).fill(-1);
  const sizes = [];
  while (finished.length) {
    const root = finished.pop();
    if (component[root] !== -1) continue;
    const index = sizes.length;
    const stack = [root];
    component[root] = index;
    let size = 0;
    while (stack.length) {
      const current = stack.pop();
      size++;
      for (const previous of reverse[current]) {
        if (component[previous] !== -1) continue;
        component[previous] = index;
        stack.push(previous);
      }
    }
    sizes.push(size);
  }
  return {component, sizes};
}

function cycleDiagnostics(names, adjacency, reverse) {
  const {component, sizes} = components(adjacency, reverse);
  const mixed = new Set();
  for (const neighbors of adjacency) for (const edge of neighbors) {
    if (!edge.nestForwardRef && component[edge.from] === component[edge.to]) mixed.add(component[edge.from]);
  }
  const reported = new Set();
  const incoming = new Array(names.length);
  const findings = [];
  for (let start = 0; start < names.length; start++) {
    const index = component[start];
    if (reported.has(index)) continue;
    reported.add(index);
    if (sizes[index] === 1 && !adjacency[start].some(edge => edge.to === start)) continue;
    // One shortest real cycle through the first filename in this component.
    const queue = [start];
    let last;
    for (let head = 0; head < queue.length && !last; head++) {
      for (const edge of adjacency[queue[head]]) {
        if (component[edge.to] !== index) continue;
        if (edge.to === start) {
          if (edge.from === start && sizes[index] !== 1) continue;
          last = edge;
          break;
        }
        if (incoming[edge.to]) continue;
        incoming[edge.to] = edge;
        queue.push(edge.to);
      }
    }
    const cycle = [last];
    while (cycle[cycle.length - 1].from !== start) cycle.push(incoming[cycle[cycle.length - 1].from]);
    cycle.reverse();
    const locations = cycle.map(edge => ({file: names[edge.from], line: edge.line, column: edge.column}));
    const route = [names[start], ...cycle.map(edge => names[edge.to])].join(' → ');
    const finding = {...locations[0], ruleId: 'dependency-cycle', message: 'Dependency cycle: ' + route,
      related: locations.slice(1)};
    if (sizes[index] > 1 && !mixed.has(index)) {
      finding.contextualReason = 'Every internal dependency in this component is a Nest module imported solely for a forwardRef callback.';
    }
    findings.push(finding);
  }
  return findings;
}

function checkGraph({files, edges, boundaries = []}) {
  const names = [...new Set(files)].sort();
  const ids = new Map(names.map((name, index) => [name, index]));
  const adjacency = names.map(() => []);
  const reverse = names.map(() => []);
  const rules = boundaries.map(rule => ({from: directory(rule.from), disallow: rule.disallow.map(directory)}));
  const restrictions = rules.length ? names.map(name => rules.filter(rule => within(name, rule.from))) : [];
  const findings = [];
  for (const edge of edges) {
    const from = ids.get(edge.from), to = ids.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (edge.kind !== 'deferred') {
      adjacency[from].push({from, to, line: edge.line, column: edge.column, nestForwardRef: edge.nestForwardRef});
      reverse[to].push(from);
    }
    if (restrictions[from]?.some(rule => rule.disallow.some(folder => within(edge.to, folder)))) {
      findings.push({file: edge.from, line: edge.line, column: edge.column, ruleId: 'folder-boundary',
        message: 'Declared folder boundary prohibits this dependency on ' + edge.to + '.'});
    }
  }
  for (const neighbors of adjacency) neighbors.sort((left, right) => left.to - right.to || left.line - right.line || left.column - right.column);
  for (const finding of cycleDiagnostics(names, adjacency, reverse)) findings.push(finding);
  return findings.sort((left, right) => ids.get(left.file) - ids.get(right.file) || left.line - right.line ||
    left.column - right.column || (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0));
}

module.exports = {checkGraph};
