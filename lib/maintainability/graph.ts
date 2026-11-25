import path from 'node:path';
import type { ConstEnumExports, FolderBoundary, LocatedFinding, ModuleEdge } from './types/module-graph.js';

interface GraphEdge {
  from: number;
  to: number;
  line: number;
  column: number;
  nestForwardRef?: boolean;
}

interface BoundaryRule {
  from: string;
  disallow: string[];
}

interface GraphInput {
  files: readonly string[];
  edges: readonly ModuleEdge[];
  boundaries?: readonly FolderBoundary[];
  constEnums?: ConstEnumExports;
}

function directory(value: string): string {
  return path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '') || '.';
}

function within(file: string, folder: string): boolean {
  return folder === '.' || file === folder || file.startsWith(folder + '/');
}

// Kosaraju's two passes use explicit stacks so long import chains never consume the JS call stack.
function components(adjacency: GraphEdge[][], reverse: number[][]) {
  const count = adjacency.length;
  const visited = new Uint8Array(count);
  const finished: number[] = [];
  for (let start = 0; start < count; start++) {
    if (visited[start]) continue;
    const stack = [{ id: start, next: 0 }];
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
        stack.push({ id: target, next: 0 });
      }
    }
  }

  const component = new Int32Array(count).fill(-1);
  const sizes: number[] = [];
  for (let root = finished.pop(); root !== undefined; root = finished.pop()) {
    if (component[root] !== -1) continue;
    sizes.push(markComponent(root, sizes.length, reverse, component));
  }
  return { component, sizes };
}

function markComponent(root: number, index: number, reverse: number[][], component: Int32Array): number {
  const stack = [root];
  component[root] = index;
  let size = 0;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    size++;
    for (const previous of reverse[current]) {
      if (component[previous] !== -1) continue;
      component[previous] = index;
      stack.push(previous);
    }
  }
  return size;
}

function shortestCycle(
  start: number,
  singleton: boolean,
  adjacency: GraphEdge[][],
  component: Int32Array,
  incoming: (GraphEdge | undefined)[],
): GraphEdge[] {
  // One shortest real cycle through the first filename in this component.
  const queue = [start];
  const index = component[start];
  let last: GraphEdge | undefined;
  for (let head = 0; head < queue.length && !last; head++) {
    for (const edge of adjacency[queue[head]]) {
      if (component[edge.to] !== index || (!singleton && edge.from === edge.to)) continue;
      if (edge.to === start) {
        last = edge;
        break;
      }
      if (incoming[edge.to]) continue;
      incoming[edge.to] = edge;
      queue.push(edge.to);
    }
  }
  if (!last) return [];
  const cycle = [last];
  for (let edge = last; edge.from !== start;) {
    const previous = incoming[edge.from];
    if (!previous) break;
    cycle.push(previous);
    edge = previous;
  }
  return cycle.reverse();
}

function cycleDiagnostics(names: readonly string[], adjacency: GraphEdge[][], reverse: number[][]): LocatedFinding[] {
  const { component, sizes } = components(adjacency, reverse);
  const mixed = new Set<number>();
  markComponentsWithEagerEdges(adjacency, component, mixed);
  const reported = new Set<number>();
  // oxlint-disable-next-line unicorn/no-new-array -- The BFS table is indexed by numeric module ID.
  const incoming = new Array<GraphEdge | undefined>(names.length);
  const findings: LocatedFinding[] = [];
  for (let start = 0; start < names.length; start++) {
    const index = component[start];
    if (reported.has(index)) continue;
    reported.add(index);
    if (sizes[index] === 1 && !adjacency[start].some((edge) => edge.to === start)) continue;
    const cycle = shortestCycle(start, sizes[index] === 1, adjacency, component, incoming);
    const locations = cycle.map((edge) => ({ file: names[edge.from], line: edge.line, column: edge.column }));
    const route = [names[start], ...cycle.map((edge) => names[edge.to])].join(' → ');
    const finding: LocatedFinding = {
      ...locations[0],
      ruleId: 'dependency-cycle',
      message:
        'Dependency cycle: ' +
        route +
        '. Modules in a cycle cannot be loaded, tested or changed independently. Move the code both sides need into a new module that imports neither, or pass the value in as a parameter instead of importing it. A lazy `require()` only hides the cycle.',
      related: locations.slice(1),
    };
    if (sizes[index] > 1 && !mixed.has(index)) {
      finding.contextualReason =
        'Every internal dependency in this component is a Nest module imported solely for a forwardRef callback.';
    }
    findings.push(finding);
  }
  return findings;
}

function markComponentsWithEagerEdges(adjacency: GraphEdge[][], component: Int32Array, mixed: Set<number>): void {
  for (const neighbors of adjacency)
    for (const edge of neighbors) {
      if (!edge.nestForwardRef && component[edge.from] === component[edge.to]) mixed.add(component[edge.from]);
    }
}

// tsc inlines const enum members and drops an import that reads nothing else, so such an import
// cannot close a cycle.
function inlinedConstEnumImport(edge: ModuleEdge, constEnums: ConstEnumExports): boolean {
  const { constEnumNames } = edge;
  const exported = constEnumNames && constEnums.get(edge.to);
  if (!constEnumNames || !exported) return false;
  return constEnumNames.every((name) => exported.includes(name));
}

function checkGraph({ files, edges, boundaries = [], constEnums = new Map() }: GraphInput): LocatedFinding[] {
  const names = [...new Set(files)].sort();
  const ids = new Map(names.map((name, index) => [name, index]));
  const adjacency: GraphEdge[][] = names.map(() => []);
  const reverse: number[][] = names.map(() => []);
  const rules: BoundaryRule[] = boundaries.map((rule) => ({
    from: directory(rule.from),
    disallow: rule.disallow.map(directory),
  }));
  const restrictions = rules.length ? names.map((name) => rules.filter((rule) => within(name, rule.from))) : [];
  const findings: LocatedFinding[] = [];
  for (const edge of edges) {
    const from = ids.get(edge.from),
      to = ids.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (edge.kind !== 'deferred' && !inlinedConstEnumImport(edge, constEnums)) {
      adjacency[from].push({ from, to, line: edge.line, column: edge.column, nestForwardRef: edge.nestForwardRef });
      reverse[to].push(from);
    }
    if (restrictions[from]?.some((rule) => rule.disallow.some((folder: string) => within(edge.to, folder)))) {
      findings.push({
        file: edge.from,
        line: edge.line,
        column: edge.column,
        ruleId: 'folder-boundary',
        message:
          'Declared folder boundary prohibits this dependency on ' +
          edge.to +
          '. Importing across the boundary couples the layers the policy keeps apart. Remove the import and let a layer allowed to use both call them, passing the result in as an argument.',
      });
    }
  }
  for (const neighbors of adjacency)
    neighbors.sort((left, right) => left.to - right.to || left.line - right.line || left.column - right.column);
  for (const finding of cycleDiagnostics(names, adjacency, reverse)) findings.push(finding);
  return findings.sort(
    (left, right) =>
      (ids.get(left.file) ?? 0) - (ids.get(right.file) ?? 0) ||
      left.line - right.line ||
      left.column - right.column ||
      (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0),
  );
}

export { checkGraph };
