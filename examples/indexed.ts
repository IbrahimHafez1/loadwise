type Order = { id: number; customerId: number };
type Customer = { id: number; name: string };

export function visibleNames(orders: Order[], customers: Customer[], request: { body: { allowed: number[] } }) {
  const allowedIds = new Set(request.body.allowed);
  const namesById = new Map<number, string>();
  for (const customer of customers) {
    // find() returns the first match. Strict numeric equality never matches NaN.
    if (!Number.isNaN(customer.id) && !namesById.has(customer.id)) {
      namesById.set(customer.id, customer.name);
    }
  }
  const labels: string[] = [];
  for (const order of orders) {
    if (allowedIds.has(order.customerId)) labels.push(namesById.get(order.customerId) ?? 'Unknown');
  }
  return labels;
}

