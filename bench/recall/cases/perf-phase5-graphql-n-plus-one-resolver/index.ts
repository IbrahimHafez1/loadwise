export const resolvers = {
  Order: {
    items: async (
      order: { id: string },
      _args: unknown,
      ctx: { db: { item: { findMany: (q: unknown) => Promise<unknown[]> } } },
    ) => {
      return ctx.db.item.findMany({ where: { orderId: order.id } });
    },
  },
};
