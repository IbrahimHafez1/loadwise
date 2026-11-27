type Order = { id: number; customerId: number };
type Customer = { id: number; name: string };

export function visibleNames(orders: Order[], customers: Customer[], request: { body: { allowed: number[] } }) {
  const allowed = request.body.allowed;
  const visible = orders.filter(order => allowed.includes(order.customerId));
  const names = visible.map(order => customers.find(customer => customer.id === order.customerId)?.name ?? 'Unknown');
  return names.reduce<string[]>((labels, name) => [...labels, name], []);
}

