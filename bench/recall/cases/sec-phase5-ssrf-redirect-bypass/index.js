app.get('/proxy', async (req, res) => {
  return fetch(req.query.url);
});
