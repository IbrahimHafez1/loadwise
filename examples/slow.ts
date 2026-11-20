type Order = { id: number; customerId: number };
type Customer = { id: number; name: string };

export function visibleNames(orders: Order[], customers: Customer[], allowed: number[]) {
  const visible = orders.filter(order => allowed.includes(order.customerId));
  const names = visible.map(order => customers.find(customer => customer.id === order.customerId)?.name ?? 'Unknown');
  return names.reduce<string[]>((labels, name) => [...labels, name], []);
}

