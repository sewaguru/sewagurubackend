import { prisma } from "../lib/prisma";

type MediaFields = {
  iconUrl?: string | null;
  coverUrl?: string | null;
};

export async function resolveNodeMedia<T extends MediaFields>(
  items: T[]
): Promise<T[]> {

  const ids = new Set<string>();

  items.forEach(i => {
    if (i.iconUrl) ids.add(i.iconUrl);
    if (i.coverUrl) ids.add(i.coverUrl);
  });

  if (!ids.size) return items;

  const medias = await prisma.media.findMany({
    where: {
      id: { in: [...ids] },
    },
    select: {
      id: true,
      url: true,
    },
  });

  const map = Object.fromEntries(
    medias.map(m => [m.id, m.url])
  );

  return items.map(i => ({
    ...i,
    iconUrl: i.iconUrl
      ? map[i.iconUrl] ?? null
      : null,
    coverUrl: i.coverUrl
      ? map[i.coverUrl] ?? null
      : null,
  }));
}