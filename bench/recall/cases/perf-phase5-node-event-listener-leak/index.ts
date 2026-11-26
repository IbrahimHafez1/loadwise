declare const app: {
  get: (path: string, handler: (req: unknown, res: { write: (chunk: string) => void }) => void) => void;
};
declare const eventBus: { on: (event: string, fn: () => void) => void };

app.get('/events', (_req, res) => {
  eventBus.on('update', () => res.write('data: update\n\n'));
});
