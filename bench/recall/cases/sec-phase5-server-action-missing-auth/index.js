'use server';

export async function deleteAccount(userId) {
  return { deleted: userId };
}
