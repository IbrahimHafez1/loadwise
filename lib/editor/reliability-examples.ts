// Generic fix examples for the reliability rules the shared source pass reports outside the performance examples.
// The moved performance rules keep their examples in performance-examples.cts, which exampleFor consults first.
import { exampleFor as performanceExample } from './performance-examples.js';
import type { FixExample } from './types/fix-example.js';

const examples: Record<string, { before: string; code: string; note: string }> = {
  'swallowed-error': {
    before: 'try {\n  await saveOrder(order);\n} catch {}\nnotifyCustomer(order);',
    code: 'try {\n  await saveOrder(order);\n} catch (error) {\n  throw new OrderNotSavedError(order.id, { cause: error });\n}',
    note: 'Handle, rethrow or report the error so the code after the try does not run as if it succeeded.',
  },
  'sql-insert-truncated-at-semicolon': {
    before:
      'const inserts = /INSERT INTO orders VALUES ([\\s\\S]*?);/gi;\nwhile ((match = inserts.exec(dump)) !== null) {\n  const values = match[1]; // stops inside a quoted semicolon\n}',
    code: '// Use your SQL dialect parser to read complete statements and literal values.\nfor (const insert of readInsertStatements(dump)) {\n  importRows(insert.rows);\n}',
    note: 'A semicolon inside a quoted value ends the regular expression match early and drops the rest of the row.',
  },
  'unguarded-boundary-access': {
    before: 'const email = req.body.user.email;',
    code: 'const email = req.body.user?.email;',
    note: 'The read now yields undefined instead of throwing when user is missing. Add `?? default` or answer with a 400 when the input is required.',
  },
  'assignment-in-condition': {
    before: 'if (user.role = "admin") {\n  grantAccess(user);\n}',
    code: 'if (user.role === "admin") {\n  grantAccess(user);\n}',
    note: 'Assigns instead of comparing; review that no later code needs the assigned value.',
  },
  'nan-comparison': {
    before: 'if (value === NaN) {\n  value = 0;\n}',
    code: 'if (Number.isNaN(value)) {\n  value = 0;\n}',
    note: 'NaN is never equal to anything, itself included.',
  },
  'invalid-typeof-comparison': {
    before: 'if (typeof value === "strnig") {\n  value = value.trim();\n}',
    code: 'if (typeof value === "string") {\n  value = value.trim();\n}',
    note: "'strnig' looks like a misspelling of 'string', so the branch never ran.",
  },
  'unreachable-code': {
    before: 'function total(items) {\n  return sum(items);\n  cleanup();\n}',
    code: 'function total(items) {\n  return sum(items);\n}',
    note: 'The statements after the exit are deleted; review that nothing there was needed.',
  },
  'switch-not-exhaustive': {
    before: 'switch (status) {\n  case "paid": return 1;\n  case "open": return 2;\n}',
    code: 'switch (status) {\n  case "paid": return 1;\n  case "open": return 2;\n  default: throw new Error(status);\n}',
    note: 'Add the missing cases, or a default that throws so a new member cannot fall through unnoticed.',
  },
  'pool-without-connection-timeout': {
    before: 'const pool = new Pool({ connectionString });',
    code: 'const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });',
    note: 'The default of 0 waits forever for a connection; pick a timeout that suits your slowest healthy checkout.',
  },
  'uncaught-exception-continues': {
    before: "process.on('uncaughtException', (error) => {\n  logger.error(error);\n});",
    code: "process.on('uncaughtException', (error) => {\n  logger.error(error);\n  logger.flush(() => process.exit(1));\n});",
    note: 'The process is in an unknown state after an uncaught exception; flush logs, then exit non-zero.',
  },
  'loop-index-past-length': {
    before: 'for (let i = 0; i <= items.length; i++) {\n  use(items[i]);\n}',
    code: 'for (let i = 0; i < items.length; i++) {\n  use(items[i]);\n}',
    note: 'Valid indexes stop at length - 1.',
  },
  'file-handle-not-closed': {
    before: 'const handle = await open(path);\nawait handle.stat();\nawait handle.close();',
    code: 'const handle = await open(path);\ntry {\n  await handle.stat();\n} finally {\n  await handle.close();\n}',
    note: 'An error before close() leaks the file descriptor.',
  },
  'query-runner-not-released': {
    before: 'const runner = dataSource.createQueryRunner();\nawait runner.connect();',
    code: 'const runner = dataSource.createQueryRunner();\ntry {\n  await runner.connect();\n} finally {\n  await runner.release();\n}',
    note: 'An unreleased runner holds a pooled connection.',
  },
  'browser-not-closed': {
    before: 'const browser = await chromium.launch();\nawait run(browser);\nawait browser.close();',
    code: 'const browser = await chromium.launch();\ntry {\n  await run(browser);\n} finally {\n  await browser.close();\n}',
    note: 'A failed run leaves the browser process running.',
  },
  'interval-not-cleared': {
    before: 'function start() {\n  setInterval(poll, 1000);\n}',
    code: 'function start() {\n  const timer = setInterval(poll, 1000);\n  return () => clearInterval(timer);\n}',
    note: 'Keep the handle so the owner can stop the timer.',
  },
  'child-process-without-error-listener': {
    before: "const child = spawn('convert', [input, output]);",
    code: "const child = spawn('convert', [input, output]);\nchild.on('error', (error) => {\n  logger.error({ err: error }, 'convert failed to start');\n});",
    note: "Without an 'error' listener a failed spawn throws an uncaught exception and crashes the process.",
  },
  'error-rethrown-without-cause': {
    before: "try {\n  await saveOrder(order);\n} catch (error) {\n  throw new Error('Order not saved');\n}",
    code: "try {\n  await saveOrder(order);\n} catch (error) {\n  throw new Error('Order not saved', { cause: error });\n}",
    note: 'The cause keeps the original message and stack reachable.',
  },
  'throw-non-error': {
    before: "throw 'order not found';",
    code: "throw new Error('order not found');",
    note: 'An Error carries a stack trace; a thrown string or object does not.',
  },
  'error-logged-without-stack': {
    before: 'try {\n  await sync();\n} catch (error) {\n  logger.error(error.message);\n}',
    code: "try {\n  await sync();\n} catch (error) {\n  logger.error({ err: error }, 'sync failed');\n}",
    note: 'Pass the error itself so the logger records the stack.',
  },
  'react-effect-sets-state-every-render': {
    before: 'useEffect(() => {\n  setItems([...items, next]);\n});',
    code: 'useEffect(() => {\n  setItems((previous) => [...previous, next]);\n}, [next]);',
    note: 'Without a dependency array the effect runs after every render, and each run renders again. Keep `next` stable (a primitive or memoised value) or the loop continues.',
  },
  'react-async-effect-callback': {
    before: 'useEffect(async () => {\n  await load();\n}, []);',
    code: 'useEffect(() => {\n  load().catch(reportError);\n}, []);',
    note: 'The effect callback must return nothing or a cleanup function, not a promise.',
  },
  'react-state-mutated-in-place': {
    before: 'items.push(item);\nsetItems(items);',
    code: 'setItems([...items, item]);',
    note: 'React skips the render when the setter receives the same reference.',
  },
  'react-list-missing-key': {
    before: 'rows.map((row) => <li>{row.name}</li>)',
    code: 'rows.map((row) => <li key={row.id}>{row.name}</li>)',
    note: 'A stable key lets React match items between renders.',
  },
  'next-server-env-in-client': {
    before: "'use client';\nconst url = process.env.API_URL;",
    code: "'use client';\nconst url = process.env.NEXT_PUBLIC_API_URL;",
    note: 'Next.js only inlines NEXT_PUBLIC_ variables into the browser bundle.',
  },
};

const scriptLanguages = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];

function exampleFor(ruleId: string, languageId: string, message = ''): FixExample | undefined {
  if (!Object.hasOwn(examples, ruleId)) return performanceExample(ruleId, languageId, message);
  if (!scriptLanguages.includes(languageId)) return;
  const { before, code, note } = examples[ruleId];
  return { language: languageId.startsWith('typescript') ? 'typescript' : 'javascript', before, code, note };
}

export { exampleFor };
