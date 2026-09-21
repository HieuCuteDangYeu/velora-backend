'use strict';

function isNewer(incomingDate, existingDate) {
  if (!existingDate) return true;
  if (!incomingDate) return false;

  const tIncoming = Date.parse(incomingDate);
  const tExisting = Date.parse(existingDate);

  if (!isNaN(tIncoming) && !isNaN(tExisting)) {
    return tIncoming > tExisting;
  }

  return incomingDate > existingDate;
}

function buildSeriesMap(episodes) {
  const seriesMap = new Map();
  if (!Array.isArray(episodes)) {
    return seriesMap;
  }

  const groupedBySlug = new Map();
  for (const ep of episodes) {
    if (!ep || !ep.seriesSlug) continue;
    const slug = ep.seriesSlug;
    if (!groupedBySlug.has(slug)) {
      groupedBySlug.set(slug, []);
    }
    groupedBySlug.get(slug).push(ep);
  }

  for (const [slug, group] of groupedBySlug.entries()) {
    let longestDescription = '';
    for (const ep of group) {
      if (ep.seriesDescription && ep.seriesDescription.length > longestDescription.length) {
        longestDescription = ep.seriesDescription;
      }
    }

    const episodeMap = new Map();
    for (const ep of group) {
      const epNum = Number.isFinite(Number(ep.episodeNumber)) ? Number(ep.episodeNumber) : ep.episodeNumber;
      const existing = episodeMap.get(epNum);
      if (!existing || isNewer(ep.lastModified, existing.lastModified)) {
        episodeMap.set(epNum, ep);
      }
    }

    const sortedEpisodes = Array.from(episodeMap.values()).sort((a, b) => {
      const numA = Number(a.episodeNumber);
      const numB = Number(b.episodeNumber);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return String(a.episodeNumber).localeCompare(String(b.episodeNumber));
    });

    let firstPublishedAt = '';
    let minPublishedTime = Infinity;

    let seriesLastModified = '';
    let maxModifiedTime = -Infinity;

    for (const ep of sortedEpisodes) {
      if (ep.publishedAt) {
        const pTime = Date.parse(ep.publishedAt);
        if (!isNaN(pTime)) {
          if (pTime < minPublishedTime) {
            minPublishedTime = pTime;
            firstPublishedAt = ep.publishedAt;
          }
        } else if (!firstPublishedAt || (minPublishedTime === Infinity && ep.publishedAt.localeCompare(firstPublishedAt) < 0)) {
          firstPublishedAt = ep.publishedAt;
        }
      }

      if (ep.lastModified) {
        const mTime = Date.parse(ep.lastModified);
        if (!isNaN(mTime)) {
          if (mTime > maxModifiedTime) {
            maxModifiedTime = mTime;
            seriesLastModified = ep.lastModified;
          }
        } else if (!seriesLastModified || (maxModifiedTime === -Infinity && ep.lastModified.localeCompare(seriesLastModified) > 0)) {
          seriesLastModified = ep.lastModified;
        }
      }
    }

    const firstEpisode = sortedEpisodes[0];
    const seriesTitle = (firstEpisode && firstEpisode.seriesTitle) || sortedEpisodes.find(e => e.seriesTitle)?.seriesTitle || '';
    const seriesPosterUrl = (firstEpisode && firstEpisode.posterUrl) || sortedEpisodes.find(e => e.posterUrl)?.posterUrl || '';

    const formattedEpisodes = sortedEpisodes.map((ep) => ({
      episodeNumber: Number.isFinite(Number(ep.episodeNumber)) ? Number(ep.episodeNumber) : ep.episodeNumber,
      episodeTitle: ep.episodeTitle,
      episodeDescription: ep.episodeDescription,
      posterUrl: ep.posterUrl,
      playerUrl: ep.playerUrl,
      publishedAt: ep.publishedAt,
      lastModified: ep.lastModified,
    }));

    const series = {
      slug,
      title: seriesTitle,
      description: longestDescription,
      posterUrl: seriesPosterUrl,
      episodeCount: formattedEpisodes.length,
      firstPublishedAt,
      lastModified: seriesLastModified,
      episodes: formattedEpisodes,
    };

    seriesMap.set(slug, series);
  }

  return seriesMap;
}

function toSortedSeriesArray(seriesMap) {
  if (!seriesMap) return [];

  const seriesArray = seriesMap instanceof Map
    ? Array.from(seriesMap.values())
    : Array.isArray(seriesMap)
      ? [...seriesMap]
      : Object.values(seriesMap);

  return seriesArray.sort((a, b) => {
    const titleA = a && a.title ? a.title : '';
    const titleB = b && b.title ? b.title : '';
    return titleA.localeCompare(titleB);
  });
}

module.exports = {
  buildSeriesMap,
  toSortedSeriesArray,
};
