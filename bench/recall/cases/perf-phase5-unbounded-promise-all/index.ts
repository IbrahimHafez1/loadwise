export async function hydrateProfiles(
  req: { body: { userIds: string[] } },
  fetchProfile: (id: string) => Promise<unknown>,
) {
  return Promise.all(req.body.userIds.map((id) => fetchProfile(id)));
}
