// N+1 query shape: one pg query per list item (the most common Node perf fix commit pattern).
const { Pool } = require('pg');
const pool = new Pool();

module.exports = async function loadOrders(userIds) {
  const orders = [];
  for (const userId of userIds) {
    const result = await pool.query('SELECT * FROM orders WHERE user_id = $1', [userId]);
    orders.push(...result.rows);
  }
  return orders;
};
