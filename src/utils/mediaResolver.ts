// src/utils/mediaResolver.ts

import { prisma } from "../lib/prisma";

export async function resolveServiceMedia(
  services: any[]
) {

  const ids = new Set<string>();

  services.forEach((s) => {

    if (s.iconUrl) ids.add(s.iconUrl);
    if (s.coverUrl) ids.add(s.coverUrl);

    s.gallery?.forEach((g: any) => {
      if (g.mediaId) ids.add(g.mediaId);
    });

  });

  if (!ids.size) return services;

  const medias = await prisma.media.findMany({
    where: {
      id: { in: [...ids] },
    },
    select: {
      id: true,
      url: true,
    },
  });

  const mediaMap = Object.fromEntries(
    medias.map((m) => [m.id, m.url])
  );

  //////////////////////////////////////////////////////
  // ✅ DO NOT REPLACE IDS
  //////////////////////////////////////////////////////

  return services.map((s) => ({

    ...s,

    //////////////////////////////////////
    // ICON
    //////////////////////////////////////
    icon: s.iconUrl
      ? {
          id: s.iconUrl,
          url: mediaMap[s.iconUrl] ?? null,
        }
      : null,

    //////////////////////////////////////
    // COVER
    //////////////////////////////////////
    cover: s.coverUrl
      ? {
          id: s.coverUrl,
          url: mediaMap[s.coverUrl] ?? null,
        }
      : null,

    //////////////////////////////////////
    // GALLERY
    //////////////////////////////////////
    gallery:
      s.gallery?.map((g: any) => ({
        mediaId: g.mediaId,
        url:
          mediaMap[g.mediaId] ?? null,
      })) ?? [],
  }));
}